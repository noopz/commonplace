/**
 * commonplace function-hooks module — ambient connection surfacing.
 *
 * EARLY ACCESS. Loads only when CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1; without
 * the flag this file is inert and the shell hooks in hooks.json are the whole
 * plugin. See the vault's handbook note on building on Claude Code function
 * hooks for the API's verified constraints and the migration checklist.
 *
 * WHAT THIS DOES
 * The vault's most-wanted behaviour — "tell me when something I'm discussing
 * connects to something I already wrote" — has until now been prompt text
 * asking the model to remember to look. It fired unreliably because nothing
 * enforced it. This hook makes it a mechanism: at the end of every turn, check
 * whether the answer touches vault material, and if it genuinely does, render
 * one line beneath the answer. The model is not asked to do anything.
 *
 * DOCTRINE (see CLAUDE.md, "No RAG — grep finds, reading connects")
 * Both seed tiers are JUMPING-OFF POINTS, never the answer. A candidate is only
 * surfaced after the note itself is read and a model call judges the connection
 * real. Neither token overlap nor a PPR score ever reaches the user alone.
 *
 * Seeding is two-tiered. The free lexical pass over the indexes can only reach
 * notes sharing a literal token with the answer; when it comes up empty, a PPR
 * walk over the content graph (`commonplace connect`) can reach a note sharing
 * none — the motivating example in CLAUDE.md, which was unreachable here until
 * v1.61.0. This is still a cheap ambient layer, not a replacement for
 * wiki-query, which does the iterative search this deliberately does not.
 *
 * COST
 * Turns that fail the free in-module prefilter cost nothing. A turn that passes
 * costs one classify (~700ms); if that says technical-substance, a lexical seed
 * (free) or, on a miss, a graph walk (~400ms), then one read (~2ms) and one
 * completion (~900ms). All of it runs AFTER the answer is on screen, so none of
 * it is on the user's critical path. Rate-limited and circuit-broken below.
 *
 * SCANNER CONSTRAINTS
 * The static scanner requires `register` to be a top-level const function, `on`
 * to take string-literal event names, and `$` to appear only as `$.noun.verb()`
 * at a call site — never bound, spread, stored or returned. It MAY be passed to
 * a function declared in THIS file (see `ensureVaultPath`), but never across an
 * import, so helpers in `lib/` take plain values or a Ports object of arrows.
 */

import { atom, read, update } from "claude-code";
import type { Register, EngineInterface, ToolCallInput } from "claude-code";
import type { CommonplaceBand, Commonplace, CommonplaceIndexStatus } from "../types/index.js";
import { parseJsonl, stripFrontmatter } from "./lib/seed.ts";
import { runConnectionPass, type CompletionRequest } from "./lib/pipeline.ts";
import { statusLine, type Status } from "./lib/status.ts";
import { buildVaultBlock, mergeBlocks } from "./lib/context.ts";
import { checkBashCommand, checkScopeEscalation, checkRevisionStep, withOpenShards, ownCommand, unitEnv, chainedCommit, CHAINED_COMMIT_DENY, parseSealedNames, type SealedName } from "./lib/guard.ts";
import { checkSealedAccess, candidatePaths, normalizePath } from "./lib/core/seal.ts";
import { openFromStartCwd, type DomainMap } from "./lib/core/scope.ts";
import {
  sealRootsFor,
  sanitizeWrite,
  leakVerdict,
  locate,
  namesFromLegacy,
  PRIVATE_VAULT_SHARD,
  type GuardVault,
} from "./lib/core/vault-guard.ts";
import {
  looksVaultShaped,
  isSteerableSpawn,
  steerPrompt,
  SPAWN_LABELS,
  SPAWN_CLASSIFY_PROMPT,
} from "./lib/agent.ts";
import { isSafeVaultPath } from "./lib/tools.ts";
import { TOOL_SPECS, PINNED_TOOLS } from "./lib/tools/specs.ts";
import {
  formatSearch,
  formatNote,
  formatLinks,
  formatPath,
  formatNeighbourhood,
  formatList,
  formatLineage,
  type LineageRow,
  unreadContext,
  statusOnly,
} from "./lib/tools/format.ts";
import * as noun from "./lib/core/noun.ts";
import { connectPool } from "./lib/core/connect.ts";
import { RANK_LINEAR } from "./lib/index/postings.ts";
import { VaultIndex, type IndexPorts } from "./lib/index/load.ts";
import { parseNote as parseIndexNote } from "./lib/index/parse.ts";
import { journalNote } from "./lib/index/journal.ts";
import { shardFor } from "./lib/index/model.ts";
import { isExcluded, findNotesArgv } from "./lib/index/exclude.ts";
import { visibleSkills, skillBlock, sha256Hex, type VaultSkill, type SkillFile } from "./lib/skills/load.ts";
import {
  PRIME_JUDGE_SYSTEM,
  PRIME_JUDGE_PROMPT,
  PRIME_NOTE_CHARS,
  PRIME_JUDGE_TIMEOUT_MS,
  parsePrimeVerdict,
  promptTokens,
  segmentShift,
  remember,
  freshSegment,
  pickPrimeCandidate,
  primeBlock,
  type SegmentState,
} from "./lib/core/prime.ts";
import { resolveOpenRef, listableDomains, shardOfDomain, proposeFromPrompt, isPrivate as isPrivateDomain } from "./lib/core/scope.ts";
import { maskSealed } from "./lib/core/noun.ts";
import { wikiRefs, linkWikiRefs, fileHref, citationFooter, citationCounts, type CitedNote } from "./lib/surfaces/wikilinks.ts";
import { pastedUrls, sameUrl, triagePrompt, parseTriage, triageLine, addLater, formatLater, TRIAGE_NOTE_CHARS, type Triage, type LaterItem } from "./lib/surfaces/triage.ts";
import { Witness, renderWitness } from "./lib/surfaces/witness.ts";
import { EXPLAIN_PAGES, liveSvg, liveBars, type LiveCounts } from "./lib/explain/diagrams.ts";
import { runTrigger, type TriggerPorts, type Pair } from "./lib/revision/trigger.ts";
import { runSteps, type RunnerPorts } from "./lib/revision/runner.ts";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** The durable trace log, under the vault's `.wiki/`. */
const LOG_FILE = "hook-log.jsonl";

/** Minimum engine release this module is written against (probe-verified API). */
const MIN_BUILD = "2.1.288";

/** Compare dotted release strings numerically: "2.1.300" > "2.1.288". */
const releaseAtLeast = (have: string, want: string): boolean => {
  const h = have.split(/[.-]/).map((x) => Number(x) || 0);
  const w = want.split(".").map(Number);
  for (let i = 0; i < w.length; i++) {
    if ((h[i] ?? 0) !== w[i]) return (h[i] ?? 0) > w[i];
  }
  return true;
};

/**
 * Lines kept when the log is rotated at session start.
 *
 * Sized to be readable, not to be complete: this file answers "what did the
 * last few sessions decide, and why", and a question that needs more history
 * than this wants a real analysis pass over a copy, not a bigger tail.
 */
const LOG_KEEP_LINES = 2000;

/**
 * Resolved vault path per project dir, for the life of the resident worker.
 *
 * This used to live in `$.store` with a negative-cache timestamp, because
 * resolving cost a 7.3s Bash-tool round trip that nobody wanted to repeat.
 * `$.process.run` does the same resolve in ~46ms, so the elaborate caching is
 * gone; a plain module-scope map is enough. Keyed by project dir because the
 * registry supports several vaults and cwd can change within a session.
 */
const vaultPaths = new Map<string, string>();

/**
 * The directory the session STARTED in — the only signal that opens a private
 * domain (see `openPrivateDomains`). Captured from `session.start`'s input
 * rather than read live: a `cd` during the session is the model's to make, so
 * it must not unlock anything. A reload re-runs `session.start`, which
 * re-captures it; the `$.session.root()` fallback covers a hook racing it.
 */
let startCwd = "";

/**
 * The band's live state, held by the host in `$.state` rather than in module
 * scope: a hot reload re-instantiates module scope, and a band drawn from a
 * module variable came back blank mid-session. Reading it inside the render
 * hook subscribes that drawing, so a write redraws exactly the band and
 * nothing calls `$.ui.invalidate` for it. Declared in `types/index.d.ts`.
 * See lib/status.ts for what each field means.
 */
const BAND_INITIAL: CommonplaceBand = {
  phase: "idle",
  sources: 0,
  concepts: 0,
  surfaced: 0,
  lastOutcome: "",
  paused: false,
  visible: false,
};
const band = atom({ plugin: "commonplace", key: "band" } as const, BAND_INITIAL);

/**
 * The breaker's last error text, kept OUT of `$.state` on purpose: every
 * plugin can read state, and an exception's text can carry a note path. A
 * reload loses it, which costs only the detail after the band's dash.
 */
let lastError = "";

/**
 * One argument of a tool call, read loosely.
 *
 * `tool.call`'s `e` is a union discriminated by `tool`; a registered tool's
 * name (`mcp__commonplace__vault_search`) is not a literal the union knows,
 * so its arguments are reached through the MCP fallback's index signature.
 */
const toolArg = (e: ToolCallInput, key: string): unknown =>
  (e as Readonly<Record<string, unknown>>)[key];


/**
 * OPEN SHARDS — the scope truth, per vault path (plan §4.1).
 *
 * Module memory only, never `$.state` or `$.store`: another plugin can read
 * state, and a store survives the session. A reload re-instantiates module
 * scope, which re-seals everything; that is the intended failure direction.
 * Seeded from the session-START cwd (signal 1) the first time a vault is
 * loaded; `/vault open` (Phase 2) adds to it; `/clear` empties it.
 */
const openShards = new Map<string, Set<string>>();

/**
 * Set by `session.end{reason:"clear"}`: the process goes on under a new
 * session id with no `session.start`, so the start-cwd signal must not
 * silently re-open what `/clear` sealed. Cleared at the next session.start.
 */
let sealedByClear = false;

/** `$HOME`, read once per module load; `null` until the guard first needs it. */
let homeDir: string | null = null;

/** Registered vaults + their domains + every private title, for the guard. */
let guardCache: { at: number; vaults: GuardVault[]; names: SealedName[] } | null = null;

/** Registry and names change rarely; a minute bounds staleness. */
const GUARD_TTL_MS = 60_000;

const openOf = (vaultPath: string): ReadonlySet<string> => openShards.get(vaultPath) ?? new Set<string>();

/** Read an absolute path: `$.fs.read` (P1: works outside the project), `cat` as the fallback. */
const readAbs = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    return String(await $.fs.read(path));
  } catch {
    try {
      const r = await $.process.run(["cat", path]);
      return r.exitCode === 0 ? String(r.stdout ?? "") : "";
    } catch {
      return "";
    }
  }
};

/**
 * Load every registered vault for the guard, memoised for GUARD_TTL_MS.
 *
 * Lazy as well as warmed at session.start: a reload empties module scope
 * without (always) re-firing session.start. Private titles come from
 * `.wiki/sealed/names.json` (written by `commonplace index`); a vault whose
 * index predates it falls back to the v1 jsonl records.
 */
const loadGuard = async ($: EngineInterface): Promise<{ vaults: GuardVault[]; names: SealedName[] }> => {
  const now = await $.clock.now();
  if (guardCache && now - guardCache.at < GUARD_TTL_MS) return guardCache;
  // Stale but present: answer from it and refresh behind the call, so a
  // guarded tool call never waits on the registry CLI after the first load.
  if (guardCache) {
    if (!guardRefreshing) {
      guardRefreshing = true;
      buildGuard($, now)
        .catch(() => {})
        .finally(() => {
          guardRefreshing = false;
        });
    }
    return guardCache;
  }
  return buildGuard($, now);
};

let guardRefreshing = false;

const buildGuard = async ($: EngineInterface, now: number): Promise<{ vaults: GuardVault[]; names: SealedName[] }> => {
  const res = await $.process.run(["node", `${$.plugin.root}/bin/commonplace`, "vaults", "--json"]);
  let entries: { path?: unknown; id?: unknown; label?: unknown; aliases?: unknown; isPrivate?: unknown }[] = [];
  let registryOk = res.exitCode === 0;
  try {
    entries = JSON.parse(String(res.stdout ?? "") || "{}")?.matches ?? [];
  } catch {
    entries = [];
    registryOk = false;
  }
  // `vaults` is a script spawn and can fail (an old Node, a broken install). An
  // empty registry turns every guard off, so fall back to the default vault
  // from `vault-path`, a bin built-in that runs no script.
  if (!registryOk) {
    try {
      const vp = (await $.process.run(["node", `${$.plugin.root}/bin/commonplace`, "vault-path"])).stdout.trim();
      if (vp) entries = [{ path: vp }];
    } catch {
      /* no vault at all */
    }
  }
  const vaults: GuardVault[] = [];
  const names: SealedName[] = [];
  for (const entry of entries) {
    const path = normalizePath(String(entry?.path ?? ""), "/");
    if (path === "/") continue;
    let domains: DomainMap = {};
    try {
      domains = JSON.parse((await readAbs($, `${path}/.wiki/domains.json`)) || "{}")?.domains ?? {};
    } catch {
      domains = {};
    }
    let real: string | undefined;
    try {
      const st = await $.fs.stat(path, { resolve: true });
      if (st.realPath && normalizePath(st.realPath, "/") !== path) real = normalizePath(st.realPath, "/");
    } catch {
      /* lexical spelling only */
    }
    vaults.push({
      path,
      real,
      domains,
      id: typeof entry.id === "string" ? entry.id : undefined,
      label: typeof entry.label === "string" ? entry.label : undefined,
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String) : [],
      isPrivate: entry.isPrivate === true,
    });
    if (!openShards.has(path)) {
      openShards.set(path, sealedByClear ? new Set() : openFromStartCwd(domains, path, startCwd));
    }
    // A vault registered `isPrivate` keeps ALL of its titles out of code
    // repos and other vaults (plan §6.5), not only its private domains'. They
    // ride the leak guard under a shard nothing can open — and are excluded
    // from masking inside the vault itself (`isOwnMask`).
    if (entry.isPrivate === true) {
      for (const line of String((await readAbs($, `${path}/.wiki/graph/files.jsonl`)) ?? "").split("\n")) {
        const m = /"p":"((?:[^"\\]|\\.)*)"/.exec(line);
        if (!m) continue;
        const stem = (JSON.parse(`"${m[1]}"`) as string).split("/").pop()!.replace(/\.md$/, "");
        if (stem) names.push({ t: stem, al: [], shard: PRIVATE_VAULT_SHARD, vault: path });
      }
    }
    const sealedNames = await readAbs($, `${path}/.wiki/sealed/names.json`);
    if (sealedNames) {
      names.push(...parseSealedNames(sealedNames, path));
    } else {
      const legacy = [
        ...parseJsonl(await readAbs($, `${path}/.wiki/concept-index.jsonl`)),
        ...parseJsonl(await readAbs($, `${path}/.wiki/source-index.jsonl`)),
      ];
      names.push(...namesFromLegacy(legacy, domains, path));
    }
  }
  // A degraded read is used for this call but not cached: the next call
  // retries the registry instead of holding the fallback for GUARD_TTL_MS.
  // A failed REFRESH keeps the last good load instead: the CLI vanishing
  // mid-session (an update pruning this version's folder) used to drop the
  // guard to zero vaults, and zero vaults switches sealing off.
  const built = { at: now, vaults, names };
  if (registryOk) guardCache = built;
  else if (guardCache) return guardCache;
  return built;
};

/**
 * The status line names the active vault only when more than one is
 * registered (§9.2); otherwise it is cleared. Always written, never assumed:
 * the line is ENGINE state that survives reloads and sessions, so a stale one
 * from an earlier build must be overwritten rather than trusted to be absent.
 */
const showVaultStatus = async ($: EngineInterface) => {
  try {
    const { vaults } = await loadGuard($);
    const active = vaults.length > 1 ? await pickVault($) : null;
    await $.ui.status(active ? `⟡ ${active.id ?? active.label ?? active.path.split("/").pop()}` : undefined);
  } catch {
    /* no surface to pin to */
  }
};

/** Append one trace line to a vault's hook-log; never awaited, never throws. */
const traceTo = ($: EngineInterface, vaultPath: string, stage: string, detail: Record<string, unknown>) => {
  if (!vaultPath) return;
  $.process.run(["tee", "-a", `${vaultPath}/.wiki/${LOG_FILE}`], {
    stdin: `${JSON.stringify({ at: new Date().toISOString(), stage, ...detail })}\n`,
  }).catch(() => {});
};

/**
 * Resolve the vault for a project dir, memoised.
 *
 * MUST be lazy, not just eager. `session.start` populating the map at session
 * start is not enough: a module reload (every edit, under `--plugin-dir`)
 * re-instantiates module scope but does NOT re-fire `session.start`, so the
 * map comes back empty mid-session and every hook reading it silently does
 * nothing — no outcome log, no context block, an inert leak guard, no spawn
 * steering. That is exactly the failure shape this branch keeps producing:
 * working code that stops doing anything without ever reporting an error.
 *
 * Taking `$` as a parameter is legal — the scanner follows it into a function
 * declared in THIS file, just never across an import into `lib/`.
 *
 * A miss is cached for VAULT_MISS_TTL_MS only (see vaultMisses).
 */
const ensureVaultPath = async ($: EngineInterface, projectDir: string): Promise<string> => {
  const known = vaultPaths.get(projectDir);
  if (known) return known;
  const now = Date.now();
  if (now - (vaultMisses.get(projectDir) ?? 0) < VAULT_MISS_TTL_MS) return "";
  try {
    const res = await $.process.run([
      "node", `${$.plugin.root}/bin/commonplace`, "vault-path",
    ]);
    const resolved = res.stdout.trim();
    if (resolved) vaultPaths.set(projectDir, resolved);
    else vaultMisses.set(projectDir, now);
    return resolved;
  } catch {
    return "";
  }
};

/**
 * A miss is remembered briefly, not forever. Uncached, an install with no
 * vault spawned `node vault-path` (~25 ms) on every Bash call, prompt and
 * turn; cached forever, it would hide a `commonplace init` until restart.
 */
const vaultMisses = new Map<string, number>();
const VAULT_MISS_TTL_MS = 60_000;


// ---------------------------------------------------------------------------
// The v2 index: one VaultIndex per vault path, module memory (plan §6.4)
// ---------------------------------------------------------------------------

/**
 * Loaded graphs, per vault path. Module memory: a reload empties it and the
 * next call reloads lazily (≈1 ms at 1×, 8–10 ms at 50×, P0).
 */
const indexes = new Map<string, VaultIndex>();

/** When a background `commonplace index` was last started, per vault. */
const buildStarted = new Map<string, number>();
/** The running build per vault, so a vault tool can wait for it instead of erroring. */
const building = new Map<string, Promise<boolean>>();
/** How long a vault tool waits for a first build before giving up on this call. */
const BUILD_WAIT_MS = 30_000;
const BUILD_COOLDOWN_MS = 60_000;

/**
 * The current unit of work per agent (main loop = "main"): the vault writes a
 * `commonplace commit` will commit together. Created on the first vault write,
 * rotated once a commit succeeds (scripts/lib/git-unit.ts).
 */
