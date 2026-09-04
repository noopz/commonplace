/**
 * commonplace function-hooks module — ambient connection surfacing.
 *
 * EARLY ACCESS. Loads only when CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1; without
 * the flag this file is inert and the shell hooks in hooks.json are the whole
 * plugin. See `06 - Handbook/Building on Claude Code Function Hooks` in the
 * vault for the API's verified constraints and the migration checklist.
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
 * The lexical pass over the indexes is a JUMPING-OFF POINT, never the answer.
 * A candidate is only surfaced after the note itself is read and a model call
 * judges the connection real. Token overlap alone never reaches the user.
 *
 * But be honest about the LIMIT of that: only notes sharing a literal token
 * with the answer can ever become candidates here, so the motivating example
 * in CLAUDE.md — a real connection with zero shared strings — is unreachable
 * by this mechanism. This is a cheap ambient layer, not a replacement for
 * wiki-query, which does the iterative search this deliberately does not.
 *
 * COST
 * Turns that fail the free in-module prefilter cost nothing. A turn that passes
 * costs one classify (~700ms) and, if that passes, one read (~15ms) plus one
 * completion (~900ms). All of it runs AFTER the answer is on screen, so none of
 * it is on the user's critical path. Rate-limited and circuit-broken below.
 *
 * SCANNER CONSTRAINTS
 * The static scanner requires `register` to be a top-level const function, `on`
 * to take string-literal event names, and `$` to appear only as `$.noun.verb()`
 * at a call site — it may not be bound, passed, or spread. So every helper here
 * is either pure (takes plain values) or defined inside the hook body where it
 * closes over `$`.
 */

import { parseJsonl } from "./lib/seed.js";
import { runConnectionPass, ensureRecords, privateNames } from "./lib/pipeline.js";
import { statusLine, type Status } from "./lib/status.js";
import { buildVaultBlock, mergeBlocks } from "./lib/context.js";
import { checkBashCommand, checkPrivateLeak } from "./lib/guard.js";
import {
  VAULT_SEARCH_SPEC,
  VAULT_NOTE_SPEC,
  searchVault,
  formatSearchResult,
  resolveNotePath,
  isSafeVaultPath,
} from "./lib/tools.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How long the parsed indexes stay cached in module scope. Short enough that a
 * note ingested earlier in the session becomes reachable without a restart.
 */
const INDEX_TTL_MS = 120_000;

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
 * Parsed indexes, cached in module scope for the life of the resident worker.
 * Not `$.store`: derived data, cheap to rebuild and expensive to serialise,
 * and it must not outlive a vault switch.
 */
let indexCache: {
  vaultPath: string;
  at: number;
  records: Record<string, unknown>[];
} = { vaultPath: "", at: 0, records: [] };

/** The band's live state. See lib/status.ts for what each field means. */
let status: Status = {
  phase: "idle",
  sources: 0,
  concepts: 0,
  surfaced: 0,
  lastOutcome: "",
  lastError: "",
  paused: false,
  visible: false,
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const register = (on: any) => {
  /**
   * Register the vault tools so they are listed by turn one.
   *
   * `session.start` is awaited before the first prompt, which is exactly why
   * registration belongs here rather than lazily: a tool the model cannot see
   * on its first turn may as well not exist.
   */
  on("session.start", async ($: any, e: any, next: any) => {
    try {
      await $.tool.register(VAULT_SEARCH_SPEC);
      await $.tool.register(VAULT_NOTE_SPEC);
    } catch {
      /* registration is best-effort; the rest of the plugin still works */
    }
    // Resolve the vault here, once, before the first turn. At Bash-tool prices
    // this was unthinkable and every hook had to lazily cache the answer; at
    // $.process.run prices it is ~46ms of session setup, so the later hooks
    // can simply read it.
    try {
      const projectDir = await $.session.cwd();
      if (!vaultPaths.has(projectDir)) {
        const res = await $.process.run(["node", `${$.plugin.root}/bin/commonplace`, "vault-path"]);
        const p = String(res?.stdout ?? "").trim();
        if (p) vaultPaths.set(projectDir, p);
      }
    } catch {
      /* no vault configured, or the CLI is unavailable; hooks degrade */
    }
    return next(e);
  });

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
  on("tool.call", { tool: "Bash" }, async ($: any, e: any, next: any) => {
    try {
      const verdict = checkBashCommand(String(e?.command ?? ""));
      if (verdict) return verdict;
    } catch {
      /* a broken guard must never block a command */
    }
    return next(e);
  });

  /**
   * Two responsibilities, one registration: refuse to write private vault
   * material into a repository, and answer the vault tools.
   *
   * NOTE on the signal: `$.session.repo().internal` means "a repository this
   * BUILD treats as its own", which is not the same as "public" — a private
   * personal repo is also non-internal. So the rule enforced here is the one
   * that actually holds regardless: private-domain vault content belongs in
   * the vault, and copying it into any code repository is suspect. That covers
   * CLAUDE.md's "test fixtures must be invented" rule without needing to know
   * a repo's visibility, which nothing here can determine.
   */
  on("tool.call", async ($: any, e: any, next: any) => {
    const tool = String(e?.tool ?? "");

    // The private-leak guard and the vault tools share one registration: the
    // scanner allows only one matcher-less hook per event, and neither of
    // these can use a matcher — the guard covers two tool names, and the vault
    // tools' real names carry a plugin prefix this file cannot know.
    if (tool === "Write" || tool === "Edit") {
      try {
        const target = String(e?.file_path ?? "");
        const text = String(e?.content ?? e?.new_string ?? "");
        if (!target || !text) return next(e);

        const projectDir = await $.session.cwd();
        const vaultPath = vaultPaths.get(projectDir) ?? "";
        // Writing inside the vault is the whole point of the vault. The
        // trailing separator matters: without it a sibling vault directory
        // (`/Users/x/Vault2`) is exempted by a vault at `/Users/x/Vault`.
        if (!vaultPath || target.startsWith(`${vaultPath}/`)) return next(e);

        const repo = await $.session.repo();
        if (!repo) return next(e);

        // Load rather than peek at whatever cache happens to be warm. Reading
        // the cache opportunistically made this guard NONDETERMINISTIC — the
        // same Write allowed at 10:00 and denied at 10:05 once another hook had
        // filled it — which is the worst property a global deny can have. The
        // read is ~15ms and cached for two minutes.
        const records = await ensureRecords(
          vaultPath,
          async (path: string) => {
            const r = await $.process.run(["cat", path]);
            return r.exitCode === 0 ? String(r.stdout ?? "") : "";
          },
          () => $.clock.now(),
        );
        const names = privateNames(records);
        if (names.length === 0) return next(e);

        const verdict = checkPrivateLeak(text, names);
        if (verdict) return verdict;
      } catch {
        /* a broken guard must never block a write */
      }
      return next(e);
    }

    const name = tool;
    const isSearch = name.endsWith("__vault_search");
    const isNote = name.endsWith("__vault_note");
    if (!isSearch && !isNote) return next(e);

    try {
      // Vault resolution and index loading are inlined rather than factored
      // into helpers because the scanner refuses `$` crossing an import — it
      // may be passed to a function in THIS file, but not into `lib/`.
      const projectDir = await $.session.cwd();
      let vaultPath = vaultPaths.get(projectDir) ?? "";
      if (!vaultPath) {
        const res = await $.process.run(["node", `${$.plugin.root}/bin/commonplace`, "vault-path"]);
        vaultPath = String(res?.stdout ?? "").trim();
        if (vaultPath) vaultPaths.set(projectDir, vaultPath);
      }
      if (!vaultPath) {
        return {
          deny:
            "No commonplace vault is configured for this machine. " +
            "Run `commonplace init --vault <path>` first.",
        };
      }

      if (
        indexCache.vaultPath !== vaultPath ||
        $.clock.now() - indexCache.at > INDEX_TTL_MS
      ) {
        // `cat`, not the Read tool: Read caps a result near 48KB and returned
        // 114 of 347 concept records on this vault, so vault_search was
        // ranking against a third of the index and reporting no matches for
        // notes that exist. `cat` returns the whole file in ~2ms.
        const conceptRes = await $.process.run([
          "cat", `${vaultPath}/.wiki/concept-index.jsonl`,
        ]);
        const sourceRes = await $.process.run([
          "cat", `${vaultPath}/.wiki/source-index.jsonl`,
        ]);
        const parsed = [
          ...parseJsonl(String(conceptRes?.stdout ?? "")),
          ...parseJsonl(String(sourceRes?.stdout ?? "")),
        ];
        if (parsed.length > 0) {
          indexCache = { vaultPath, at: $.clock.now(), records: parsed };
        }
      }
      const records = indexCache.vaultPath === vaultPath ? indexCache.records : [];
      if (records.length === 0) {
        return {
          deny:
            `Could not read the vault indexes at ${vaultPath}/.wiki/. ` +
            "Run `commonplace index` to build them.",
        };
      }

      if (isSearch) {
        const query = String(e?.query ?? "");
        const hits = searchVault(records, query, Number(e?.limit ?? 8));
        return { result: formatSearchResult(hits, query) };
      }

      const ref = String(e?.note ?? "");
      const path = resolveNotePath(records, ref);
      if (!path || !isSafeVaultPath(path)) {
        return {
          deny:
            `No vault note matches "${ref}". Use a path or title from ` +
            "vault_search rather than guessing one.",
        };
      }
      const res = await $.process.run(["cat", `${vaultPath}/${path}`]);
      // A string, not an object: core validates a registered tool's answer
      // against the MCP content shape and rejects anything else outright.
      return { result: `${path}\n\n${String(res?.stdout ?? "")}` };
    } catch (err) {
      return { deny: `commonplace vault tool failed: ${String(err).slice(0, 200)}` };
    }
  });

  /**
   * Steer vault research away from ad-hoc subagents, at the point of decision.
   *
   * `scripts/agent-guard.ts` handles this today by DENYING an Agent dispatch
   * after the model has already composed a vault-shaped prompt — a post-hoc
   * refusal over a regex, which over-fires often enough that it needed the
   * `ALLOW_VAULT_AGENT` escape hatch. Amending the tool's own description
   * steers before the wrong dispatch is composed, which is the cheaper fix.
   *
   * This does NOT replace the shell guard — both are live, and agent-guard
   * still denies (the handbook's flag-no-op rule applies to hooks the module
   * has taken over, and steering is not enforcement). Removing the guard is a
   * separate decision that wants evidence the steer works; until then, expect
   * `ALLOW_VAULT_AGENT` to still be needed.
   *
   * Deliberately additive. The engine caches rendered schemas for the session,
   * so this costs one string concatenation per session, not per call.
   */
  on("tool.describe", { tool: "Agent" }, async ($: any, e: any, next: any) => {
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
  on("skill.prompt", async ($: any, e: any, next: any) => {
    const built = await next(e);
    try {
      const skill = String(e?.skill ?? "");
      // `includes`, not `startsWith`: it is not established whether a plugin
      // skill arrives bare (`wiki-query`) or namespaced
      // (`commonplace:wiki-query`). Under `startsWith` the namespaced form
      // never matches and this hook is silently inert — a failure with no
      // symptom. Verify the real shape when the API is documented, then
      // tighten. `wiki-` is distinctive enough that the loose match is safe.
      if (!skill.includes("wiki-") && !skill.includes("autoimprove")) return built;

      const projectDir = await $.session.cwd();
      const vaultPath = vaultPaths.get(projectDir) ?? "";
      if (!vaultPath) return built;

      const counts =
        indexCache.vaultPath === vaultPath && indexCache.records.length > 0
          ? ` It currently holds ${indexCache.records.length} indexed notes.`
          : "";

      return {
        text:
          `The commonplace vault for this session is at ${vaultPath}.${counts} ` +
          "It is already resolved — do not run `commonplace vault-path` or " +
          "search for it.\n\n" +
          built.text,
      };
    } catch {
      return built;
    }
  });

  /**
   * The vault's orienting block on the conversation's first user message.
   *
   * Replaces `scripts/prompt-context.ts`, a shell hook wired to
   * UserPromptSubmit — which meant a `node` cold start on EVERY PROMPT to
   * re-count three index files and inject ~800 words mid-transcript. This
   * fires ONCE PER CONVERSATION and lands as a real context block, so it is
   * both far cheaper and in the right place. `$.ui.invalidate("prompt.context")`
   * re-runs it when the vault actually changes.
   */
  on("prompt.context", async ($: any, e: any, next: any) => {
    const built = await next(e);
    try {
      // `session.start` already resolved this, once, in ~46ms. The elaborate
      // negative cache that used to live here existed only because the old
      // Bash-tool resolve cost 7.3s on the critical path before the first
      // model turn; at process.run prices there is nothing to amortise.
      const projectDir = await $.session.cwd();
      const vaultPath = vaultPaths.get(projectDir) ?? "";
      if (!vaultPath) return built;

      const inVault = projectDir.startsWith(`${vaultPath}/`) || projectDir === vaultPath;

      // Counts are only rendered for the in-vault block, so outside the vault
      // this skips three index reads whose result was discarded.
      //
      // `wc -l` rather than reading and parsing: the count is all that is
      // wanted, and it is exact. Reading the file through the Read tool gave a
      // count capped near 48KB — a 347-concept index reported as 114, a wrong
      // number stated confidently, which is worse than no number.
      const readCount = async (name: string) => {
        const res = await $.process.run([
          "wc", "-l", `${vaultPath}/.wiki/${name}`,
        ]);
        return Number(String(res?.stdout ?? "").trim().split(/\s+/)[0] ?? 0) || 0;
      };
      const sources = inVault ? await readCount("source-index.jsonl") : 0;
      const concepts = inVault ? await readCount("concept-index.jsonl") : 0;
      const mocs = inVault ? await readCount("moc-index.jsonl") : 0;

      // Untuned genres are actionable state: genre-aware lint checks do not
      // apply until rules exist, and nothing else surfaces that.
      let untunedGenres: string[] = [];
      if (inVault) try {
        const convRes = await $.process.run([
          "cat", `${vaultPath}/.wiki/conventions.json`,
        ]);
        const conv = JSON.parse(String(convRes?.stdout ?? "") || "{}");
        untunedGenres = (conv.genres ?? [])
          .filter((g: any) => !g?.rules || Object.keys(g.rules).length === 0)
          .map((g: any) => String(g?.name ?? ""))
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
  on("prompt.submit", async ($: any, e: any, next: any) => {
    if (status.visible) {
      status = { ...status, visible: false };
      $.ui.invalidate("ui.render");
    }
    return next(e);
  });

  /**
   * The status band above the prompt. Wraps whatever the engine already draws
   * there rather than replacing it, so nothing else loses its slot.
   */
  on("ui.render", { component: "AbovePrompt" }, async ($: any, e: any, next: any) => {
    // `$.ui.resolve`/`next` return Promises — a missing await yields undefined
    // JSX tags and the whole tree fails validation silently.
    const base = await next(e);

    // A survey owns the band while it is up; never fight it for the space.
    if (e?.props?.hasSurvey) return base;

    const line = statusLine(status);
    if (!line) return base;

    // Props are a strict allowlist (BoxProps / TextProps) and ONE bad prop
    // fails the whole tree — at which point the engine silently draws its own
    // component instead. No `key` anywhere: only Button accepts one.
    const ours = {
      type: "Text",
      props: { color: line.color, dimColor: line.dim, wrap: "truncate-end" },
      children: [line.text],
    };
    // `base` may be null when nothing beneath renders. A null in `children`
    // fails the tree's validation, and a failed tree draws NOTHING — so the
    // band would vanish in exactly the case where it is the only content.
    return {
      type: "Box",
      props: { flexDirection: "column" },
      children: base ? [base, ours] : [ours],
    };
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
  on("turn.complete", async ($: any, e: any, next: any) => {
    // Let everything beneath run first; `next` resolves to the engine's answer.
    // A hook that returns while its next is pending aborts what runs beneath.
    const base = await next(e);

    const surfaced = await runConnectionPass(
      {
        sessionId: () => $.session.id(),
        turnCount: () => $.session.turnCount(),
        cwd: () => $.session.cwd(),
        getState: (key: string) => $.store.get(key),
        setState: (key: string, value: unknown) => $.store.set(key, value),
        readText: async (path: string) => {
          const r = await $.process.run(["cat", path]);
          return r.exitCode === 0 ? String(r.stdout ?? "") : "";
        },
        runCommand: async (argv: readonly string[]) => {
          const r = await $.process.run([
            "node", `${$.plugin.root}/bin/commonplace`, ...argv,
          ]);
          return r.exitCode === 0 ? String(r.stdout ?? "").trim() : "";
        },
        classify: (text: string, labels: readonly string[]) =>
          $.model.classify(text, labels),
        complete: (req: any) => $.model.complete(req),
        now: () => $.clock.now(),
        status: () => status,
        note: (outcome: string, extra: Partial<Status> = {}) => {
          // Raising the band is the default: note() is only called when the
          // vault actually did something. The session-reset caller opts out.
          status = { ...status, lastOutcome: outcome, visible: true, ...extra };
          $.ui.invalidate("ui.render");
        },
      },
      {
        answer: String(e?.answer ?? ""),
        reason: String(e?.reason ?? ""),
        aborted: Boolean(e?.aborted),
      },
    );

    return surfaced ?? base;
  });
};