const units = new Map<string, { id: string; actor: string; session: string }>();
const agentKey = (agentId: string | undefined) => (agentId ? agentId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 24) : "main");
/** Each subagent's type (`commonplace:wiki-linter`, `general-purpose`, …), by id. */
const agentTypes = new Map<string, string>();
async function agentTypeOf($: EngineInterface, agentId: string | undefined): Promise<string> {
  if (!agentId) return "main";
  let t = agentTypes.get(agentId);
  if (!t) {
    try {
      t = (await $.agent.list()).find((a) => a.id === agentId)?.type;
    } catch {}
    t = t || "subagent";
    agentTypes.set(agentId, t);
  }
  return t;
}

async function unitFor($: EngineInterface, agentId: string | undefined, vp?: string) {
  const key = agentKey(agentId);
  let u = units.get(key);
  if (!u) {
    const session = String(await $.session.id()).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 12) || "s";
    const actor = (await agentTypeOf($, agentId)).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60);
    const prefix = `${session}-${key}-`.replace(/[^A-Za-z0-9._-]/g, "_");
    u = { id: (vp && (await openUnitOnDisk($, vp, prefix))) || `${prefix}${Date.now().toString(36)}`, actor, session };
    units.set(key, u);
  }
  return u;
}

/**
 * The newest uncommitted unit this session and agent left in `.wiki/units/`.
 * Module memory does not survive a reload, the unit file does: without this a
 * reload mid-unit would strand the files already written under the old id.
 */
async function openUnitOnDisk($: EngineInterface, vp: string, prefix: string): Promise<string | null> {
  try {
    const r = await $.process.run(["ls", "-t", `${vp}/.wiki/units`]);
    for (const f of String(r.stdout ?? "").split("\n")) {
      if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
      const unit = JSON.parse(String(await $.fs.read(`${vp}/.wiki/units/${f}`))) as { id?: unknown; commit?: unknown };
      return !unit.commit && typeof unit.id === "string" ? unit.id : null;
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Vault revision (docs/revision-design.md): the trigger's inputs, the runner,
// and the activity log that notices open. The decisions live in
// hooks/lib/revision/* and the `commonplace revise` CLI; this is the adapter.
// ---------------------------------------------------------------------------

/**
 * What each agent's unit of work wrote and read in each vault, waiting for
 * that agent's turn to end. Reads count only when the whole note was read
 * (a Read without offset/limit, or vault_note) — a slice is not the note.
 */
/** `reads`: path → the version read (`sha256:` of the file text, as the CLI's `noteRev`). */
const revisionWork = new Map<string, { vp: string; agent: string; agentId?: string; written: Set<string>; reads: Map<string, string> }>();
const workOf = (vp: string, agentId: string | undefined) => {
  const key = `${agentKey(agentId)}\u0000${vp}`;
  let w = revisionWork.get(key);
  if (!w) revisionWork.set(key, (w = { vp, agent: agentKey(agentId), ...(agentId ? { agentId } : {}), written: new Set(), reads: new Map() }));
  return w;
};
const noteWrite = (_$: EngineInterface, vp: string, rel: string, agentId: string | undefined) => {
  if (!features.revision) return;
  const w = workOf(vp, agentId);
  w.written.add(rel);
  w.reads.delete(rel);
  // Still writing: the unit has not finished, so its job waits (design: one job per unit, not per write).
  const t = flushTimers.get(agentKey(agentId));
  if (t) {
    t.cancel();
    flushTimers.delete(agentKey(agentId));
  }
};

/**
 * The debounce: a unit of work finishes when its agent commits it, or when
 * the agent's turn ends and it writes nothing more for this long. A main
 * loop that keeps editing across quick turns becomes one job, not several.
 */
const REVISION_DEBOUNCE_MS = 45_000;
const flushTimers = new Map<string, { cancel: () => void }>();

/**
 * The branch each vault was on when this session first touched it (design:
 * "the pinned branch is the vault's current branch at session start"). Every
 * commit — the model's `commonplace commit`, an accept, a revert — carries it
 * as `COMMONPLACE_PIN`, and refuses to land on another branch.
 */
const pins = new Map<string, string>();
const pinFor = async ($: EngineInterface, vp: string): Promise<string> => {
  let p = pins.get(vp);
  if (p === undefined) {
    p = "";
    try {
      const r = await $.process.run(["git", "-C", vp, "symbolic-ref", "-q", "HEAD"], { timeoutMs: 5_000 });
      if (r.exitCode === 0) p = String(r.stdout ?? "").trim();
    } catch {}
    pins.set(vp, p);
  }
  return p;
};
const noteRead = async ($: EngineInterface, vp: string, rel: string, agentId: string | undefined) => {
  if (!features.revision) return;
  const w = workOf(vp, agentId);
  if (w.written.has(rel) || (w.reads.size >= 64 && !w.reads.has(rel))) return;
  // The version read, so a job records what the agent based its write on.
  let rev = "";
  try {
    if (isSafeVaultPath(rel)) rev = `sha256:${(await sha256Hex(String(await $.fs.read(`${vp}/${rel}`)))).slice(0, 32)}`;
  } catch {}
  w.reads.set(rel, rev);
};

/** `revise ensure` ran this module lifetime, per vault (recovery + baseline are idempotent but not free). */
const revisionEnsured = new Map<string, Promise<boolean>>();
/** The running trigger/runner chain per vault: single-flight, later jobs queue behind it. */
const revisionChain = new Map<string, Promise<void>>();

/** `commonplace revise <args>` for this session's scope; the parsed last JSON line, or null. */
const revCli = async ($: EngineInterface, vp: string, args: string[], stdin?: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
  try {
    const session = String(await $.session.id()).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 12) || "s";
    const open = [...openOf(vp)].filter((s) => /^[A-Za-z0-9_.-]+$/.test(s) && s !== "loose" && s !== "quarantine");
    const r = await $.process.run(["node", `${$.plugin.root}/bin/commonplace`, "revise", ...args, "--json", "--vault", vp], {
      env: { COMMONPLACE_OPEN: open.join(","), COMMONPLACE_ACTOR: "commonplace", COMMONPLACE_SESSION: session, COMMONPLACE_PIN: await pinFor($, vp) },
      ...(stdin ? { stdin: JSON.stringify(stdin) } : {}),
      timeoutMs: 300_000,
    });
    const last = String(r.stdout ?? "").trim().split("\n").pop() ?? "";
    if (!last) return null;
    const v = JSON.parse(last);
    return Array.isArray(v) ? { rows: v } : (v as Record<string, unknown>);
  } catch {
    return null;
  }
};

const ensureRevision = ($: EngineInterface, vp: string): Promise<boolean> => {
  let p = revisionEnsured.get(vp);
  if (!p) {
    p = revCli($, vp, ["ensure"]).then((r) => {
      const ok = r !== null && r.ok !== false;
      traceTo($, vp, "revision:ensure", { ok, enabled: Array.isArray(r?.enabled) && r!.enabled.length > 0, paused: r?.paused === true, work: Number(r?.work ?? 0), jobs: Number(r?.jobs ?? 0) });
      // Not a git repository on its branch: revision runs propose-only, and the band says why (design, step 1).
      const why = r && typeof r.reason === "string" ? r.reason : "";
      if (why && !/manual|index not built/.test(why)) {
        notice($, `revision is propose-only: ${why.replace(/: revision runs propose-only.*$/, "")}`, `Vault revision cannot accept anything here (${why}). Proposals are still recorded and reviewed; nothing is written into notes or committed until this clears.`);
      }
      if (!ok) revisionEnsured.delete(vp);
      return ok;
    });
    revisionEnsured.set(vp, p);
  }
  return p;
};

/** Ports for runTrigger over this session's view of `vp`. */
const triggerPorts = ($: EngineInterface, vp: string): TriggerPorts => ({
  info: async (rel) => {
    const ctx = await nounCtx($, vp);
    if ("error" in ctx) return null;
    const view = ctx.index.view;
    const id = view?.idOfRel(rel);
    if (!view || id === undefined || !view.visible(id)) return null;
    const card = (await ctx.index.cards([id])).get(id);
    if (!card) return null;
    return { rel, title: card.t, abstraction: card.a ?? "", kind: String(card.k), shard: view.shard(id) };
  },
  text: async (rel) => {
    if (!isSafeVaultPath(rel)) return null;
    try {
      return stripFrontmatter(String(await $.fs.read(`${vp}/${rel}`)));
    } catch {
      return null;
    }
  },
  neighbours: async (rel, k) => {
    const ctx = await nounCtx($, vp);
    if ("error" in ctx) return [];
    const r = await noun.neighbourhood(ctx, { seeds: [rel], k });
    return "error" in r ? [] : r.pool.map((p) => p.card.path);
  },
  search: async (query, limit) => {
    const ctx = await nounCtx($, vp);
    if ("error" in ctx) return [];
    const r = await noun.search(ctx, { query, limit });
    return "error" in r ? [] : r.hits.map((h) => h.path);
  },
  complete: async (req) => {
    const r = await $.model.complete({ ...req, timeoutMs: 180_000 } as CompletionRequest);
    return r.isAnswered ? r.text : null;
  },
  propose: async (p) => {
    const r = await revCli($, vp, ["propose"], { ...p, origin: "write-trigger" });
    return { status: String(r?.status ?? "error"), ...(r?.reason ? { reason: String(r.reason) } : {}) };
  },
  log: (stage, data) => traceTo($, vp, stage, data),
  random: () => Math.random(),
});

const runnerPorts = ($: EngineInterface, vp: string): RunnerPorts => ({
  cli: (args, stdin) => revCli($, vp, args, stdin),
  complete: async (req) => {
    const r = await $.model.complete({ ...req, timeoutMs: 300_000 } as CompletionRequest);
    return r.isAnswered ? r.text : null;
  },
  log: (stage, data) => traceTo($, vp, stage, data),
  onAccepted: (a) => {
    const line = a.line ? `[[${a.old}]] ${a.line}` : `[[${a.old}]] revised by [[${a.new}]]`;
    notice(
      $,
      `revised ${line}`,
      [
        `**Revision accepted** — ${line}.`,
        `The edge was written into [[${a.new}]] and committed${a.commit ? ` (\`${a.commit.slice(0, 10)}\`)` : ""}; nothing in [[${a.old}]] was edited.`,
        a.stale ? `${a.stale} concept or MOC note${a.stale === 1 ? "" : "s"} citing it ${a.stale === 1 ? "is" : "are"} marked to recheck.` : "",
        `Undo reverts that commit's edge (\`/vault revise undo ${a.accept}\`); \`/vault revise log\` has the full history.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      { vp, event: a.accept },
    );
  },
});

/**
 * Drain the vault's durable job queue, then advance pending revisions.
 * Single-flight per vault; never awaited by a hook. Jobs left by a session
 * that died are claimed here once their lease runs out.
 */
const JOBS_PER_RUN = 5;
const processRevision = ($: EngineInterface, vp: string) => {
  // Switched off in the plugin's settings: no jobs, no model calls, no commits.
  if (!features.revision) return;
  const prev = revisionChain.get(vp);
  if (prev) {
    // One run is enough: whatever it does not see yet, the next turn's run will.
    pendingRerun.add(vp);
    return;
  }
  const run = (async () => {
    if (!(await ensureRevision($, vp))) return;
    for (let i = 0; i < JOBS_PER_RUN; i++) {
      const claimed = await revCli($, vp, ["job-next"]);
      const job = claimed?.job as { job: string; written: string[]; reads: string[]; pairs?: Pair[]; attempt: number } | undefined;
      if (!job) break;
      let res: Awaited<ReturnType<typeof runTrigger>>;
      try {
        res = await runTrigger(triggerPorts($, vp), { written: job.written, reads: job.reads, ...(job.pairs ? { pairs: job.pairs } : {}) });
      } catch (err) {
        await revCli($, vp, ["job-failed", "--job", job.job, "--reason", String(err).slice(0, 120)]);
        continue;
      }
      const { overflow, ...counts } = res;
      traceTo($, vp, "revision:trigger", { ...counts, overflow: overflow.length, attempt: job.attempt });
      if (overflow.length) {
        // Past the per-job cap: queued as a job of its own, never dropped.
        await revCli($, vp, ["job-enqueue"], { written: [...new Set(overflow.map((o) => o.written))], pairs: overflow, origin: "overflow" });
      }
      // No answer from the model is not "nothing changed": retried, up to the attempt limit.
      if (res.unanswered > 0 && res.proposed === 0) await revCli($, vp, ["job-failed", "--job", job.job, "--reason", `${res.unanswered} model calls unanswered`]);
      else await revCli($, vp, ["job-done", "--job", job.job], { poolSize: res.pool, truncated: res.truncated, changed: res.changed, proposals: res.proposed });
    }
    const steps = await runSteps(runnerPorts($, vp));
    traceTo($, vp, "revision:steps", { steps });
  })().catch((err) => traceTo($, vp, "revision:error", { err: String(err).slice(0, 80) }));
  revisionChain.set(vp, run);
  void run.finally(() => {
    revisionChain.delete(vp);
    if (pendingRerun.delete(vp)) processRevision($, vp);
  });
};
const pendingRerun = new Set<string>();
const revisionKicked = new Map<string, number>();
const REVISION_REKICK_MS = 5 * 60_000;

/** Enqueue every finished unit of work this agent holds, then process the queue. */
const flushRevisionWork = async ($: EngineInterface, agentId: string | undefined) => {
  const agent = agentKey(agentId);
  flushTimers.get(agent)?.cancel();
  flushTimers.delete(agent);
  for (const [key, w] of revisionWork) {
    if (w.agent !== agent || w.written.size === 0) continue;
    revisionWork.delete(key);
    const origin = await agentTypeOf($, w.agentId);
    const r = await revCli($, w.vp, ["job-enqueue"], { written: [...w.written], reads: [...w.reads].map(([rel, rev]) => ({ rel, rev })), origin, ...(units.get(agent) ? { unit: units.get(agent)!.id } : {}) });
    traceTo($, w.vp, "revision:enqueue", {
      queued: Array.isArray(r?.queued) ? r!.queued.length : 0,
      duplicate: Number(r?.duplicate ?? 0),
      skipped: Array.isArray(r?.skipped) ? (r!.skipped as Array<{ why: string }>).map((x) => x.why) : [],
    });
    processRevision($, w.vp);
  }
};

/** At an agent's turn end: flush its work once it has been quiet for the debounce window. */
const scheduleRevisionFlush = ($: EngineInterface, agentId: string | undefined) => {
  const agent = agentKey(agentId);
  if (![...revisionWork.values()].some((w) => w.agent === agent && w.written.size)) return;
  flushTimers.get(agent)?.cancel();
  const t = $.clock.after(REVISION_DEBOUNCE_MS, () => {
    flushTimers.delete(agent);
    void flushRevisionWork($, agentId);
  });
  flushTimers.set(agent, { cancel: () => t.cancel() });
};

/**
 * The activity log: everything commonplace did on its own that the person
 * might want to look at — a revision accepted, a reindex, a quarantine. A
 * notice puts one line on the band with Details (this pane) and, for a
 * revision, Undo. Module memory: an entry can name an open private note.
 */
type ActivityEntry = { id: number; at: string; text: string; details: string; revert?: { vp: string; event: string }; undone?: boolean };
const vaultActivity: ActivityEntry[] = [];
let activitySeq = 0;
const ACTIVITY_PANE = "commonplace-activity";
const ACTIVITY_MAX = 50;

const notice = ($: EngineInterface, text: string, details: string, revert?: { vp: string; event: string }, opts: { card?: boolean } = {}) => {
  const entry: ActivityEntry = { id: ++activitySeq, at: new Date().toISOString(), text, details, ...(revert ? { revert } : {}) };
  vaultActivity.unshift(entry);
  if (vaultActivity.length > ACTIVITY_MAX) vaultActivity.length = ACTIVITY_MAX;
  bumpPanes($);
  if (opts.card === false) return;
  // A connection or triage card is waiting on a press; a notice never covers
  // it, and shows once that card comes down (a press, or the next prompt).
  if (bandCard && bandCard.kind !== "notice") {
    heldNotice = entry.id;
    return;
  }
  showCard($, { kind: "notice", entry: entry.id }, text);
};
let heldNotice: number | null = null;
/** The notice a card held back, if any; true when it is now on the band. */
const showHeldNotice = ($: EngineInterface): boolean => {
  const entry = heldNotice === null ? undefined : vaultActivity.find((a) => a.id === heldNotice);
  heldNotice = null;
  if (!entry) return false;
  showCard($, { kind: "notice", entry: entry.id }, entry.text);
  return true;
};

const renderActivity = (): string => {
  if (vaultActivity.length === 0) return "# Vault activity\n\nNothing yet this session.";
  return [
    "# Vault activity",
    ...vaultActivity.map((a) => `## ${a.at.slice(11, 16)} · ${a.text}${a.undone ? " (undone)" : ""}\n\n${a.details}`),
  ].join("\n\n");
};

const openActivity = async ($: EngineInterface): Promise<boolean> => {
  try {
    return (await $.ui.open({ id: ACTIVITY_PANE, title: "⟡ vault · activity" })).isPlaced;
  } catch {
    return false;
  }
};

/**
 * The revision explainer (`/vault explain`, "How it works" in the activity
 * pane): a pane of pages, a diagram each. Remote surfaces draw the SVG; the
 * terminal draws the PNG rendered from it (`npm run explain:render`). The last
 * page is this vault's numbers, read when the pane opens.
 */
const EXPLAIN_PANE = "commonplace-explain";
let explainPage = 0;
let explainLive: LiveCounts | null = null;
const explainPng = new Map<string, string>();

const openExplain = async ($: EngineInterface, vp: string | undefined, page = 0): Promise<boolean> => {
  explainPage = Math.max(0, Math.min(page, EXPLAIN_PAGES.length - 1));
  if (vp) {
    const st = await revCli($, vp, ["status"]);
    if (st) {
      explainLive = {
        mode: String(st.mode ?? "manual"),
        paused: st.paused === true,
        counts: (st.counts ?? {}) as Record<string, number>,
        stale: Number(st.stale ?? 0),
      };
      if (!features.revision) explainLive.mode = "off (vaultRevision)";
    }
  }
  bumpPanes($);
  try {
    return (await $.ui.open({ id: EXPLAIN_PANE, title: "⟡ vault · how revision works" })).isPlaced;
  } catch {
    return false;
  }
};

/** No pane (a surface that cannot seat one): the pages as text. */
const renderExplainText = (): string =>
  [
    "# How vault revision works",
    ...EXPLAIN_PAGES.map((p, i) => `## ${i + 1}. ${p.title}\n\n${p.id === "live" && explainLive ? liveBars(explainLive) : p.alt}\n\n${p.body}`),
  ].join("\n\n");

const undoRevision = async ($: EngineInterface, vp: string, event: string): Promise<string> => {
  const r = await revCli($, vp, ["revert", "--event", event, "--reason", "undone by the person"]);
  traceTo($, vp, "revision:undo", { status: String(r?.status ?? "error") });
  if (r?.status !== "reverted") return `Not undone: ${String(r?.reason ?? "the revert failed")}`;
  for (const a of vaultActivity) if (a.revert?.event === event) a.undone = true;
  const msg = `Undone${r.commit ? ` (commit ${String(r.commit).slice(0, 10)})` : ""}${r.conflict ? `; the file kept its edge: ${String(r.conflict)}` : ""}.`;
  notice($, "revision undone", msg, undefined, { card: false });
  return msg;
};

/** Notes read with vault_note this session, per vault (the "unread" hint). */
const trails = new Map<string, Set<number>>();
const trailOf = (vp: string) => {
  let t = trails.get(vp);
  if (!t) trails.set(vp, (t = new Set()));
  return t;
};

/** Last vault tool call, for the ToolUse row. Module memory: titles may be private. */
let lastTool: { tool: string; summary: string; ms: number } | null = null;

/**
 * Per-call row data for the ToolUse render (§9.3), by tool_use_id. Module
 * memory: a row may name an open private note, which is the user's own screen
 * but never shared state.
 */
const toolRows = new Map<string, { tool: string; subject: string; summary: string; ms: number; error: boolean }>();

/** What a vault tool is doing right now (Spinner message). */
const activity = atom({ plugin: "commonplace", key: "activity" } as const, null as { tool: string; startedAt: number } | null);

/**
 * Band text lives in module memory — it can name an open private note — and
 * `$.state` carries only the kind (§2.2: nothing private in shared state).
 */
let bandText = "";
/** Kinds whose line is the module-memory `bandText` rather than the heartbeat. */
const BAND_TEXT_KINDS = new Set<string>(["following", "open", "propose", "primed", "reindexed"]);
const setBand = ($: EngineInterface, b: { kind: CommonplaceBand["kind"]; text: string }) => {
  bandText = b.text;
  update($, band, (cur) => ({ ...cur, visible: true, kind: b.kind }));
};

const INCREMENTAL_WHY = new Set(["write", "sweep", "sealed-change"]);

/** Start a background full rebuild unless one started recently (the CLI takes the lock). */
const startBuild = ($: EngineInterface, vp: string, why: string) => {
  const now = Date.now();
  if (now - (buildStarted.get(vp) ?? 0) < BUILD_COOLDOWN_MS) return;
  buildStarted.set(vp, now);
  traceTo($, vp, "index:build", { why });
  const run = $.process
    .run(
      // Incremental only when a note changed; an absent graph, a compaction or
      // an explicit /vault reindex must rebuild even if no mtime moved.
      ["node", `${$.plugin.root}/bin/commonplace`, "index", "--vault", vp, ...(INCREMENTAL_WHY.has(why) ? ["--incremental"] : [])],
      { timeoutMs: 300_000 },
    )
    .then((r) => {
      const ok = r.exitCode === 0;
      if (ok) swept.delete(vp);
      traceTo($, vp, "index:built", { ok });
      // Only a rebuild the person asked for is announced. Sweep, sealed-change
      // and compaction builds fire in the background of any session holding
      // the index, where a toast is noise about work nobody requested.
      if (ok && why === "command") {
        try {
          notice($, "vault index refreshed", `\`commonplace index\` rebuilt \`.wiki/graph/\` for ${vp.split("/").pop()} after /vault reindex.`);
        } catch {}
      }
      return ok;
    })
    .catch(() => false)
    .finally(() => {
      if (building.get(vp) === run) building.delete(vp);
    });
  building.set(vp, run);
};

/** The loaded index for a vault, kept fresh and in step with this session's open shards. */
const getIndex = async ($: EngineInterface, vp: string, domains: DomainMap): Promise<VaultIndex> => {
  let idx = indexes.get(vp);
  if (!idx) {
    const abs = (rel: string) => `${vp}/.wiki/${rel}`;
    const ports: IndexPorts = {
      read: async (rel) => {
        try {
          return String(await $.fs.read(abs(rel)));
        } catch {
          return null;
        }
      },
      head: async (rel, n) => {
        try {
          return String(await $.fs.read(abs(rel))).slice(0, n);
        } catch {
          return null;
        }
      },
      size: async (rel) => {
        try {
          return (await $.fs.stat(abs(rel))).size ?? null;
        } catch {
          return null;
        }
      },
      append: async (rel, line) => {
        const path = abs(rel);
        await $.process.run(["mkdir", "-p", path.slice(0, path.lastIndexOf("/"))]);
        await $.process.run(["tee", "-a", path], { stdin: `${line}\n` });
      },
      now: () => Date.now(),
    };
    idx = new VaultIndex(ports, domains, String(await $.session.id()).slice(0, 8));
    indexes.set(vp, idx);
    // The sweep exists to keep a LOADED graph fresh, so it starts with the
    // first load: a session that never touches the vault never walks it.
    if (!sweepTimer) {
      sweepTimer = $.clock.every(60_000, () => {
        sweep($).catch(() => {});
      });
    }
  }
  idx.setDomains(domains);
  const state = await idx.ensureFresh();
  if (state === "absent") startBuild($, vp, "absent");
  if (state === "ready" && !quarantineChecked.has(vp)) {
    quarantineChecked.add(vp);
    // Counts only — the sealed manifest names no note and no folder.
    try {
      const sm = JSON.parse(String(await $.fs.read(`${vp}/.wiki/sealed/manifest.json`)));
      const n = Number(sm?.shards?.quarantine?.nodes ?? 0);
      if (n > 0) {
        notice(
          $,
          `🔒 ${n} note${n === 1 ? "" : "s"} in new folders quarantined`,
          `${n} note${n === 1 ? "" : "s"} live in folders that appeared after the first index. They stay sealed (no vault tool sees them) until you classify the folder: \`/vault domain public <id>\` or \`/vault domain private <id>\`. The ids are in \`.wiki/domains.json\`.`,
        );
      }
    } catch {}
  }
  // Splice exactly the shards this session has open (loose/quarantine never open).
  const want = [...openOf(vp)].filter((s) => s !== "loose" && s !== "quarantine");
  for (const s of want) if (!idx.openShards().includes(s)) await idx.openShard(s);
  for (const s of idx.openShards()) if (!want.includes(s)) idx.closeShard(s);
  return idx;
};

const quarantineChecked = new Set<string>();

/** Pick a registered vault by id, alias, label or path; the active vault when omitted. */
const pickVault = async ($: EngineInterface, ref?: string): Promise<GuardVault | null> => {
  const { vaults } = await loadGuard($);
  if (ref && String(ref).trim()) {
    const r = String(ref).trim().toLowerCase();
    return (
      vaults.find(
        (v) =>
          v.id?.toLowerCase() === r ||
          v.label?.toLowerCase() === r ||
          (v.aliases ?? []).some((a) => a.toLowerCase() === r) ||
          v.path.toLowerCase() === r.replace(/\/+$/, ""),
      ) ?? null
    );
  }
  const vp = await ensureVaultPath($, await $.session.cwd());
  return vaults.find((v) => v.path === vp || v.real === vp) ?? (vp ? { path: vp, domains: {} } : null);
};

type Ctx = noun.NounCtx & { vaultPath: string; vault: GuardVault };

/** Everything a noun method needs for one vault, scope included. */
const nounCtx = async ($: EngineInterface, vaultRef?: string): Promise<Ctx | { error: string }> => {
  const vault = await pickVault($, vaultRef);
  if (!vault) {
    return { error: vaultRef ? `no registered vault matches "${vaultRef}"` : "no vault configured — run `commonplace init --vault <path>`" };
  }
  const vp = vault.path;
  const idx = await getIndex($, vp, vault.domains);
  if (idx.state !== "ready") {
    // No index yet: the build getIndex just started (or one already running)
    // usually takes well under a second. Wait for it rather than erroring —
    // a model told "retry later" tends to answer from memory instead.
    const run = building.get(vp);
    if (run) await Promise.race([run, $.clock.sleep(BUILD_WAIT_MS)]);
    if ((await idx.load()) !== "ready") return { error: "vault index still building (large vault) — retry in a minute" };
    await getIndex($, vp, vault.domains); // splice this session's open shards into the fresh load
  }
  const open = openOf(vp);
  const { names } = await loadGuard($);
  const sealedNames = names
    .filter((n) => n.vault === vp && n.shard !== PRIVATE_VAULT_SHARD && !open.has(n.shard))
    .flatMap((n) => [n.t, ...(n.al ?? [])]);
  return {
    vaultId: vault.id ?? vault.label ?? vp.split("/").pop() ?? "vault",
    vaultPath: vp,
    vault,
    index: idx,
    domains: vault.domains,
    open,
    sealedNames,
    readSet: trailOf(vp),
    readNote: async (rel) => {
      if (!isSafeVaultPath(rel)) return null;
      try {
        return String(await $.fs.read(`${vp}/${rel}`));
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
  };
};

/** Extra rows `vault_list` needs that the noun core cannot read itself. */
const listExtras = async ($: EngineInterface, ctx: Ctx, what: string) => {
  if (what === "vaults") {
    const { vaults } = await loadGuard($);
    return {
      vaults: vaults
        .filter((v) => !v.isPrivate || v.path === ctx.vaultPath)
        .map((v) => ({ id: v.id ?? "", label: v.label ?? "", path: v.path, active: v.path === ctx.vaultPath })),
    };
  }
  if (what === "recent") {
    let text = "";
    try {
      text = String(await $.fs.read(`${ctx.vaultPath}/.wiki/graph/files.jsonl`));
    } catch {}
    return { recent: parseJsonl(text) as Array<{ p: string; mt: number }> };
  }
  return {};
};

/** `$.store` key holding the person's trusted skill hashes for a vault. */
const trustKey = (vault: GuardVault) => `skills:trusted:${vault.id ?? vault.path}`;

/** `$.store` key holding skill hashes the person answered "Never ask" for. */
const declinedKey = (vault: GuardVault) => `skills:declined:${vault.id ?? vault.path}`;

/**
 * Find, read and filter a vault's skills (plan §7.2): the vault's own Claude
 * Code skills, `<vault>/.claude/skills/<name>/SKILL.md` and the same under any
 * folder in it. One `find` and one read per skill — cheap enough per call.
 * `.claude/worktrees` holds checkouts of other repos, whose skills are theirs.
 */
const loadVaultSkills = async ($: EngineInterface, vault: GuardVault): Promise<VaultSkill[]> => {
  const root = vault.path;
  let listing = "";
  try {
    const r = await $.process.run([
      "find", root, "-maxdepth", "6", "-path", "*/.claude/skills/*/SKILL.md",
      "-not", "-path", "*/.claude/worktrees/*", "-not", "-path", "*/node_modules/*",
      "-not", "-path", "*/.git/*", "-not", "-path", "*/.trash/*",
    ]);
    listing = r.exitCode === 0 ? String(r.stdout ?? "") : "";
  } catch {
    return [];
  }
  const files: SkillFile[] = [];
  const paths = listing.split("\n").map((l) => l.trim()).filter(Boolean);
  // The vault root's skills first, so a nested skill cannot shadow one by name.
  paths.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
  for (const path of paths.slice(0, 50)) {
    const rel = path.slice(root.length + 1);
    const at = rel.lastIndexOf(".claude/skills/");
    if (at < 0) continue;
    const base = rel.slice(0, at).replace(/\/$/, "");
    const dir = rel.slice(at + ".claude/skills/".length, rel.length - "/SKILL.md".length);
    if (dir.includes("/")) continue;
    try {
      const text = String(await $.fs.read(path));
      files.push({ dir, base, text, hash: await sha256Hex(text) });
    } catch {}
  }
  const trusted = ((await $.store.get(trustKey(vault))) ?? {}) as Record<string, string>;
  const open = openOf(vault.path);
  const { names } = await loadGuard($);
  const sealed = names.filter((n) => n.vault === vault.path && n.shard !== PRIVATE_VAULT_SHARD && !open.has(n.shard)).flatMap((n) => [n.t, ...(n.al ?? [])]);
  return visibleSkills(
    files,
    trusted,
    (domain) => listableDomains(vault.domains, open).includes(domain),
    sealed,
    (shard) => open.has(shard),
    vault.domains,
  );
};

/** Skills answered "Not now" this session (by content hash). */
const skillsNotNow = new Set<string>();

/**
 * Ask the person whether to trust a skill's current content (the
 * AskUserQuestion dialog). "Trust" pins the hash, "Never ask" remembers it
 * across sessions, "Not now" for this session. Resolves true only on Trust;
 * false with nobody to ask (`-p`) or when dismissed.
 */
const askTrust = async ($: EngineInterface, vault: GuardVault, s: VaultSkill): Promise<boolean> => {
  if (s.trusted) return true;
  if (skillsNotNow.has(s.hash)) return false;
  const declined = ((await $.store.get(declinedKey(vault))) ?? {}) as Record<string, string>;
  if (declined[s.name] === s.hash) return false;
  let answer = "";
  try {
    answer = await $.ui.ask(
      `${s.changed ? "Vault skill changed since you trusted it" : "New vault skill found"}: "${s.name}" — ${s.description.slice(0, 160)} ` +
        `(${vault.label ?? vault.id ?? "vault"}: ${s.path}). Trust this exact content so it can run from any project? An edit asks again.`,
      { options: ["Trust", "Not now", "Never ask"], header: "Vault skill" },
    );
  } catch {
    return false;
  }
  if (answer === "Trust") {
    const trusted = { ...(((await $.store.get(trustKey(vault))) ?? {}) as Record<string, string>), [s.name]: s.hash };
    await $.store.set(trustKey(vault), trusted);
    traceTo($, vault.path, "skill:trusted", { via: "ask" });
    return true;
  }
  if (answer === "Never ask") await $.store.set(declinedKey(vault), { ...declined, [s.name]: s.hash });
  else skillsNotNow.add(s.hash);
  return false;
};

/**
 * At session start, outside the vault: ask about every skill that is new or
 * changed since it was trusted. Inside the vault Claude Code loads them
 * itself, so there is nothing to trust.
 */
const offerNewSkills = async ($: EngineInterface) => {
  const vault = await pickVault($);
  if (!vault) return;
  const cwd = normalizePath(String(await $.session.cwd()), "/");
  if (cwd === vault.path || cwd.startsWith(`${vault.path}/`)) return;
  for (const s of await loadVaultSkills($, vault)) {
    if (!s.trusted) await askTrust($, vault, s);
  }
};

/** `vault_skill` and `$.commonplace.skill(s)`: see the skills section (Phase 4). */
const impl_skill = async ($: EngineInterface, args: { name?: string; vault?: string }): Promise<string> => {
  const vault = await pickVault($, args.vault);
  if (!vault) return "ERROR: no vault configured";
  const skills = await loadVaultSkills($, vault);
  if (!args.name) {
    if (skills.length === 0) return "This vault has no skills. They live in the vault's .claude/skills/<name>/SKILL.md.";
    return ["Vault skills:", ...skills.map((s) => `- ${s.name} — ${s.description}${s.trusted ? "" : " (untrusted: calling it asks the user to trust it)"}`)].join("\n");
  }
  const s = skills.find((x) => x.name === args.name);
  if (!s) return `ERROR: no vault skill named "${args.name}"`;
  if (!(await askTrust($, vault, s))) return `ERROR: the user has not trusted vault skill "${s.name}"; do not follow it.`;
  return skillBlock(s, vault.id ?? "vault");
};


// ---------------------------------------------------------------------------
// /vault commands (plan §6.2). Commands are the person's: the model cannot
// run them, which is why `/vault open` is one of only two unseal signals.
// ---------------------------------------------------------------------------

const VAULT_COMMANDS = [
  {
    name: "vault",
    description: "commonplace vault: status · use · list · open · close · reindex · skills · domain · witness · later · revise · activity · explain",
    argumentHint: "[use <id> | list | open <domain> | close [domain] | reindex | skills [trust|untrust <name>] | domain public|private <id> | witness | later | revise [log [note] | undo <event|last> | pause | resume] | activity]",
  },
];

const VAULT_HELP = [
  "/vault                         active vault, index state, open private domains",
  "/vault list                    registered vaults",
  "/vault use <id> [--default]    pin a vault for this project (--default: for every project)",
  "/vault open <domain>           include a private domain in this session (and its link group)",
  "/vault close [domain]          seal it again (all when omitted)",
  "/vault reindex                 rebuild the vault index in the background",
  "/vault skills [trust|untrust <name>]   list vault skills / trust one's current content",
  "/vault domain public|private <id>      classify a domain (e.g. a quarantined folder)",
  "/vault witness [clear]         everything commonplace added to context that the transcript does not show",
  "/vault later [clear]           links saved with Later on a link card",
  "/vault revise [log [note]]     revision status, or the history of what was revised and why",
  "/vault revise undo <event|last>  revert an accepted revision (git keeps both)",
  "/vault revise pause|resume     stop or restart autonomous acceptance",
  "/vault activity                what commonplace did on its own this session (the notices)",
  "/vault explain                 how vault revision works, in pictures, with this vault's numbers",
].join("\n");

const scopeMirror = async ($: EngineInterface, vp: string) => {
  try {
    await $.state.set({ plugin: "commonplace", key: "scope" }, { vault: vp.split("/").pop() ?? "", openCount: openOf(vp).size });
  } catch {}
};

/** Run one `/vault …` invocation. Returns the transcript text (+ hidden model context). */
const runVaultCommand = async ($: EngineInterface, argsText: string): Promise<{ text: string; context?: string[] }> => {
  const [sub = "", ...rest] = argsText.trim().split(/\s+/).filter(Boolean);
  const vault = await pickVault($);
  if (sub === "help") return { text: VAULT_HELP };
  if (sub === "list") {
    const { vaults } = await loadGuard($);
    if (vaults.length === 0) return { text: "No vaults registered. Run `commonplace init --vault <path>`." };
    return {
      text: vaults
        .filter((v) => !v.isPrivate || v.path === vault?.path)
        .map((v) => `${v.path === vault?.path ? "●" : "○"} ${v.id ?? "?"}  ${v.path}${v.aliases?.length ? `  (aliases: ${v.aliases.join(", ")})` : ""}`)
        .join("\n"),
    };
  }
  if (sub === "use") {
    const id = rest.find((x) => !x.startsWith("--"));
    if (!id) return { text: "Usage: /vault use <id|alias> [--default]" };
    const argv = ["node", `${$.plugin.root}/bin/commonplace`, "vault", "use", id];
    if (rest.includes("--default")) argv.push("--default");
    const r = await $.process.run(argv, { cwd: await $.session.cwd() });
    vaultPaths.clear();
    vaultMisses.clear();
    guardCache = null;
    const out = String(r.stdout ?? r.stderr ?? "").trim();
    if (r.exitCode !== 0) return { text: out || `Could not switch to "${id}".` };
    try {
      notice($, `switched to ${id}`, `This project now uses the vault "${id}".`, undefined, { card: false });
      void showVaultStatus($);
    } catch {}
    return { text: out || `Using vault ${id}.`, context: [`The active commonplace vault is now "${id}".`] };
  }
  if (sub === "explain") {
    if (await openExplain($, vault?.path)) return { text: `Explainer open: ${EXPLAIN_PAGES.length} pages.` };
    return { text: renderExplainText() };
  }
  if (sub === "witness") {
    if (rest[0] === "clear") {
      witness.clear();
      bumpPanes($);
      return { text: "Witness cleared." };
    }
    // The pane, not the transcript: a command's text is read by the model too.
    try {
      const r = await $.ui.open({ id: WITNESS_PANE, title: "⟡ vault · witness" });
      if (r.isPlaced) return { text: `Witness pane open: ${witness.list().length} hidden additions this session.` };
    } catch {}
    return { text: renderWitness(witness) };
  }
  if (sub === "activity") {
    if (await openActivity($)) return { text: `Activity pane open: ${vaultActivity.length} entries this session.` };
    return { text: renderActivity() };
  }
  if (!vault) return { text: "No vault configured. Run `commonplace init --vault <path>`." };
  const vp = vault.path;
  if (sub === "revise") {
    const [action = "status", ...more] = rest;
    if (action === "undo") {
      const ev = more[0];
      if (!ev) return { text: "Usage: /vault revise undo <event|last>" };
      return { text: await undoRevision($, vp, ev) };
    }
    // Off: undoing an earlier accept still works; nothing new is proposed or accepted.
    if (!features.revision && action !== "log") return { text: "Vault revision is off in the plugin's settings (vaultRevision). Earlier accepts can still be undone: /vault revise undo <event|last>." };
    if (action === "pause" || action === "resume") {
      const r = await revCli($, vp, [action]);
      if (action === "resume") processRevision($, vp);
      return { text: r ? (action === "pause" ? "Revision paused: nothing will be accepted until /vault revise resume." : "Revision resumed.") : "The revision CLI failed." };
    }
    if (action === "log") {
      const out = await revCli($, vp, ["log", ...(more.length ? ["--note", more.join(" ")] : []), "--limit", "20"]);
      const rows = Array.isArray(out?.rows) ? (out!.rows as LineageRow[]) : [];
      return { text: out === null ? "The revision log could not be read." : formatLineage(rows, more.join(" ") || undefined) };
    }
    await ensureRevision($, vp);
    const st = await revCli($, vp, ["status"]);
    if (!st) return { text: "The revision CLI failed." };
    const counts = Object.entries((st.counts ?? {}) as Record<string, number>).map(([k, n]) => `${k} ${n}`).join(" · ");
    return {
      text: `revision: ${String(st.mode)}${st.paused ? " (paused)" : ""}${counts ? ` · ${counts}` : " · no proposals"}${Number(st.stale ?? 0) ? ` · ${Number(st.stale)} summaries to recheck` : ""}\n/vault revise log · /vault revise undo last · /vault revise pause`,
    };
  }
  if (sub === "open") {
    const ref = rest.join(" ");
    const hit = resolveOpenRef(vault.domains, ref);
    if (!hit || hit.shard === "loose" || hit.shard === "quarantine") {
      const pub = listableDomains(vault.domains, openOf(vp));
      return { text: `No private domain "${ref}". Domains you can already see: ${pub.join(", ") || "(none)"}.` };
    }
    let set = openShards.get(vp);
    if (!set) openShards.set(vp, (set = new Set()));
    set.add(hit.shard);
    const group = Object.keys(vault.domains).filter((id) => isPrivateDomain(vault.domains[id]) && shardOfDomain(vault.domains, id) === hit.shard);
    traceTo($, vp, "scope:open", { reason: "command" });
    await getIndex($, vp, vault.domains).catch(() => null);
    setBand($, { kind: "open", text: `open: ${group.join(" + ")} · /vault close to seal` });
    await scopeMirror($, vp);
    notice($, `🔒 opened ${group.join(" + ")}`, `Private domain${group.length > 1 ? "s" : ""} ${group.join(", ")} opened for this session by /vault open. \`/vault close\` seals ${group.length > 1 ? "them" : "it"} again; a reload, /clear or a new session also re-seals.`, undefined, { card: false });
    return {
      text: `Opened ${group.join(" + ")} for this session. Vault tools now include ${group.length > 1 ? "these domains" : "this domain"}. /vault close seals it again (it cannot unread what this conversation already holds).`,
      context: [
        `The user opened the private vault domain(s) ${group.join(", ")} for this session. Their notes are now visible to vault tools; keep their content in the vault and out of code or other repositories.`,
      ],
    };
  }
  if (sub === "close") {
    const set = openShards.get(vp) ?? new Set<string>();
    const ref = rest.join(" ");
    if (ref) {
      const hit = resolveOpenRef(vault.domains, ref);
      if (hit) set.delete(hit.shard);
    } else set.clear();
    traceTo($, vp, "scope:close", {});
    await getIndex($, vp, vault.domains).catch(() => null);
    await scopeMirror($, vp);
    update($, band, (b) => ({ ...b, visible: false, kind: "idle" as const }));
    return { text: set.size ? "Sealed. Other domains you opened stay open." : "All private domains sealed for this session." };
  }
  if (sub === "later") {
    if (rest[0] === "clear") {
      await $.store.set(laterKey(vp), []);
      return { text: "Saved links cleared." };
    }
    return { text: formatLater(((await $.store.get(laterKey(vp))) ?? []) as LaterItem[]) };
  }
  if (sub === "reindex") {
    buildStarted.delete(vp);
    startBuild($, vp, "command");
    return { text: "Rebuilding the vault index in the background; a toast says when it is done." };
  }
  if (sub === "skills") {
    const [action, name] = rest;
    const skills = await loadVaultSkills($, vault);
    if ((action === "trust" || action === "untrust") && name) {
      const s = skills.find((x) => x.name === name);
      if (!s) return { text: `No vault skill "${name}" in ${vp} (looked in .claude/skills folders).` };
      const trusted = { ...(((await $.store.get(trustKey(vault))) ?? {}) as Record<string, string>) };
      if (action === "trust") trusted[name] = s.hash;
      else delete trusted[name];
      await $.store.set(trustKey(vault), trusted);
      return {
        text:
          action === "trust"
            ? `Trusted vault skill "${name}" (this exact content; any edit untrusts it). Run it with /commonplace:vault-skill ${name} [args].`
            : `Untrusted vault skill "${name}".`,
      };
    }
    if (skills.length === 0) return { text: `No vault skills. They live in ${vp}/.claude/skills/<name>/SKILL.md (frontmatter: name, description).` };
    return {
      text: skills
        .map((s) => `${s.trusted ? "✓" : s.changed ? "!" : "·"} ${s.name} — ${s.description}${s.trusted ? "" : s.changed ? "  (changed since trusted: /vault skills trust " + s.name + ")" : "  (untrusted: /vault skills trust " + s.name + ")"}`)
        .join("\n"),
    };
  }
  if (sub === "domain") {
    const [scope, id] = rest;
    if ((scope !== "public" && scope !== "private") || !id) return { text: "Usage: /vault domain public|private <id>" };
    let reg: { domains?: Record<string, Record<string, unknown>> } = {};
    try {
      reg = JSON.parse(String(await $.fs.read(`${vp}/.wiki/domains.json`)));
    } catch {
      return { text: "Could not read .wiki/domains.json." };
    }
    if (!reg.domains?.[id]) return { text: `No domain "${id}" in .wiki/domains.json.` };
    reg.domains[id] = { ...reg.domains[id], scope };
    await $.fs.write(`${vp}/.wiki/domains.json`, JSON.stringify(reg, null, 2) + "\n");
    guardCache = null;
    buildStarted.delete(vp);
    startBuild($, vp, "command");
    return { text: `Domain "${id}" is now ${scope}. Reindexing in the background.` };
  }
  // Status.
  const idx = await getIndex($, vp, vault.domains).catch(() => null);
  const m = idx?.manifest;
  const open = openOf(vp);
  const openNames = Object.keys(vault.domains).filter((id) => isPrivateDomain(vault.domains[id]) && open.has(shardOfDomain(vault.domains, id)));
  return {
    text: [
      `⟡ ${vault.id ?? "vault"} — ${vp}`,
      m ? `index v${m.version}: ${m.shards.main.nodes} public notes, ${m.shards.main.edges} links, built ${m.builtAt}${idx!.view!.patchCount() ? `, ${idx!.view!.patchCount()} patched since` : ""}` : "index: not built yet (building in the background)",
      openNames.length ? `open private domains: ${openNames.join(", ")} (close cannot unread what the conversation holds)` : "private domains: all sealed",
      "",
      VAULT_HELP,
    ].join("\n"),
  };
};

/**
 * Inert stubs for `$.commonplace` (plan §2.2a rule 1). A stub runs only when
 * our own method hook throws (P4), so each answers an error value or an empty
 * result — never data, never a throw.
 */
const STUB_ERROR = { error: "commonplace: method called before its hook was bound" };
const ABSENT_INDEX: CommonplaceIndexStatus = {
  state: "absent", version: 0, journalSeq: 0, nodes: 0, edges: 0, builtAt: null, lastPatchMs: null,
};
const NOUN_STUBS: Commonplace = Object.freeze({
  version: async () => ({ apiVersion: 1 as const, plugin: "commonplace" }),
  vaults: async () => [],
  activeVault: async () => null,
  scope: async () => ({ vault: "", openCount: 0 }),
  search: async () => ({ hits: [], vault: "", tookMs: 0 }),
  note: async () => STUB_ERROR,
  links: async () => STUB_ERROR,
  path: async () => STUB_ERROR,
  neighbourhood: async () => STUB_ERROR,
  list: async () => ({ items: [] }),
  skills: async () => [],
  skill: async () => STUB_ERROR,
  reindex: async () => ABSENT_INDEX,
  status: async () => ABSENT_INDEX,
});

/** `.wiki/config.json` per vault (structure folders, abstraction adoption), cached for the session. */
const configs = new Map<string, { structure?: { sources?: string; concepts?: string; mocs?: string }; abstractions?: boolean }>();
const vaultConfig = async ($: EngineInterface, vp: string) => {
  let c = configs.get(vp);
  if (!c) {
    try {
      c = JSON.parse(String(await $.fs.read(`${vp}/.wiki/config.json`))) ?? {};
    } catch {
      c = {};
    }
    configs.set(vp, c!);
  }
  return c!;
};

/** Debounced background rebuild after writes (the CLI is the single artefact writer). */
const rebuildTimers = new Map<string, { cancel(): void }>();
const scheduleRebuild = ($: EngineInterface, vp: string) => {
  rebuildTimers.get(vp)?.cancel();
  rebuildTimers.set(
    vp,
    $.clock.after(8000, () => {
      rebuildTimers.delete(vp);
      buildStarted.delete(vp);
      startBuild($, vp, "write");
    }),
  );
};

/** One "reindexed N notes" receipt per burst of writes (B25). */
let reindexedCount = 0;
let reindexedAt = 0;
const noteReindexed = ($: EngineInterface) => {
  const now = Date.now();
  reindexedCount = now - reindexedAt < 2000 ? reindexedCount + 1 : 1;
  reindexedAt = now;
  setBand($, { kind: "reindexed", text: `reindexed ${reindexedCount} note${reindexedCount === 1 ? "" : "s"}` });
  // One toast per 2 s burst, carrying the burst's final count (B25).
  if (reindexedCount === 1) {
    $.clock.after(2000, () => {
      try {
        // The band already says it; the activity log keeps it.
        notice($, `reindexed ${reindexedCount} note${reindexedCount === 1 ? "" : "s"}`, `A vault write was patched into the loaded graph (${reindexedCount} note${reindexedCount === 1 ? "" : "s"} in this burst); a background \`commonplace index\` follows.`, undefined, { card: false });
      } catch {}
    });
  }
};

/**
 * Patch one changed note into the loaded graph and its journal (plan §2.3b).
 * "sealed" when the note belongs to a shard this session has not opened — it
 * is not read, and the next CLI rebuild picks it up.
 */
const patchVaultFile = async (
  $: EngineInterface,
  vault: GuardVault,
  root: string,
  rel: string,
): Promise<"patched" | "sealed" | "skip"> => {
  const target = `${root}/${rel}`;
  const t0 = await $.clock.now();
  const idx = await getIndex($, vault.path, vault.domains);
  if (idx.state !== "ready" || !idx.manifest) return "skip";
  const cfg = await vaultConfig($, vault.path);
  // Shard first, from the path and domain map alone, so a sealed note's text
  // is never read. A note-level `scope: private` in a public folder can only
  // be seen after reading; it lands in `loose`, which the patch keeps sealed.
  const structureDirs = [cfg.structure?.concepts, cfg.structure?.mocs].filter((x): x is string => Boolean(x));
  const knownLoose = new Set(idx.manifest.knownLoose);
  const byPath = shardFor(rel, undefined, { domains: vault.domains, knownLoose, structureDirs });
  if (byPath !== "main" && !openOf(vault.path).has(byPath)) return "sealed";
  const text = String(await $.fs.read(target));
  const parsed = parseIndexNote(rel, text, {
    structure: cfg.structure,
    domainPaths: Object.values(vault.domains).map((d) => d.path ?? "").filter(Boolean),
  });
  const shard = shardFor(rel, parsed.fm.scope, { domains: vault.domains, knownLoose, structureDirs });
  if (shard !== "main" && !openOf(vault.path).has(shard)) return "sealed";
  const stub =
    parsed.kind === "concept" &&
    (Boolean(parsed.stubSentinel) || (cfg.abstractions === true && !(typeof parsed.fm.abstraction === "string" && parsed.fm.abstraction.trim())));
  let st: { mtimeMs?: number; size?: number } = {};
  try {
    st = await $.fs.stat(target);
  } catch {}
  await idx.patch(rel, journalNote(parsed, stub), { mt: Math.round(st.mtimeMs ?? 0), sz: st.size ?? text.length, shard });
  lastPatchMs = (await $.clock.now()) - t0;
  traceTo($, vault.path, "index:patch", { ms: lastPatchMs, shard: shard === "main" ? "main" : "private" });
  return "patched";
};

/** rel → mtime already patched by the sweep, per vault (reset when a rebuild lands). */
const swept = new Map<string, Map<string, number>>();
/** Above this many changed files a sweep hands the vault to the CLI rebuild. */
const SWEEP_MAX = 200;
let sweepTimer: { cancel(): void } | null = null;

/**
 * The 60 s sweep (plan §2.3c): notes changed OUTSIDE Claude (Obsidian, git,
 * sync) since the artefacts were built. One `find -newer manifest` per loaded
 * vault — cheap on any size of vault — then a patch per changed public note.
 * Sealed changes and large bursts go to the CLI, the single artefact writer.
 */
const sweep = async ($: EngineInterface) => {
  // The cached registry, never a refresh: GUARD_TTL_MS equals the period, so
  // loadGuard here respawned the registry CLI (~200 ms) on nearly every tick.
  // Tool calls keep the cache fresh; a cleared one just skips a tick.
  for (const vault of guardCache?.vaults ?? []) {
    const idx = indexes.get(vault.path);
    if (!idx || idx.state !== "ready") continue;
    try {
      const root = vault.path;
      const r = await $.process.run(findNotesArgv(root, `${root}/.wiki/graph/manifest.json`));
      if (r.exitCode !== 0) continue;
      const changed = String(r.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (changed.length > SWEEP_MAX) {
        startBuild($, vault.path, "sweep");
        continue;
      }
      const seen = swept.get(vault.path) ?? new Map<string, number>();
      swept.set(vault.path, seen);
      let n = 0;
      let sealed = false;
      for (const abs of changed) {
        const rel = abs.slice(root.length + 1);
        if (isExcluded(rel)) continue;
        let mt = 0;
        try {
          mt = Math.round((await $.fs.stat(abs)).mtimeMs ?? 0);
        } catch {
          continue;
        }
        if (seen.get(rel) === mt) continue;
        seen.set(rel, mt);
        const res = await patchVaultFile($, vault, root, rel);
        if (res === "patched") n++;
        if (res === "sealed") sealed = true;
      }
      // Only a sweep that acted is traced. An idle one fires every 60 s in
      // every session holding the index, and at 2000 kept lines those
      // heartbeats evicted every real decision from the log within hours.
      const compact = !sealed && (await idx.compactionDue());
      if (n > 0 || sealed || compact) {
        traceTo($, vault.path, "index:sweep", { changed: changed.length, patched: n, sealed });
      }
      if (sealed || compact) startBuild($, vault.path, sealed ? "sealed-change" : "compact");
    } catch {
      /* a failed sweep retries next period */
    }
  }
};

// ---------------------------------------------------------------------------
// Prime (plan §8). Module memory only: prompts and candidates may be private.
// ---------------------------------------------------------------------------

/** Prompt origins the prime lane serves (`sdk` so eval:prime runs the real gate under -p). */
const PRIME_ORIGINS = new Set(["composer", "bridge", "sdk"]);
let segment: SegmentState = freshSegment();
/** Notes primed or judged this session, per vault: never offered twice. */
const primeSeen = new Map<string, Set<number>>();
/** The latest turn.start, and the turns that have completed. */
let latestTurn: { turnId: string; text: string; at: number } | null = null;
const completedTurns = new Set<string>();
/** Consecutive infrastructure failures of the async lane (judge SKIPs do not count). */
let primeFailures = 0;
const PRIME_BREAKER = 3;

const seenOf = (vp: string) => {
  let s = primeSeen.get(vp);
  if (!s) primeSeen.set(vp, (s = new Set()));
  return s;
};

/**
 * The async lane (§8.2): wait for this prompt's turn, judge the candidate,
 * append the block mid-turn — or drop it if the turn is already over.
 */
const primeAsync = async (
  $: EngineInterface,
  p: { vault: GuardVault; vaultId: string; id: number; task: string; submittedAt: number },
) => {
  const vp = p.vault.path;
  try {
    // 1. This prompt's turn: the first turn.start after submission, ≤1 s.
    let turnId = "";
    for (let i = 0; i < 20 && !turnId; i++) {
      if (latestTurn && latestTurn.at >= p.submittedAt) turnId = latestTurn.turnId;
      else await $.clock.sleep(50);
    }
    if (!turnId) {
      traceTo($, vp, "prime:no-turn", {});
      return;
    }
    // 2. Card + note head.
    const idx = await getIndex($, vp, p.vault.domains);
    const card = (await idx.cards([p.id])).get(p.id);
    const rel = idx.view?.relOfId(p.id);
    if (!card || !rel || !isSafeVaultPath(rel)) return;
    const text = stripFrontmatter(String(await $.fs.read(`${vp}/${rel}`))).slice(0, PRIME_NOTE_CHARS);
    const shown = idx.view?.shard(p.id) === "main" ? rel : "private";
    // 3. Judge.
    const judgeStart = Date.now();
    const r = await $.model.complete({
      model: "haiku",
      maxTokens: 80,
      timeoutMs: PRIME_JUDGE_TIMEOUT_MS,
      system: PRIME_JUDGE_SYSTEM,
      prompt: PRIME_JUDGE_PROMPT(p.task, { title: card.t, abstraction: card.a }, text),
    } as CompletionRequest);
    const judgeMs = Date.now() - judgeStart;
    // No verdict is not a NO: logged apart, and the note stays eligible. An API
    // error counts toward the breaker; a timeout does not.
    if (!r.isAnswered) {
      if (r.reason === "api-error") primeFailures++;
      traceTo($, vp, "prime:unanswered", { reason: r.reason, ms: judgeMs });
      return;
    }
    primeFailures = 0;
    const why = parsePrimeVerdict(r.text);
    seenOf(vp).add(p.id);
    if (!why) {
      // The reply head is what tells a real NO from a parse miss; a private
      // note's is never logged.
      traceTo($, vp, "prime:judged-no", { path: shown, ms: judgeMs, ...(shown === "private" ? {} : { reply: String(r.text ?? "").slice(0, 60) }) });
      return;
    }
    // 4. Late? The turn ended, or the person already moved on.
    if (completedTurns.has(turnId) || latestTurn?.turnId !== turnId) {
      traceTo($, vp, "prime:late-drop", {});
      return;
    }
    const status = statusOnly(await noun.withRevisions(noun.toCard(card, { vaultId: p.vaultId, index: idx }), { index: idx }));
    const primed = primeBlock({ title: card.t, vault: p.vaultId, domain: card.d, abstraction: card.a, why, path: rel, status });
    await $.session.append({ message: { type: "user", content: [{ type: "text", text: primed }] } });
    witnessAdd($, "prime", primed);
    segment = { ...segment, touches: segment.touches + 1 };
    setBand($, { kind: "primed", text: `primed [[${card.t}]] — ${why}` });
    // The path is what eval:prime scores precision against; a private note's
    // is never written, even to the vault's own log (`shown`, above).
    traceTo($, vp, "prime:appended", { path: shown, readInTurn: !completedTurns.has(turnId) });
  } catch (err) {
    primeFailures++;
    traceTo($, vp, "prime:error", { n: primeFailures, err: String(err).slice(0, 80) });
  }
};

/** `CommonplaceIndexStatus` for a vault's loaded index (or absent). */
const indexStatus = (idx: VaultIndex | undefined) => {
  const m = idx?.manifest;
  return {
    state: (idx?.state === "ready" ? "ready" : "absent") as "ready" | "absent",
    version: m?.version ?? 0,
    journalSeq: idx?.view?.patchCount() ?? 0,
    nodes: m?.shards.main.nodes ?? 0,
    edges: m?.shards.main.edges ?? 0,
    builtAt: m?.builtAt ?? null,
    lastPatchMs: lastPatchMs,
  };
};
let lastPatchMs: number | null = null;

/** Audit line for a noun call: method + calling plugin, never arguments (they may name private notes). */
const traceNoun = ($: EngineInterface, ctx: { vaultPath?: string } | { error: string }, method: string, origin: string) => {
  if ("vaultPath" in ctx && ctx.vaultPath) traceTo($, ctx.vaultPath, `noun:${method}`, { origin });
};

// ---------------------------------------------------------------------------
// Surfaces: the connection and link-triage cards on the band, vault links and
// citation flags in replies, and the witness. Switches in plugin.json's
// userConfig, read once per load into `features`.
// ---------------------------------------------------------------------------

type Features = {
  ambient: boolean;
  prime: boolean;
  /** Clickable [[links]] in replies and the citation flags under them. */
  links: boolean;
  triage: boolean;
  /** Vault revision: trigger jobs, the review chain, accepts and their commits. */
  revision: boolean;
};

let features: Features = { ambient: true, prime: false, links: true, triage: false, revision: true };

/** What `/vault witness` shows: every hidden addition, word for word. */
const witness = new Witness();
const WITNESS_PANE = "commonplace-witness";
/** Bumped to redraw the witness pane; its content stays in module memory (it can quote an open private note). */
const paneRev = atom({ plugin: "commonplace", key: "paneRev" } as const, 0);
const bumpPanes = ($: EngineInterface) => {
  update($, paneRev, (n) => n + 1).catch(() => {});
};
const witnessAdd = ($: EngineInterface, kind: string, text: string) => {
  witness.add(kind, text, Date.now());
  bumpPanes($);
};

/**
 * A card on the band: one line plus the buttons that act on it. Module
 * memory, like `bandText` (a card can name an open private note); `$.state`
 * carries only the band's kind.
 */
type BandCard =
  | { kind: "connection"; vp: string; path: string; title: string; answer: string }
  | { kind: "triage"; vp: string; url: string; triage: Triage }
  | { kind: "notice"; entry: number };
let bandCard: BandCard | null = null;
const CARD_KINDS = new Set<string>(["connection", "triage", "notice"]);

const showCard = ($: EngineInterface, card: BandCard, text: string) => {
  bandCard = card;
  setBand($, { kind: card.kind, text });
};

/** The buttons each card offers, as [action, label]. */
const cardButtons = (card: BandCard): Array<[string, string]> => {
  if (card.kind === "connection") return [["read", "Read it"], ["not-for-me", "Not for me"]];
  if (card.kind === "notice") {
    const entry = vaultActivity.find((a) => a.id === card.entry);
    return entry?.revert && !entry.undone ? [["details", "Details"], ["undo", "Undo"]] : [["details", "Details"]];
  }
  return card.triage.verdict === "in-vault"
    ? [["read", "Read it"], ["skip", "Dismiss"]]
    : [["ingest", "Ingest"], ["later", "Later"], ["skip", "Skip"]];
};

/** `$.store` keys, per vault. */
const suppressedKey = (vp: string) => `connect:suppressed:${vp}`;
const laterKey = (vp: string) => `triage:later:${vp}`;
/** Not-for-me notes kept per vault. */
const SUPPRESSED_MAX = 500;

/**
 * A press on a connection card is a relevance label from real use: it goes
 * to `.wiki/evals/connection-feedback.jsonl` with the answer it was judged
 * against, which `eval:judge --feedback` scores the judge on. In the vault,
 * never committed, like every gold file.
 */
const recordLabel = ($: EngineInterface, card: Extract<BandCard, { kind: "connection" }>, label: string) => {
  const dir = `${card.vp}/.wiki/evals`;
  $.process
    .run(["mkdir", "-p", dir])
    .then(() =>
      $.process.run(["tee", "-a", `${dir}/connection-feedback.jsonl`], {
        stdin: `${JSON.stringify({ at: new Date().toISOString(), path: card.path, title: card.title, label, answer: card.answer })}\n`,
      }),
    )
    .catch(() => {});
};

/** One press on the band's card. The card is taken down first, so a second press does nothing. */
const bandPress = async ($: EngineInterface, action: string) => {
  const card = bandCard;
  if (!card) return;
  bandCard = null;
  try {
    await update($, band, (b) => ({ ...b, visible: false }));
  } catch {}
  try {
    if (card.kind !== "notice") showHeldNotice($);
    if (card.kind === "notice") {
      const entry = vaultActivity.find((a) => a.id === card.entry);
      if (action === "undo" && entry?.revert && !entry.undone) await undoRevision($, entry.revert.vp, entry.revert.event);
      if (action === "details" && !(await openActivity($)) && entry) {
        // No surface can seat the pane: the one line of detail it would have shown.
        $.ui.toast(entry.details.replace(/[*`]/g, "").slice(0, 240));
      }
      return;
    }
    if (card.kind === "connection") {
      const label = action === "read" ? "useful" : "not-for-me";
      traceTo($, card.vp, `feedback:${label}`, { path: card.path });
      recordLabel($, card, label);
      if (action === "read") {
        await $.prompt.submit({ text: `Read my vault note [[${card.title}]] and tell me how it bears on what we were just discussing.`, asUser: true });
      } else {
        const list = ((await $.store.get(suppressedKey(card.vp))) ?? []) as string[];
        await $.store.set(suppressedKey(card.vp), [...list.filter((p) => p !== card.path), card.path].slice(-SUPPRESSED_MAX));
        notice($, `won't surface [[${card.title}]] again`, `[[${card.title}]] was marked Not for me; the connection pass skips it from now on in this vault.`);
      }
      return;
    }
    traceTo($, card.vp, `triage:${action}`, { verdict: card.triage.verdict });
    if (action === "ingest") await $.prompt.submit({ text: `Add this to my vault: ${card.url}`, asUser: true });
    if (action === "read" && card.triage.note) {
      await $.prompt.submit({ text: `Read my vault note [[${card.triage.note}]] — it already covers ${card.url}. What does it say?`, asUser: true });
    }
    if (action === "later") {
      const list = ((await $.store.get(laterKey(card.vp))) ?? []) as LaterItem[];
      const t = card.triage;
      await $.store.set(laterKey(card.vp), addLater(list, { url: card.url, verdict: t.verdict, note: t.note, why: t.why, at: new Date().toISOString() }));
      notice($, "saved for later", `${card.url} saved. \`/vault later\` lists saved links.`);
    }
  } catch {
    /* a card is a convenience; a failed press must never surface as an error */
  }
};

/**
 * Links the person pasted, waiting for the turn they started to end, and the
 * ones that turn actually fetched. Only a fetched link is triaged: the fork
 * has no tools, so for a link nobody read it would judge the URL string.
 */
let pendingLinks: { urls: string[]; turnId: string; fetched: string[] } | null = null;

/**
 * Link triage at the end of the turn that answered a pasted link. Returns
 * true when a card went up (the ambient pass then sits this turn out).
 */
const runTriage = async ($: EngineInterface, vp: string, urls: string[], answer: string): Promise<boolean> => {
  const ctx = await nounCtx($);
  if ("error" in ctx || ctx.vaultPath !== vp) return false;
  const query = `${urls.map((u) => u.replace(/^https?:\/\/(www\.)?/i, "").replace(/[/._?=&#-]+/g, " ")).join(" ")} ${answer.slice(0, 600)}`;
  const r = await noun.search(ctx, { query: query.slice(0, 800), limit: 5 });
  const hits = "error" in r ? [] : r.hits;
  // The candidates are READ before anything is judged: a pointer is not a finding.
  const notes = [];
  for (const h of hits.slice(0, 3)) {
    const raw = await ctx.readNote(h.path);
    if (raw === null) continue;
    notes.push({ title: h.title, abstraction: h.abstraction, text: maskSealed(stripFrontmatter(raw), ctx.sealedNames).slice(0, TRIAGE_NOTE_CHARS) });
  }
  const f = await $.model.fork({ prompt: triagePrompt(urls, notes) });
  if (!f.isAnswered) {
    traceTo($, vp, "triage:unanswered", { reason: f.reason });
    return false;
  }
  const t = parseTriage(f.text, notes.map((n) => n.title));
  traceTo($, vp, "triage:verdict", { verdict: t?.verdict ?? "unparsed", candidates: notes.length });
  if (!t) return false;
  showCard($, { kind: "triage", vp, url: urls[0], triage: t }, triageLine(t, urls[0]));
  return true;
};

/**
 * A reply's text with its `[[links]]` made clickable and, under it, a flag
 * for each citation that does not hold up (not a note, not read this
 * session, superseded, contested). Null when the reply cites nothing or no
 * index is loaded: drawing never loads the graph. Sealed titles are left
 * exactly as written, neither linked nor flagged.
 */
const decorated = new Map<string, { text: string; cited: CitedNote[] } | null>();
const decorateReply = async ($: EngineInterface, text: string): Promise<{ text: string; cited: CitedNote[] } | null> => {
  if (!text.includes("[[")) return null;
  const vp = vaultPaths.get(String(await $.session.cwd())) ?? "";
  const idx = vp ? indexes.get(vp) : undefined;
  const view = idx?.state === "ready" ? idx.view : null;
  if (!vp || !idx || !view) return null;
  const trail = trailOf(vp);
  // Keyed by vault and text: the first verdict on a reply sticks. A note read
  // later must not clear the flag on a reply that cited it unread.
  const key = `${vp}|${text}`;
  if (decorated.has(key)) return decorated.get(key)!;
  const refs = wikiRefs(text);
  const open = openOf(vp);
  const sealed = new Set(
    (guardCache?.names ?? [])
      .filter((n) => n.vault === vp && n.shard !== PRIVATE_VAULT_SHARD && !open.has(n.shard))
      .flatMap((n) => [n.t, ...(n.al ?? [])])
      .map((s) => s.toLowerCase()),
  );
  const ids = new Map<string, number>();
  for (const r of refs) {
    const id = view.resolve(r.title);
    if (id !== null) ids.set(r.title.toLowerCase(), id);
  }
  const cards = await idx.cards([...ids.values()]);
  const cited: CitedNote[] = [];
  const hrefs = new Map<string, string>();
  for (const r of refs) {
    const k = r.title.toLowerCase();
    if (sealed.has(k)) continue;
    const id = ids.get(k);
    const card = id !== undefined ? cards.get(id) : undefined;
    const rel = id !== undefined ? view.relOfId(id) : undefined;
    if (id === undefined || !card || !rel) {
      cited.push({ title: r.title, status: "missing" });
      continue;
    }
    const full = await noun.withRevisions(noun.toCard(card, { vaultId: "", index: idx }), { index: idx });
    const href = fileHref(`${vp}/${rel}`);
    hrefs.set(k, href);
    cited.push({
      title: card.t,
      status: trail.has(id) ? "ok" : "unread",
      href,
      supersededBy: full.supersededBy,
      contestedBy: full.contestedBy,
    });
  }
  const linked = linkWikiRefs(text, (t) => hrefs.get(t.toLowerCase()) ?? null);
  const footer = citationFooter(cited);
  const out = { text: footer ? `${linked}\n\n${footer}` : linked, cited };
  decorated.set(key, out);
  if (decorated.size > 200) decorated.delete(decorated.keys().next().value as string);
  return out;
};

/** Per-conversation surface state, emptied at session.start and /clear. */
const resetSessionSurfaces = () => {
  bandCard = null;
  heldNotice = null;
  pendingLinks = null;
  witness.clear();
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  /**
   * The switches in plugin.json's `userConfig` (declaring it also stops the
   * host warning that options were requested against a manifest with none).
   * Guards are never optional. Absent reads as the default: on for what costs
   * no model call and adds no interruption — links, the band — and for the
   * ambient pass; off for triage (a fork per pasted link) and prime, which
   * ships off until `eval:prime` clears its gate (precision ≥ 80%,
   * false-prime ≤ 5%). Revision is on: it is the vault keeping itself, and
   * `vaultRevision: false` stops new jobs, model calls and commits.
   */
  const bandOn = options?.showBand !== false;
  features = {
    ambient: options?.ambientConnections !== false,
    prime: options?.primeContext === true,
    links: options?.vaultLinks !== false,
    triage: options?.linkTriage === true,
    revision: options?.vaultRevision !== false,
  };

  /**
   * Register the vault tools so they are listed by turn one.
   *
   * `session.start` is awaited before the first prompt, which is exactly why
   * registration belongs here rather than lazily: a tool the model cannot see
   * on its first turn may as well not exist.
   */
  on("session.start", async ($, e, next) => {
    startCwd = e.cwd;
    // A new session: scope starts from the start cwd again (signal 1).
    openShards.clear();
    sealedByClear = false;
    guardCache = null;
    resetSessionSurfaces();
    // The branch each vault is on now is the one this session commits to.
    pins.clear();
    void pickVault($)
      .then((v) => (v ? pinFor($, v.path) : ""))
      .catch(() => "");
    // MIN-BUILD GATE + WATCHDOG. Read the release defensively (an older engine
    // may lack `version()`); either way tell the shell watchdog
    // (scripts/session-check.ts) that the module ran, by resetting its counter.
    let base = "";
    try {
      base = (await $.session.version()).base ?? "";
    } catch {
      /* pre-2.1.288 engines: treat as too old */
    }
    const tooOld = !base || !releaseAtLeast(base, MIN_BUILD);
    try {
      const rt = `${$.plugin.root}/.runtime`;
      await $.process.run(["mkdir", "-p", rt]);
      await $.process.run(["tee", `${rt}/module-alive.json`], {
        stdin: JSON.stringify({ at: new Date().toISOString(), base, tooOld }),
      });
      await $.process.run(["tee", `${rt}/shell-sessions`], { stdin: "0" });
    } catch {
      /* the watchdog is advisory */
    }
    if (tooOld) {
      try {
        $.ui.toast(`commonplace needs Claude Code ${MIN_BUILD}+ (this is ${base || "older"}); vault tools are off.`);
      } catch {}
      return next(e);
    }
    for (const spec of TOOL_SPECS) {
      try {
        await $.tool.register(spec);
      } catch {
        /* registration is best-effort; the rest of the plugin still works */
      }
    }
    for (const cmd of VAULT_COMMANDS) {
      try {
        await $.command.register(cmd);
      } catch {
        /* commands are a convenience */
      }
    }
    try {
      // Warm the guard (registry, domains, private titles, open shards) so
      // the first guarded tool call does not pay for it.
      await loadGuard($);
    } catch {
      /* the guard loads lazily and fails open */
    }
    await showVaultStatus($);
    segment = freshSegment();
    // Load the active vault's graph off the critical path — and on a vault
    // with no v2 index yet, start the first build now, so it is usually done
    // before the first vault tool call (which waits for it if not). Prime
    // needs a warm graph too (skip-cold < 5%, §8.1).
    //
    // Only when this session is likely to use it: started inside a vault, or
    // prime on. Loading also arms the 60 s sweep, and every session on the
    // machine — any repo — was walking the vault every minute for nothing.
    // Anywhere else the first vault tool call loads it lazily.
    $.clock.after(e.isInteractive === false ? 0 : 1500, () => {
      (async () => {
        const cwd = String(await $.session.cwd());
        const { vaults } = await loadGuard($);
        const inVault = vaults.some((v) => cwd === v.path || cwd === v.real || locate([v], cwd));
        if (!inVault && !features.prime) return;
        const v = await pickVault($);
        if (v) await getIndex($, v.path, v.domains);
      })().catch(() => {});
    });
    // Ask about vault skills that are new or changed since trusted — with a
    // person at the prompt only; a `-p` run has nobody to ask.
    if (e.isInteractive) {
      // The promise is returned so a clock that waits on its callbacks (the
      // test kit's) waits for the question too.
      $.clock.after(2500, () => offerNewSkills($).catch(() => {}));
    }
    // Resolve the vault here, once, before the first turn. At Bash-tool prices
    // this was unthinkable and every hook had to lazily cache the answer; at
    // $.process.run prices it is ~46ms of session setup, so the later hooks
    // can simply read it.
    // Warm the cache before turn one so the first turn does not pay for it.
    // Correctness does not depend on this — every reader resolves lazily.
    try {
      const vp = await ensureVaultPath($, await $.session.cwd());

      // Rotate the trace log, once per session.
      //
      // Every guard and every connection pass appends a line to it and nothing
      // ever removed one, so a file that exists to be read by a human was on
      // its way to being too large for a human to read. Rotation belongs here
      // rather than at the append site: appends happen on the turn path and
      // must stay fire-and-forget, and a per-session trim is bounded work at a
      // moment when nothing is waiting.
      //
      // `tail | tee` as two execs, because $.process.run takes an argv and
      // runs NO shell — there is no pipe and no `>` to use. `tee` without
      // `-a` truncates, which is exactly the write half of a rotation.
      if (vp) {
        const logPath = `${vp}/.wiki/${LOG_FILE}`;

    // On the first turn in a vault: recover, enable, and drain whatever queued
    // jobs and pending revisions earlier sessions left. Then at most every
    // REVISION_REKICK_MS, so an accept deferred on a note the owner has since
    // committed by hand lands in this session, not the next.
    if (features.revision && Date.now() - (revisionKicked.get(vp) ?? -Infinity) >= REVISION_REKICK_MS) {
      revisionKicked.set(vp, Date.now());
      processRevision($, vp);
    }
        const kept = await $.process.run(["tail", "-n", String(LOG_KEEP_LINES), logPath]);
        if (kept.exitCode === 0) {
          const text = String(kept.stdout ?? "");
          // Only rewrite when the tail is actually shorter than the file, so
          // an ordinary session does not rewrite the log for nothing.
          const size = await $.process.run(["wc", "-l", logPath]);
          const lines = Number(String(size.stdout ?? "").trim().split(/\s+/)[0] ?? 0);
          if (lines > LOG_KEEP_LINES) {
            await $.process.run(["tee", logPath], { stdin: text });
          }
        }
      }
    } catch {
      /* no vault configured, or the CLI is unavailable; hooks degrade */
    }
    return next(e);
  });

  /**
   * Re-seal on `/clear` (P12: module memory survives it, and no
   * `session.start` follows). Scope must not outlive the conversation that
   * opened it; the next conversation re-opens with `/vault open`.
   */
  on("session.end", async ($, e, next) => {
    // Pending units are queued durably before the session goes; the next one processes them.
    try {
      const agents = new Set([...revisionWork.values()].map((w) => w.agentId));
      for (const a of agents) await flushRevisionWork($, a);
      // Then the ledger lines this session wrote after its last commit: one
      // commit, only when they grew, so none is left only on disk.
      for (const vp of revisionKicked.keys()) {
        const r = await revCli($, vp, ["ledger-commit"]);
        traceTo($, vp, "revision:ledger-commit", { status: String(r?.status ?? "error") });
      }
    } catch {}
    if (e.reason === "clear") {
      for (const shards of openShards.values()) shards.clear();
      sealedByClear = true;
      segment = freshSegment();
      resetSessionSurfaces();
    }
    return next(e);
  });

  /**
   * THE GUARD on the model's built-in file tools (plan §4.2a, §4.2, §2.3b).
   *
   * Three checks, in order, one registration (they share a matcher array):
   *   1. Sealing: no path argument may reach a sealed private-domain folder or
   *      `.wiki/sealed`; no recursive scan may root above one; no model write
   *      into `.wiki/skills|agents`.
   *   2. Leak: a write may not reproduce a private title where it must not
   *      go (outside the vault in a repository; across vaults; a link into
   *      another private group). Sealed titles get a deny that names nothing.
   *   3. Sanitise on the way down: a Write/Edit into a source note loses
   *      remote image embeds and over-length URLs BEFORE it lands, and the
   *      model is told what was removed. No file is rewritten afterwards.
   *
   * Global hook, so: it matches only concrete registered vault paths, logs
   * only calls that touch a vault (both branches), and FAILS OPEN — any
   * exception lets the call through.
   */
  on(
    "tool.call",
    // A RegExp, not an array: this build has no Grep/Glob/NotebookRead tools
    // (search goes through Bash), but a build or surface that does must
    // still be guarded, and the literal union refuses unknown names.
    { tool: /^(Read|Grep|Glob|NotebookRead|Bash|Write|Edit|NotebookEdit)$/ },
    async ($, e, next) => {
      const tool = String(e.tool);
      const input = e as unknown as Record<string, unknown>;
      let patched: Record<string, unknown> | null = null;
      let stripped: string[] = [];
      try {
        const t0 = await $.clock.now();
        const { vaults, names } = await loadGuard($);
        if (vaults.length === 0) return next(e);
        const cwd = String(await $.session.cwd());
        // From the environment: guessed from the cwd, `~` went unresolved in
        // any session started outside /Users or /home, and a `~/…` path into
        // a sealed folder read as a relative path that matched no root.
        // Its own catch: a host that refuses the read must cost the `~`
        // expansion only, never the whole guard (which fails open).
        if (homeDir === null) {
          try {
            homeDir = String((await $.env.get("HOME")) ?? "").replace(/\/+$/, "");
          } catch {
            homeDir = "";
          }
        }
        const home = homeDir || (cwd.match(/^\/(?:Users|home)\/[^/]+/)?.[0] ?? "");
        const touched = candidatePaths(tool, input, cwd, home)
          .map((c) => locate(vaults, c.path)?.vault.path ?? "")
          .find(Boolean);

        // 1. Sealing. Check the path as spelled and, for a single-path tool,
        // where it lands — a symlink into a sealed folder is still inside it.
        const roots = sealRootsFor(vaults, openOf);
        let verdict = checkSealedAccess(tool, input, roots, cwd, home);
        const fileArg = ["file_path", "notebook_path", "path"].find((k) => typeof input[k] === "string");
        if (!verdict && fileArg && tool !== "Bash") {
          try {
            const st = await $.fs.stat(String(input[fileArg]), { resolve: true });
            if (st.realPath) verdict = checkSealedAccess(tool, { ...input, [fileArg]: st.realPath }, roots, cwd, home);
          } catch {
            /* a file not there yet: the lexical check stands */
          }
        }
        if (touched || verdict) {
          traceTo($, touched || vaults[0].path, "guard:seal", {
            tool,
            decision: verdict ? "deny" : "allow",
            ms: (await $.clock.now()) - t0,
          });
        }
        if (verdict) return verdict;

        // A vault note opened with Read counts as read for the citation
        // check, exactly as vault_note does.
        if (tool === "Read" && touched && typeof input.file_path === "string" && input.file_path.endsWith(".md")) {
          const fp = normalizePath(input.file_path, cwd, home);
          const v = vaults.find((x) => x.path === touched);
          const root = fp.startsWith(`${touched}/`) ? touched : v?.real && fp.startsWith(`${v.real}/`) ? v.real : "";
          const id = root ? indexes.get(touched)?.view?.idOfRel(fp.slice(root.length + 1)) : undefined;
          if (id !== undefined) trailOf(touched).add(id);
        }

        // 2. Leak. Outside every vault the rule is about code repositories,
        // as before; inside a vault leakVerdict applies the one-way rules.
        if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
          const inVault = Boolean(touched);
          const repo = inVault ? null : await $.session.repo();
          if (inVault || repo) {
            const leak = leakVerdict(tool, input, vaults, names, openOf, cwd);
            if (touched || leak) {
              traceTo($, touched || vaults[0].path, "guard:leak", { tool, decision: leak ? "deny" : "allow" });
            }
            if (leak) return leak;
          }
        }

        // 3. Sanitise source-note writes on the way down.
        const clean = sanitizeWrite(tool, input, vaults, cwd);
        if (clean) {
          patched = { ...input, ...clean.patch };
          stripped = clean.stripped;
          traceTo($, touched || vaults[0].path, "guard:sanitize", { tool, stripped: stripped.length });
        }
      } catch {
        /* a broken guard must never block a tool call */
      }
      if (!patched) return next(e);
      const built = await next(patched as unknown as typeof e);
      if (!built || built.deny !== undefined) return built;
      const note =
        `Sanitized ${stripped.length} item(s) from this note's body before it was written:\n- ` +
        stripped.join("\n- ");
      witnessAdd($, "write sanitized", note);
      return { ...built, context: [...(built.context ?? []), note] };
    },
  );

  /**
   * Enforce the two CLAUDE.md rules that a model keeps breaking.
   *
   * Both exist as prose precisely BECAUSE they are violated often, and prose
   * has never stopped a violation. A deny with the correct path in its reason
   * turns each into a mechanism.
   *
   * Deliberately conservative: this hook is global, so a false positive blocks
   * real work in an unrelated repo. See lib/guard.ts for the matching rules
   * and their documented failure modes.
   */
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    try {
      const verdict = checkBashCommand(e.command) ?? checkScopeEscalation(e.command) ?? checkRevisionStep(e.command);
      if (verdict) return verdict;
    } catch {
      /* a broken guard must never block a command */
    }
    // `commonplace` CLI runs see the shards this session opened, exactly as
    // the vault tools do (legacy readers merge `sealed/legacy` rows by shard).
    let command = e.command;
    try {
      const vault = await pickVault($);
      const shards = vault ? [...openOf(vault.path)] : [];
      // `commonplace commit` / `revise`: run here, for this agent's unit of
      // work, with its identity and the pinned branch in the environment. The
      // command text is left exactly as written, so an allowlist entry for it
      // still matches (see ownCommand).
      if (vault && chainedCommit(e.command)) {
        traceTo($, vault.path, "unit:command", { cmd: "commit", denied: "chained" });
        return { deny: CHAINED_COMMIT_DENY };
      }
      const own = vault ? ownCommand(e.command) : null;
      if (own && vault) {
        const u = await unitFor($, e.agentId, vault.path);
        const env = { ...unitEnv(u, await pinFor($, vault.path)), COMMONPLACE_OPEN: shards.filter((s) => /^[A-Za-z0-9_.-]+$/.test(s)).join(",") };
        const base = await $.session.cwd();
        const cwd = own.cd ? (own.cd.startsWith("/") ? own.cd : `${base}/${own.cd}`) : base;
        const r = await $.process.run(["node", `${$.plugin.root}/bin/commonplace`, ...own.args], { cwd, env, timeoutMs: 300_000 });
        let stdout = String(r.stdout ?? "");
        let stderr = String(r.stderr ?? "");
        if (own.mergeStderr && stderr) {
          stdout += stderr;
          stderr = "";
        }
        if (r.exitCode) stderr += `${stderr ? "\n" : ""}(exit ${r.exitCode})`;
        // A successful commit closes the unit: its trigger job is queued now,
        // not after the debounce, and the agent's next write opens a new one.
        if (own.args[0] === "commit" && r.exitCode === 0 && /Committed \d+ file|Nothing to commit/.test(stdout)) {
          await flushRevisionWork($, e.agentId);
          units.delete(agentKey(e.agentId));
          // An accept deferred on this unit's uncommitted note can land now.
          processRevision($, vault.path);
        }
        traceTo($, vault.path, "unit:command", { cmd: own.args.slice(0, 2).join(" "), exit: r.exitCode });
        return { result: { stdout, stderr, interrupted: false } };
      }
      command = withOpenShards(command, shards);
    } catch {
      /* fall through unchanged */
    }
    return next(command !== e.command ? { ...e, command } : e);
  });

  /**
   * After a vault write lands: patch the in-memory graph and append ONE
   * journal line (plan §2.3b), then run the read-only analysis CLI and hand
   * its notes back as the tool result's hidden `context`.
   *
   * The module is the index writer for single files now: the graph patch is
   * ~1–3 ms and visible to every vault tool immediately. A debounced
   * background `commonplace index` keeps the legacy jsonl and the artefacts
   * current (single writer under its lock). A note in a SEALED shard is never
   * parsed here — the guard denies those writes, and an open one is journaled
   * to its own shard only.
   */
  on("tool.call", { tool: ["Write", "Edit"] }, async ($, e, next) => {
    // The blob BEFORE the write, for the agent's unit of work: taken here,
    // ahead of `next`, because afterwards the old content is gone. `-w`
    // stores it so the unit can name it later. Outside a git repo the call
    // fails and the write simply is not part of any unit.
    let before: string | null | undefined;
    try {
      const target = e.file_path;
      if (target && target.endsWith(".md")) {
        const { vaults } = await loadGuard($);
        const vault = vaults.find((v) => target.startsWith(`${v.path}/`) || (v.real && target.startsWith(`${v.real}/`)));
        if (vault && !isExcluded(target.slice((target.startsWith(`${vault.path}/`) ? vault.path : vault.real!).length + 1))) {
          const st = await $.fs.stat(target).catch(() => null);
          if (!st) before = null;
          else {
            const h = await $.process.run(["git", "-C", vault.path, "hash-object", "-w", "--", target], { timeoutMs: 5_000 });
            const blob = String(h.stdout ?? "").trim();
            if (h.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(blob)) before = blob;
          }
        }
      }
    } catch {
      before = undefined;
    }
    const built = await next(e);
    try {
      if (!built || built.deny !== undefined || built.isError) return built;
      const target = e.file_path;
      if (!target || !target.endsWith(".md")) return built;
      const { vaults } = await loadGuard($);
      const vault = vaults.find((v) => target.startsWith(`${v.path}/`) || (v.real && target.startsWith(`${v.real}/`)));
      if (!vault) return built;
      const root = target.startsWith(`${vault.path}/`) ? vault.path : vault.real!;
      const rel = target.slice(root.length + 1);
      if (isExcluded(rel)) return built;
      noteWrite($, vault.path, rel, e.agentId);

      if ((await patchVaultFile($, vault, root, rel)) === "patched") noteReindexed($);
      scheduleRebuild($, vault.path);

      const unitArgs: string[] = [];
      if (before !== undefined) {
        const u = await unitFor($, e.agentId, vault.path);
        unitArgs.push("--unit", u.id, "--actor", u.actor, "--session", u.session, "--before", before ?? "none");
      }
      const res = await $.process.run(
        ["node", `${$.plugin.root}/bin/commonplace`, "post-write", "--no-index", "--vault", vault.path, ...unitArgs],
        { stdin: JSON.stringify({ file_path: target }), timeoutMs: 120_000 },
      );
      const out = String(res.stdout ?? "").trim();
      if (!out) return built;
      const notes = String(JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? "");
      if (!notes) return built;
      witnessAdd($, "post-write analysis", notes);
      return { ...built, context: [...(built.context ?? []), notes] };
    } catch {
      /* the write already succeeded; its follow-up must never undo that */
    }
    return built;
  });

  /**
   * The vault tools (plan §5), answered from the in-module graph.
   *
   * One regex-matched hook for every `mcp__commonplace__vault_*` tool. The
   * methods behind it are the same `impl` functions the `$.commonplace` noun
   * hooks call, so a foreign hook on our noun events never sits between the
   * model's tool call and our data. Recoverable failures are `ERROR: …`
   * results; only policy refusals are `{ deny }`.
   */
  /**
   * A whole vault note read with the built-in Read tool counts as read for
   * the revision trigger, and a note whose claims were revised says so beside
   * the text — the reader should not have to call another tool to learn that
   * a sentence it is about to rely on was corrected.
   */
  on("tool.call", { tool: "Read" }, async ($, e, next) => {
    const r = await next(e);
    try {
      if (r.deny !== undefined || r.isError) return r;
      const target = String(e.file_path ?? "");
      if (!target.endsWith(".md")) return r;
      const { vaults } = await loadGuard($);
      const vault = vaults.find((v) => target.startsWith(`${v.path}/`) || (v.real && target.startsWith(`${v.real}/`)));
      if (!vault) return r;
      const rel = target.slice((target.startsWith(`${vault.path}/`) ? vault.path : vault.real!).length + 1);
      if (isExcluded(rel)) return r;
      const whole = (e as { offset?: number }).offset === undefined && (e as { limit?: number }).limit === undefined;
      if (whole) await noteRead($, vault.path, rel, e.agentId);
      const idx = indexes.get(vault.path);
      const id = idx?.state === "ready" ? idx.view?.idOfRel(rel) : undefined;
      if (!idx || id === undefined || !idx.view?.visible(id)) return r;
      // Counts toward the citation check's "read this session".
      trailOf(vault.path).add(id);
      const card = (await idx.cards([id])).get(id);
      if (!card) return r;
      const status = statusOnly(await noun.withRevisions(noun.toCard(card, { vaultId: "", index: idx }), { index: idx }));
      if (status.length === 0) return r;
      const note = `Revision status of [[${card.t}]]:\n${status.join("\n")}`;
      witnessAdd($, "Read note", note);
      return { ...r, context: [...(r.context ?? []), note] };
    } catch {
      return r;
    }
  });

  /** Link triage: a pasted link this turn fetched is one the fork can judge. */
  on("tool.call", { tool: "WebFetch" }, async (_$, e, next) => {
    const r = await next(e);
    try {
      const p = pendingLinks;
      const code = Number((r as { result?: { code?: unknown } }).result?.code ?? 0);
      const url = p && code >= 200 && code < 300 ? p.urls.find((u) => sameUrl(u, e.url)) : undefined;
      if (p && url && !p.fetched.includes(url)) pendingLinks = { ...p, fetched: [...p.fetched, url] };
    } catch {}
    return r;
  });

  on("tool.call", { tool: /^mcp__commonplace__vault_/ }, async ($, e, next) => {
    const name = String(e.tool).replace(/^mcp__commonplace__/, "");
    const arg = (k: string) => toolArg(e, k);
    const t0 = await $.clock.now();
    update($, activity, () => ({ tool: name, startedAt: t0 }));
    try {
      if (name === "vault_skill") {
        const out = await impl_skill($, { name: arg("name") as string | undefined, vault: arg("vault") as string | undefined });
        return { result: out };
      }
      const ctx = await nounCtx($, arg("vault") as string | undefined);
      if ("error" in ctx) return { result: `ERROR: ${ctx.error}` };
      const vp = ctx.vaultPath;
      let result = "";
      let context: string[] | undefined;
      let summary = "";
      // What hook-log gets; a private note's title stays out of it.
      let logSummary: string | null = null;
      if (name === "vault_search") {
        const query = String(arg("query") ?? "");
        const r = await noun.search(ctx, {
          query,
          limit: Number(arg("limit") ?? 8),
          offset: Number(arg("offset") ?? 0),
          domain: arg("domain") as string | undefined,
        });
        result = "error" in r ? `ERROR: ${r.error}` : formatSearch(r, query);
        summary = "error" in r ? "error" : `${r.hits.length} pointers`;
      } else if (name === "vault_note") {
        const ref = String(arg("note") ?? "");
        const r = await noun.note(ctx, { ref, maxChars: Number(arg("maxChars") ?? 40000) });
        if ("error" in r) {
          result = `ERROR: ${r.error} Use a path from vault_search.`;
          summary = "no match";
        } else {
          result = formatNote(r);
          trailOf(vp).add(r.card.id);
          await noteRead($, vp, r.card.path, e.agentId);
          const hint = unreadContext(r);
          if (hint) context = [hint];
          summary = r.card.title;
          logSummary = r.card.isPrivate ? "private" : r.card.title;
          setBand($, { kind: "following", text: `read [[${r.card.title}]]` });
        }
      } else if (name === "vault_links") {
        const note = String(arg("note") ?? "");
        const direction = (arg("direction") as "out" | "in" | "both" | undefined) ?? "both";
        const r = await noun.links(ctx, {
          note,
          direction,
          kinds: arg("kinds") as never,
          limit: Number(arg("limit") ?? 20),
        });
        result = "error" in r ? `ERROR: ${r.error} Use a path from vault_search.` : formatLinks(r, direction);
        summary = "error" in r ? "no match" : `${r.links.length} links`;
        if (!("error" in r)) setBand($, { kind: "following", text: `following links of [[${r.card.title}]] · ${r.links.length}` });
      } else if (name === "vault_path") {
        const from = String(arg("from") ?? "");
        const to = String(arg("to") ?? "");
        const maxHops = Number(arg("maxHops") ?? 4);
        const r = await noun.path(ctx, { from, to, maxHops, avoidHubs: arg("avoidHubs") !== false });
        result = "error" in r ? `ERROR: ${r.error}` : formatPath(r, from, to, maxHops);
        summary = "error" in r ? "no match" : r.path ? `${r.path.length} hops` : "no path";
        if (!("error" in r) && r.path) {
          setBand($, { kind: "following", text: `path [[${from}]] → [[${to}]] · ${r.path.length} hops` });
        }
      } else if (name === "vault_neighbourhood") {
        const seeds = (Array.isArray(arg("seeds")) ? (arg("seeds") as unknown[]) : [arg("seeds")]).map(String).filter(Boolean);
        const r = await noun.neighbourhood(ctx, { seeds, k: Number(arg("k") ?? 12) });
        result = "error" in r ? `ERROR: ${r.error}` : formatNeighbourhood(r, seeds);
        summary = "error" in r ? "no match" : `${r.pool.length} related`;
      } else if (name === "vault_lineage") {
        const ref = arg("note") ? String(arg("note")) : undefined;
        let rel: string | undefined;
        if (ref) {
          const nr = await noun.note(ctx, { ref, maxChars: 1 });
          if ("error" in nr) return { result: `ERROR: ${nr.error} Use a path from vault_search.` };
          rel = nr.card.path;
          logSummary = nr.card.isPrivate ? "private" : nr.card.title;
        }
        const out = await revCli($, vp, ["log", ...(rel ? ["--note", rel] : []), "--limit", String(Number(arg("limit") ?? 15) || 15)]);
        const rows = Array.isArray(out?.rows) ? (out!.rows as LineageRow[]) : [];
        result = out === null ? "ERROR: the revision log could not be read." : maskSealed(formatLineage(rows, ref), ctx.sealedNames);
        summary = `${rows.length} revisions`;
      } else if (name === "vault_list") {
        const what = String(arg("what") ?? "domains") as "domains" | "mocs" | "recent" | "stubs" | "vaults";
        const r = await noun.list(ctx, { what, limit: Number(arg("limit") ?? 50) }, await listExtras($, ctx, what));
        result = formatList(r, what);
        summary = `${r.items.length} ${what}`;
      } else {
        return next(e);
      }
      const ms = (await $.clock.now()) - t0;
      lastTool = { tool: name, summary, ms };
      const subject =
        name === "vault_search" ? `"${String(arg("query") ?? "")}"`
        : name === "vault_path" ? `[[${String(arg("from") ?? "")}]] → [[${String(arg("to") ?? "")}]]`
        : name === "vault_neighbourhood" ? ((arg("seeds") as string[] | undefined) ?? []).map((x) => `[[${x}]]`).join(", ")
        : name === "vault_list" ? String(arg("what") ?? "")
        : arg("note") ? `[[${String(arg("note"))}]]` : "";
      const tid = (e as { tool_use_id?: string }).tool_use_id;
      if (tid) {
        toolRows.set(tid, { tool: name, subject, summary, ms, error: result.startsWith("ERROR:") });
        if (toolRows.size > 200) toolRows.delete(toolRows.keys().next().value as string);
      }
      traceTo($, vp, `tool:${name}`, { summary: logSummary ?? (summary.startsWith("[[") ? "" : summary), ms });
      if (context) for (const c of context) witnessAdd($, `${name} note`, c);
      return context ? { result, context } : { result };
    } catch (err) {
      return { result: `ERROR: commonplace vault tool failed: ${String(err).slice(0, 200)}` };
    } finally {
      update($, activity, () => null);
    }
  });

  /**
   * Equip vault-research dispatches instead of refusing them.
   *
   * `agent.spawn` fires before the subagent resolves and may rewrite `prompt`,
   * which is a strictly better lever than v1's PreToolUse deny
   * (`agent-guard`, removed in v2): the dispatch proceeds, carrying instructions to
   * use `vault_search`/`vault_note` and the doctrine that pointers are not
   * findings. Nothing is blocked, so nothing needs `ALLOW_VAULT_AGENT`.
   *
   * Order matters for cost: the free checks (fork, agent type, marker match)
   * run before the classify, so an ordinary dispatch in an unrelated repo
   * spends nothing. See lib/agent.ts on why that marker check is allowed to be
   * loose — it gates a model call, not a decision.
   */
  on("agent.spawn", async ($, e, next) => {
    try {
      if (!isSteerableSpawn(e.subagentType, e.fork)) {
        return next(e);
      }
      const prompt = e.prompt;
      if (!prompt) return next(e);

      const projectDir = await $.session.cwd();
      const vaultPath = await ensureVaultPath($, projectDir);
      // No vault on this machine means nothing to steer toward.
      if (!vaultPath) return next(e);
      if (!looksVaultShaped(prompt, vaultPath)) return next(e);

      const verdict = await $.model.classify(
        SPAWN_CLASSIFY_PROMPT(prompt),
        SPAWN_LABELS,
      );
      // Only research is steered. Orchestrated WORK over many notes is a
      // legitimate pattern whose prompts carry the same vocabulary — telling
      // those two apart is the thing a regex could never do, and the reason
      // the old guard needed an escape hatch.
      if (verdict !== "vault-research") return next(e);

      const steered = steerPrompt(prompt);
      witnessAdd($, "subagent prompt rewritten (added ahead of its task)", steered.slice(0, steered.length - prompt.length));
      return next({ ...e, prompt: steered });
    } catch {
      /* steering is advisory; a broken hook must never block a dispatch */
    }
    return next(e);
  });

  /**
   * Steer vault research away from ad-hoc subagents, at the point of decision.
   *
   * v1's `agent-guard` shell hook DENIED an Agent dispatch after the model
   * had already composed a vault-shaped prompt — a post-hoc refusal over a
   * regex, which over-fired often enough that it needed the
   * `ALLOW_VAULT_AGENT` escape hatch. Amending the tool's own description
   * steers before the wrong dispatch is composed; `agent.spawn` above equips
   * the ones that are composed anyway. v2 removed the deny.
   *
   * Deliberately additive. The engine caches rendered schemas for the session,
   * so this costs one string concatenation per session, not per call.
   */
  /** `/vault …` — the person's commands (plan §6.2). */
  on("command.run", { command: "vault" }, async ($, e, next) => {
    try {
      const out = await runVaultCommand($, e.args ?? "");
      for (const c of out.context ?? []) witnessAdd($, "/vault command", c);
      return out;
    } catch (err) {
      return { text: `commonplace: /vault failed — ${String(err).slice(0, 200)}` };
    }
  });

  // -------------------------------------------------------------------------
  // `$.commonplace` — the noun other plugins build on (plan §2.2, §2.2a).
  //
  // engine.create adds INERT stubs (a stub runs only if our hook throws); every
  // method is answered by commonplace's own `commonplace.<method>` hook below,
  // with `$` live and `next.origin.plugin` naming the caller for the audit
  // log. Scope is applied inside each method, so a hook another plugin puts
  // above ours sees only already-filtered values: it can narrow, never widen.
  // -------------------------------------------------------------------------
  on("engine.create", async ($, e, next) => {
    const built = await next(e);
    return { ...built, commonplace: NOUN_STUBS };
  });

  on("commonplace.version", async ($, e, next) => ({ value: { apiVersion: 1 as const, plugin: String($.plugin.name) } }));

  on("commonplace.vaults", async ($, e, next) => {
    const { vaults } = await loadGuard($);
    const active = await pickVault($);
    const out = [];
    for (const v of vaults) {
      if (v.isPrivate && v.path !== active?.path) continue;
      out.push({
        id: v.id ?? "",
        label: v.label ?? "",
        path: v.path,
        aliases: v.aliases ?? [],
        isDefault: false,
        isActive: v.path === active?.path,
        isPrivate: v.isPrivate === true,
        index: indexStatus(indexes.get(v.path)),
      });
    }
    return { value: out };
  });

  on("commonplace.activeVault", async ($, e, next) => {
    const v = await pickVault($);
    if (!v) return { value: null };
    return {
      value: {
        id: v.id ?? "",
        label: v.label ?? "",
        path: v.path,
        aliases: v.aliases ?? [],
        isDefault: false,
        isActive: true,
        isPrivate: v.isPrivate === true,
        index: indexStatus(indexes.get(v.path)),
      },
    };
  });

  on("commonplace.scope", async ($, e, next) => {
    const v = await pickVault($, e?.vault);
    return { value: { vault: v?.id ?? "", openCount: v ? openOf(v.path).size : 0 } };
  });

  on("commonplace.status", async ($, e, next) => {
    const v = await pickVault($, e?.vault);
    if (!v) return { value: indexStatus(undefined) };
    await getIndex($, v.path, v.domains).catch(() => null);
    return { value: indexStatus(indexes.get(v.path)) };
  });

  on("commonplace.reindex", async ($, e, next) => {
    const v = await pickVault($, e.vault);
    if (v) {
      buildStarted.delete(v.path);
      startBuild($, v.path, `noun:${next.origin.plugin}`);
    }
    return { value: indexStatus(v ? indexes.get(v.path) : undefined) };
  });

  on("commonplace.search", async ($, e, next) => {
    const ctx = await nounCtx($, e.vault);
    traceNoun($, ctx, "search", next.origin.plugin);
    if ("error" in ctx) return { value: { hits: [], vault: "", tookMs: 0 } };
    const r = await noun.search(ctx, e);
    return { value: "error" in r ? { hits: [], vault: ctx.vaultId, tookMs: 0 } : r };
  });

  on("commonplace.note", async ($, e, next) => {
    const ctx = await nounCtx($, e.vault);
    traceNoun($, ctx, "note", next.origin.plugin);
    if ("error" in ctx) return { value: { error: ctx.error } };
    return { value: await noun.note(ctx, e) };
  });

  on("commonplace.links", async ($, e, next) => {
    const ctx = await nounCtx($, e.vault);
    traceNoun($, ctx, "links", next.origin.plugin);
    if ("error" in ctx) return { value: { error: ctx.error } };
    return { value: await noun.links(ctx, e) };
  });

  on("commonplace.path", async ($, e, next) => {
    const ctx = await nounCtx($, e.vault);
    traceNoun($, ctx, "path", next.origin.plugin);
    if ("error" in ctx) return { value: { error: ctx.error } };
    return { value: await noun.path(ctx, e) };
  });

  on("commonplace.neighbourhood", async ($, e, next) => {
    const ctx = await nounCtx($, e.vault);
    traceNoun($, ctx, "neighbourhood", next.origin.plugin);
    if ("error" in ctx) return { value: { error: ctx.error } };
    return { value: await noun.neighbourhood(ctx, e) };
  });

  on("commonplace.list", async ($, e, next) => {
    const ctx = await nounCtx($, e.vault);
    traceNoun($, ctx, "list", next.origin.plugin);
    if ("error" in ctx) return { value: { items: [] } };
    return { value: await noun.list(ctx, e, await listExtras($, ctx, e.what)) };
  });

  on("commonplace.skills", async ($, e, next) => {
    const v = await pickVault($, e?.vault);
    if (!v) return { value: [] };
    const skills = await loadVaultSkills($, v);
    return { value: skills.map((s) => ({ name: s.name, description: s.description, vault: v.id ?? "", trusted: s.trusted })) };
  });

  on("commonplace.skill", async ($, e, next) => {
    const v = await pickVault($, e.vault);
    if (!v) return { value: { error: "no vault configured" } };
    const s = (await loadVaultSkills($, v)).find((x) => x.name === e.name);
    if (!s || !s.trusted) return { value: { error: `no trusted vault skill named "${e.name}"` } };
    return { value: { name: s.name, description: s.description, vault: v.id ?? "", trusted: true, text: s.body } };
  });

  /**
   * Deferral, answered explicitly for every vault tool (P2: plugin tools are
   * deferred by default). vault_search and vault_note are the front door and
   * are pinned into every prompt; the rest are found through ToolSearch by
   * their keyword-led descriptions. Stable answers, so no prompt-cache churn.
   */
  on("tool.describe", { tool: /^mcp__commonplace__vault_/ }, async ($, e, next) => {
    const built = await next(e);
    const short = String(e.tool).replace(/^mcp__commonplace__/, "");
    return { ...built, isDeferred: !PINNED_TOOLS.has(short) };
  });

  on("tool.describe", { tool: "Agent" }, async ($, e, next) => {
    const built = await next(e);
    try {
      return {
        description:
          `${built.description}\n\n` +
          "For the user's commonplace knowledge vault, do NOT dispatch a " +
          "general-purpose agent to search it: call mcp__commonplace__vault_search " +
          "for pointers and mcp__commonplace__vault_note to read one, or use the " +
          "wiki-query skill for a question needing iterative search and graph " +
          "traversal. Dispatching agents to edit many notes in parallel is still " +
          "a legitimate use of this tool.",
      };
    } catch {
      return built;
    }
  });

  /**
   * Give the vault skills their live state instead of making them fetch it.
   *
   * Every wiki-* skill opens by resolving the vault path and reading config,
   * which is a round-trip the plugin can simply answer — and a class of bug
   * ("the skill forgot to resolve the vault") that then cannot happen.
   */
  on("skill.prompt", async ($, e, next) => {
    const built = await next(e);
    try {
      const skill = e.skill;
      // The static `vault-skill` carries a vault skill's name and arguments in
      // its text; the body is swapped for the trusted skill's own (plan §7.3).
      // `$.prompt.submit` is refused inside command.run, so this is the path.
      if (skill.includes("vault-skill")) {
        const m = /Run the vault skill named in:\s*(\S+)\s*([\s\S]*?)\n\n/.exec(built.text);
        if (!m) return built;
        const vault = await pickVault($);
        if (!vault) return built;
        const s = (await loadVaultSkills($, vault)).find((x) => x.name === m[1]);
        if (!s) return { text: `${built.text}\n\n(No vault skill named "${m[1]}" is visible in this session.)` };
        if (!(await askTrust($, vault, s))) return { text: `The user has not trusted vault skill "${s.name}". Do not follow it; tell them they can trust it with /vault skills trust ${s.name}.` };
        traceTo($, vault.path, "skill:delivered", { trusted: true });
        const swapped = skillBlock(s, vault.id ?? "vault", m[2].trim());
        witnessAdd($, `vault skill "${s.name}" (replaces the vault-skill body)`, swapped);
        return { text: swapped };
      }
      // `includes`, not `startsWith`: it is not established whether a plugin
      // skill arrives bare (`wiki-query`) or namespaced
      // (`commonplace:wiki-query`). Under `startsWith` the namespaced form
      // never matches and this hook is silently inert — a failure with no
      // symptom. Verify the real shape when the API is documented, then
      // tighten. `wiki-` is distinctive enough that the loose match is safe.
      if (!skill.includes("wiki-") && !skill.includes("autoimprove")) return built;

      const projectDir = await $.session.cwd();
      const vaultPath = await ensureVaultPath($, projectDir);
      if (!vaultPath) return built;

      const counts = indexes.get(vaultPath)?.manifest
        ? ` Its graph index holds ${indexes.get(vaultPath)!.manifest!.shards.main.nodes} public notes.`
        : "";

      const preamble =
        `The commonplace vault for this session is at ${vaultPath}.${counts} ` +
        "It is already resolved — do not run `commonplace vault-path` or " +
        "search for it.";
      witnessAdd($, `skill preamble (${skill})`, preamble);
      return { text: `${preamble}\n\n${built.text}` };
    } catch {
      return built;
    }
  });

  /**
   * The vault's orienting block on the conversation's first user message.
   *
   * Replaced v1's `prompt-context` script, a shell hook wired to
   * UserPromptSubmit — which meant a `node` cold start on EVERY PROMPT to
   * re-count three index files and inject ~800 words mid-transcript. This
   * fires ONCE PER CONVERSATION and lands as a real context block, so it is
   * both far cheaper and in the right place. `$.ui.invalidate("prompt.context")`
   * re-runs it when the vault actually changes.
   */
  on("prompt.context", async ($, e, next) => {
    const built = await next(e);
    try {
      // `session.start` already resolved this, once, in ~46ms. The elaborate
      // negative cache that used to live here existed only because the old
      // Bash-tool resolve cost 7.3s on the critical path before the first
      // model turn; at process.run prices there is nothing to amortise.
      const projectDir = await $.session.cwd();
      const vaultPath = await ensureVaultPath($, projectDir);
      if (!vaultPath) return built;

      const inVault = projectDir.startsWith(`${vaultPath}/`) || projectDir === vaultPath;

      // Counts are only rendered for the in-vault block, so outside the vault
      // this skips three index reads whose result was discarded.
      //
      // `wc -l` rather than reading and parsing: the count is all that is
      // wanted, and it is exact. Reading the file through the Read tool gave a
      // count capped near 48KB — a 347-concept index reported as 114, a wrong
      // number stated confidently, which is worse than no number.
      // Count lines per record kind with grep -c on the line prefix: exact,
      // and no parse. Pre-v2 vaults still have the three v1 index files.
      const count = async (args: string[]) => {
        const res = await $.process.run(args);
        return Number(String(res?.stdout ?? "").trim().split(/\s+/)[0] ?? 0) || 0;
      };
      const records = `${vaultPath}/.wiki/graph/records.jsonl`;
      const v2 = inVault && (await $.process.run(["test", "-f", records])).exitCode === 0;
      const readCount = (kind: "source" | "concept" | "moc") =>
        v2
          ? count(["grep", "-c", `^{"k":"${kind}"`, records])
          : count(["wc", "-l", `${vaultPath}/.wiki/${kind}-index.jsonl`]);
      const sources = inVault ? await readCount("source") : 0;
      const concepts = inVault ? await readCount("concept") : 0;
      const mocs = inVault ? await readCount("moc") : 0;

      // Untuned genres are actionable state: genre-aware lint checks do not
      // apply until rules exist, and nothing else surfaces that.
      let untunedGenres: string[] = [];
      if (inVault) try {
        const convRes = await $.process.run([
          "cat", `${vaultPath}/.wiki/conventions.json`,
        ]);
        type Genre = { name?: unknown; rules?: Record<string, unknown> | null };
        const conv: { genres?: Genre[] } = JSON.parse(convRes.stdout || "{}");
        untunedGenres = (conv.genres ?? [])
          .filter((g) => !g?.rules || Object.keys(g.rules).length === 0)
          .map((g) => String(g?.name ?? ""))
          .filter(Boolean);
      } catch {
        /* conventions.json not written yet; not an error */
      }

      const block = buildVaultBlock({
        vaultPath,
        inVault,
        sources,
        concepts,
        mocs,
        untunedGenres,
      });
      if (block) witnessAdd($, `first-message block "${block.name}"`, block.text);
      return { blocks: mergeBlocks(built.blocks ?? [], block) };
    } catch {
      // A broken vault must never cost the user their context block set.
      return built;
    }
  });

  /**
   * Clear the status band the moment the user starts another turn.
   *
   * The band is a receipt for work the vault just did, not a dashboard. Left
   * up across turns it becomes furniture: permanently present, therefore never
   * read, and occupying a line of screen for a feature that fires rarely.
   *
   * Must pass the prompt through untouched — a hook that returns anything but
   * `next(e)` here can rewrite or drop what the user typed.
   */
  on("prompt.submit", async ($, e, next) => {
    // No `$.ui.invalidate`: the band's render read subscribed it to this
    // state, so the write alone redraws it.
    // Except an open private scope, which re-announces every turn (§9.7): a
    // reminder that persists only while it is true is not furniture.
    try {
      const vault = await pickVault($);
      const open = vault ? [...openOf(vault.path)].filter((x) => x !== "loose" && x !== "quarantine") : [];
      if (open.length) {
        setBand($, { kind: "open", text: `open: ${open.join(" + ")} · /vault close to seal` });
      } else if ((await read($, band)).visible) {
        await update($, band, (b) => ({ ...b, visible: false }));
      }
      // A card unanswered when the person types again is a pass, not a press.
      bandCard = null;
      if (!open.length) showHeldNotice($);
    } catch {
      /* a band that fails to lower must never hold up the prompt */
    }
    // Clear the pinned status line unconditionally, not just when we think we
    // set one. It is ENGINE-side state: it survives a module reload and a new
    // session, so module state is not a reliable record of whether one is up.
    // A stale line from a previous build sat pinned above the prompt for
    // several turns precisely because nothing cleared what module scope had
    // forgotten about.
    await showVaultStatus($);
    // A typed prompt naming a sealed private domain gets a PROPOSAL to open it
    // (plan §6.3) — never an unseal. The proposal names only what the person
    // just typed, so the band reveals nothing they did not already say.
    try {
      const vault = await pickVault($);
      if (vault) {
        const ids = proposeFromPrompt(vault.domains, e.text, e.origin.kind, openOf(vault.path));
        if (ids.length) {
          setBand($, { kind: "propose", text: `🔒 ${ids.join(", ")} mentioned · /vault open ${ids[0]} to include it` });
          traceTo($, vault.path, "scope:proposed", { n: ids.length });
        }
      }
    } catch {}
    // PRIME, sync lane (§8.1): postings only, no model call, prompt untouched.
    // Link triage: remember what the person pasted; the turn it starts ends with the card.
    if (features.triage && !e.turnId && PRIME_ORIGINS.has(e.origin.kind)) {
      const urls = pastedUrls(e.text);
      pendingLinks = urls.length ? { urls, turnId: "", fetched: [] } : null;
    }
    if (features.prime && PRIME_ORIGINS.has(e.origin.kind) && !e.turnId && primeFailures < PRIME_BREAKER) {
      try {
        const t0 = await $.clock.now();
        const vault = await pickVault($);
        const idx = vault ? indexes.get(vault.path) : undefined;
        const view = idx?.state === "ready" ? idx.view : null;
        if (vault && !view) traceTo($, vault.path, "prime:skip-cold", {});
        if (vault && view && idx) {
          const tokens = promptTokens(e.text);
          const seg = segmentShift(segment, tokens);
          let decision = "skip-short";
          if (seg) {
            segment = remember(segment, tokens, seg.shift);
            if (segment.touches >= 1) decision = "skip-budget";
            else {
              // Prime thresholds were pinned on the linear scale (RANK_LINEAR).
              const hits = view.search(e.text, { limit: 8, rank: RANK_LINEAR });
              const cards = await idx.cards(hits.map((h) => h.id));
              const pick = pickPrimeCandidate(
                hits,
                (id) => {
                  const c = cards.get(id);
                  return c ? { stub: c.stub, ret: c.ret, kind: c.k } : undefined;
                },
                seenOf(vault.path),
              );
              decision = pick.decision === "pick" ? "candidate" : `skip-${pick.decision}`;
              if (pick.decision === "pick") {
                const job = { vault, vaultId: vault.id ?? vault.label ?? "vault", id: pick.hit.id, task: e.text, submittedAt: Date.now() };
                $.clock.after(0, () => {
                  primeAsync($, job).catch(() => {});
                });
              }
            }
          }
          traceTo($, vault.path, "prime:sync", {
            ms: Math.round((await $.clock.now()) - t0),
            segment: seg?.shift ?? null,
            overlap: seg ? Math.round(seg.overlap * 100) / 100 : null,
            decision,
          });
        }
      } catch {
        /* prime never holds up a prompt */
      }
    }
    return next(e);
  });

  /** Prime's async lane needs to know which turn its prompt became (§8.2). */
  on("turn.start", async ($, e, next) => {
    // The main loop only: a subagent's turn would otherwise stand in for the
    // prompt's own and send prime's late check after the wrong turn.
    // (`agentId` is in builds after the 2.1.288 typings this module compiles against.)
    if ((e as { agentId?: string }).agentId !== undefined) return next(e);
    latestTurn = { turnId: e.turnId, text: e.text, at: Date.now() };
    if (pendingLinks && !pendingLinks.turnId) pendingLinks = { ...pendingLinks, turnId: e.turnId };
    return next(e);
  });

  /**
   * The status band above the prompt. Wraps whatever the engine already draws
   * there rather than replacing it, so nothing else loses its slot.
   */
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    // `next` returns a Promise — a missing await nests a Promise in the tree
    // and the whole tree fails validation silently. `$.ui.resolve` does not.
    const base = await next(e);

    // A survey owns the band while it is up; never fight it for the space.
    if (e.props.hasSurvey) return base;

    // Read while drawing: this subscribes the band, so every later write to
    // the state redraws it without an invalidate.
    const st = await read($, band);
    const card = st.visible && st.kind && CARD_KINDS.has(st.kind) && bandCard?.kind === st.kind ? bandCard : null;
    // Turned off in settings — except a stopped feature, which is the one
    // thing the band exists to make visible (CLAUDE.md: do not remove it
    // without replacing it), and a card, which its own switch governs.
    if (!bandOn && !st.paused && !card) return base;
    const live = st.visible && bandText && st.kind && (BAND_TEXT_KINDS.has(st.kind) || card);
    const scoped = st.kind === "open" || st.kind === "propose";
    const line = live
      ? {
          text: st.kind === "propose" ? bandText : `${st.kind === "open" ? "🔒" : "⟡"} vault · ${bandText}`,
          color: scoped ? "magenta" : "gray",
          dim: !scoped,
        }
      : statusLine({ ...st, lastError });
    if (!line) return base;

    const { Box, Text, Button } = $.ui.resolve(e);

    // Props are a strict allowlist (BoxProps / TextProps) and ONE bad prop
    // fails the whole tree — at which point the engine silently draws its own
    // component instead. No `key` anywhere: only Button accepts one.
    // A card asks for a press, so it is drawn in the vault tools' cyan with the
    // first (primary) button bold; a gray card read as ordinary reply text.
    const ours = card ? (
      <Box flexDirection="row">
        <Box flexShrink={1}>
          <Text color="cyan" wrap="truncate-end">
            {line.text}
          </Text>
        </Box>
        <Box flexShrink={0} flexDirection="row">
          {cardButtons(card).map(([action, label], i) => (
            <Button key={`cp-${card.kind}-${action}`} label={label} onPress={() => void bandPress($, action)}>
              <Text color="cyan" bold={i === 0} dimColor={i !== 0}>
                {label}
              </Text>
            </Button>
          ))}
        </Box>
      </Box>
    ) : (
      <Text color={line.color} dimColor={line.dim} wrap="truncate-end">
        {line.text}
      </Text>
    );
    // `base` may be null when nothing beneath renders. A null in `children`
    // fails the tree's validation, and a failed tree draws NOTHING — so the
    // band would vanish in exactly the case where it is the only content.
    return base ? (
      <Box flexDirection="column">
        {base}
        {ours}
      </Box>
    ) : (
      <Box flexDirection="column">{ours}</Box>
    );
  });

  /**
   * The vault tool's transcript row (§9.3): `⟡ vault_links [[Alpha]] · 13
   * links · 6 ms`. Running and errored calls keep the engine's row, which
   * already says so; the expanded view (ctrl+o) keeps it too.
   */
  on("ui.render", { component: "ToolUse", props: { tool: /^mcp__commonplace__vault_/ } }, async ($, e, next) => {
    const row = toolRows.get(e.props.tool_use_id);
    if (!row || e.props.isRunning || e.props.isErrored || e.props.isInterrupted || row.error) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="row">
        <Text color="cyan">{`⟡ ${row.tool}`}</Text>
        <Text wrap="truncate-end">{` ${row.subject} · ${row.summary} · ${Math.round(row.ms)} ms`}</Text>
      </Box>
    );
  });

  /** "Reading the vault" while a vault tool runs (§9.4). */
  on("ui.render", { component: "Spinner" }, async ($, e, next) => {
    const a = await read($, activity);
    if (!a) return next(e);
    return next({ ...e, props: { ...e.props, message: "Reading the vault" } });
  });

  /**
   * Claude's replies, drawn with the vault in them: `[[links]]` that resolve
   * become clickable (`file:` links to the note), and a footer flags each
   * citation that does not hold up. Drawing only: `props.text` is rewritten,
   * the stored message and what the model read are unchanged.
   */
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    if (!features.links) return next(e);
    if ((e.props as { isSummary?: true }).isSummary) return next(e);
    try {
      const d = await decorateReply($, e.props.text);
      if (d && d.text !== e.props.text) return next({ ...e, props: { ...e.props, text: d.text } });
    } catch {
      /* drawn as the engine has it */
    }
    return next(e);
  });

  /** The witness pane: every hidden addition this session, verbatim. */
  on("ui.render", { component: "Pane", requestId: WITNESS_PANE }, async ($, e, next) => {
    await read($, paneRev);
    const { Box, Markdown, Button } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        <Markdown text={renderWitness(witness)} />
        <Box flexDirection="row" marginTop={1}>
          <Button
            key="cp-witness-clear"
            label="Clear"
            onPress={() => {
              witness.clear();
              bumpPanes($);
            }}
          />
        </Box>
      </Box>
    );
  });

  /** The activity pane: what commonplace did on its own, with Undo for revisions. */
  on("ui.render", { component: "Pane", requestId: ACTIVITY_PANE }, async ($, e, next) => {
    await read($, paneRev);
    const { Box, Markdown, Button, Text } = $.ui.resolve(e);
    const undoable = vaultActivity.filter((a) => a.revert && !a.undone).slice(0, 5);
    return (
      <Box flexDirection="column">
        <Markdown text={renderActivity()} />
        {undoable.length ? (
          <Box flexDirection="column" marginTop={1}>
            {undoable.map((a) => (
              <Button key={`cp-undo-${a.id}`} label={`Undo: ${a.text}`} onPress={() => void undoRevision($, a.revert!.vp, a.revert!.event)}>
                <Text color="cyan" wrap="truncate-end">{`Undo ${a.at.slice(11, 16)} · ${a.text.length > 60 ? `${a.text.slice(0, 59)}…` : a.text}`}</Text>
              </Button>
            ))}
          </Box>
        ) : (
          <Text dimColor>{" "}</Text>
        )}
        <Box flexDirection="row" marginTop={1}>
          <Button key="cp-activity-explain" label="How it works" onPress={() => void (async () => openExplain($, (await pickVault($))?.path))()} />
        </Box>
      </Box>
    );
  });

  /** The explainer pane: one page at a time, a picture and a few lines. */
  on("ui.render", { component: "Pane", requestId: EXPLAIN_PANE }, async ($, e, next) => {
    await read($, paneRev);
    const { Box, Markdown, Button, Text } = $.ui.resolve(e);
    const page = EXPLAIN_PAGES[explainPage]!;
    const live = page.id === "live";
    let picture: unknown = null;
    if (e.surface === "terminal") {
      const { Image } = $.ui.resolve(e as typeof e & { surface: "terminal" });
      if (live) picture = <Markdown text={explainLive ? liveBars(explainLive) : "No vault configured."} />;
      else {
        let png = explainPng.get(page.id);
        if (!png) {
          try {
            png = (await $.fs.read(`${$.plugin.root}/assets/explain/${page.id}.png`, { as: "bytes" })).base64;
            explainPng.set(page.id, png);
          } catch {}
        }
        const columns = Math.max(20, Math.min(e.props.bodyColumns - 2, 110));
        // A cell is about twice as tall as it is wide.
        const rows = Math.max(6, Math.round((columns * page.h) / page.w / 2));
        picture = png ? <Image source={{ png }} columns={columns} rows={rows} alt={page.alt} /> : <Text dimColor>{page.alt}</Text>;
      }
    } else {
      // Every remote surface draws Svg.
      const { Svg } = $.ui.resolve(e as typeof e & { surface: "desktop" });
      const source = live ? (explainLive ? liveSvg(explainLive) : null) : page.svg!();
      picture = source ? <Svg source={source} alt={page.alt} /> : <Text dimColor>No vault configured.</Text>;
    }
    const go = (d: number) => {
      explainPage = Math.max(0, Math.min(explainPage + d, EXPLAIN_PAGES.length - 1));
      bumpPanes($);
    };
    return (
      <Box flexDirection="column">
        <Text bold>{`${explainPage + 1} / ${EXPLAIN_PAGES.length} · ${page.title}`}</Text>
        <Box marginTop={1}>{picture as never}</Box>
        <Box marginTop={1}>
          <Markdown text={page.body} />
        </Box>
        <Box flexDirection="row" marginTop={1}>
          {explainPage > 0 ? <Button key="cp-explain-prev" label="‹ Back" onPress={() => go(-1)} /> : <Text>{" "}</Text>}
          <Text>{"  "}</Text>
          {explainPage < EXPLAIN_PAGES.length - 1 ? <Button key="cp-explain-next" label="Next ›" onPress={() => go(1)} /> : <Text dimColor>{"end"}</Text>}
        </Box>
      </Box>
    );
  });

  /**
   * The connection pass.
   *
   * All decision logic lives in `lib/pipeline.ts` behind a `Ports` interface so
   * it can be tested against recording fakes — the guard order, the circuit
   * breaker, the rate limit and the index cache are all covered there rather
   * than only observable by running a live session. This hook is the adapter:
   * it supplies `$` at each call site (the scanner forbids passing `$` itself,
   * but an arrow whose body calls `$.noun.verb()` is fine) and does nothing
   * else.
   */
  on("turn.complete", async ($, e, next) => {
    // Let everything beneath run first; `next` resolves to the engine's answer.
    // A hook that returns while its next is pending aborts what runs beneath.
    const base = await next(e);
    completedTurns.add(e.turnId);
    if (completedTurns.size > 100) completedTurns.delete(completedTurns.values().next().value as string);
    // An agent's unit of work becomes a trigger job once it has been quiet
    // past the debounce (or at once, when it commits).
    try {
      scheduleRevisionFlush($, e.agentId);
    } catch {}
    // The main loop's answers only. A subagent's turn ends here too, and the
    // pass would judge (and surface under) a reply the person never read.
    if (e.agentId !== undefined) return base;

    // Resolved before the ports object so the note() closure can see it.
    // Empty when no vault is configured, which disables the log rather than
    // guessing a path.
    const projectDir = await $.session.cwd();
    const vp = await ensureVaultPath($, projectDir);
    // No vault configured: nothing to connect to and nowhere to log.
    if (!vp) return base;
    const logPath = `${vp}/.wiki/${LOG_FILE}`;

    // Citations in this answer, counted (no titles: they may be private).
    if (features.links) {
      try {
        const d = await decorateReply($, String(e.answer ?? ""));
        if (d && d.cited.length) traceTo($, vp, "cite:check", citationCounts(d.cited));
      } catch {}
    }

    // A pasted link gets its triage card instead of an ambient pass.
    const pending = pendingLinks && pendingLinks.turnId === e.turnId ? pendingLinks : null;
    if (pending) {
      pendingLinks = null;
      const links = pending.fetched;
      if (links.length === 0) traceTo($, vp, "triage:not-fetched", { pasted: pending.urls.length });
      else if (e.reason === "answer" && !e.isAborted) {
        try {
          if (await runTriage($, vp, links, String(e.answer ?? ""))) return base;
        } catch (err) {
          traceTo($, vp, "triage:error", { err: String(err).slice(0, 80) });
        }
      }
    }

    // Turned off in settings: the engine's answer untouched. Checked here
    // rather than by skipping the registration, so the hook list keeps one
    // shape whatever the settings.
    if (!features.ambient) return base;
    // ≤1 vault touch per segment across prime and the ambient pass (§8.5).
    if (segment.touches >= 1) {
      traceTo($, vp, "skip:segment-budget", {});
      return base;
    }

    const suppressed = ((await $.store.get(suppressedKey(vp))) ?? []) as string[];
    const surfaced = await runConnectionPass(
      {
        sessionId: () => $.session.id(),
        turnCount: () => $.session.turns(),
        cwd: () => $.session.cwd(),
        getState: (key: string) => $.store.get(key),
        setState: (key: string, value: unknown) => $.store.set(key, value),
        readText: async (path: string) => {
          const r = await $.process.run(["cat", path]);
          return r.exitCode === 0 ? String(r.stdout ?? "") : "";
        },
        runCommand: async (argv: readonly string[]) => {
          // `connect` is answered in-module over the loaded view (plan §2.6):
          // it sees only what this session may see and costs ~2 ms. The CLI
          // stays the fallback while no index is loaded.
          if (argv[0] === "connect" && vp) {
            const vault = (await loadGuard($)).vaults.find((v) => v.path === vp);
            const idx = vault ? await getIndex($, vp, vault.domains) : null;
            const view = idx?.state === "ready" ? idx.view : null;
            if (view) {
              const qi = argv.indexOf("--query");
              const ki = argv.indexOf("--k");
              const pool = connectPool(view, qi >= 0 ? argv[qi + 1] : "", { k: ki >= 0 ? Number(argv[ki + 1]) || 6 : 6 });
              const cards = await idx!.cards(pool.map((c) => c.id));
              const candidates = pool.map((c) => ({
                path: view.relOfId(c.id) ?? "",
                title: cards.get(c.id)?.t ?? "",
                ppr: c.ppr,
                lex: c.lex,
                score: c.score,
              }));
              return JSON.stringify({ candidates });
            }
          }
          const r = await $.process.run([
            "node", `${$.plugin.root}/bin/commonplace`, ...argv,
          ]);
          return r.exitCode === 0 ? String(r.stdout ?? "").trim() : "";
        },
        // `undefined` means no label fit; the pipeline compares against one
        // label, so "" is the same decision with a string type.
        classify: async (text: string, labels: readonly string[]) =>
          (await $.model.classify(text, labels)) ?? "",
        // The engine answers a ModelCompleteResult RECORD, never a bare
        // string. Handing the record to `parseVerdict` stringified it to
        // "[object Object]" — 15 characters that pass every skip check — so
        // a judged pass would have surfaced that text under the answer. An
        // unanswered call (api-error, empty-reply, aborted) is a SKIP.
        complete: async (req: CompletionRequest) => {
          const r = await $.model.complete(req);
          return r.isAnswered ? r.text : "";
        },
        now: () => $.clock.now(),
        status: async () => ({ ...(await read($, band)), lastError }),
        trace: (stage: string, detail: Record<string, unknown> = {}) => {
          // Always logged, never shown. This is the record that answers "did
          // it run, and what did it decide?" — the question the ephemeral
          // status band structurally cannot answer.
          if (logPath) {
            $.process.run(["tee", "-a", logPath], {
              stdin: `${JSON.stringify({
                at: new Date().toISOString(),
                stage,
                ...detail,
              })}\n`,
            }).catch(() => {});
          }
        },
        note: async (outcome: string, extra: Partial<Status> = {}) => {
          // Raising the band is the default: note() is only called when the
          // vault actually did something. The session-reset caller opts out.
          // The error text stays in module memory (see `lastError`); the rest
          // goes to `$.state`, whose write redraws the band by itself.
          const { lastError: err, ...shown } = extra;
          if (err !== undefined) lastError = err;
          try {
            await update($, band, (b) => ({
              ...b,
              lastOutcome: outcome,
              visible: true,
              ...shown,
            }));
          } catch {
            /* the band is a receipt; failing to draw it must not end the pass */
          }

          // DURABLE OUTCOME LOG.
          //
          // The band is a receipt: ephemeral by design, gone the moment the
          // user types. That makes it useless for answering "did this ever
          // run, and what did it decide?" — the question this feature spent
          // its whole development unable to answer, because turn.complete
          // produces no transcript output and a silent circuit breaker looks
          // identical to a vault with nothing to surface.
          //
          // `tee -a` rather than a shell redirect: process.run takes an argv
          // and runs no shell, so `>>` would be a literal argument. Not
          // awaited — an ambient feature must not make the user wait on its
          // own bookkeeping — and the catch keeps a failed append from
          // surfacing as an unhandled rejection.
          if (logPath) {
            $.process.run(["tee", "-a", logPath], {
              stdin: `${JSON.stringify({
                at: new Date().toISOString(),
                outcome,
                ...extra,
              })}\n`,
            }).catch(() => {});
          }
        },
      },
      {
        answer: e.answer,
        reason: e.reason,
        // The input names it `isAborted`. This read `e.aborted`, which does
        // not exist, so an interrupted turn was always treated as finished.
        aborted: e.isAborted,
        suppressed,
      },
    );
    if (!surfaced) return base;
    // The why is already in the line under the answer, which outlasts the
    // card; the card names the note and carries the buttons.
    // A connection to a corrected or bounded claim says so up front.
    let status: string[] = [];
    try {
      const idx = await getIndex($, vp, (await pickVault($))?.domains ?? {});
      const id = idx.view?.idOfRel(surfaced.path);
      const card = id === undefined ? undefined : (await idx.cards([id])).get(id);
      if (card) status = statusOnly(await noun.withRevisions(noun.toCard(card, { vaultId: "", index: idx }), { index: idx }));
    } catch {}
    showCard(
      $,
      { kind: "connection", vp, path: surfaced.path, title: surfaced.title, answer: String(e.answer ?? "").slice(0, 1500) },
      status.length ? `[[${surfaced.title}]] · ${status[0].replace(/^⚠\s*/, "⚠ ")}` : `[[${surfaced.title}]]`,
    );
    // Keep the engine's `usage` beside the replaced text: a hook that drops
    // it hides the turn's cost from every hook above.
    return { ...base, text: status.length ? `${surfaced.text}\n${status.join("\n")}` : surfaced.text };
  });
};
