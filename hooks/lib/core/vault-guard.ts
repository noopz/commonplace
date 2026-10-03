/**
 * The built-in-tool guard, as one pure decision over every registered vault
 * (plan §4.2, §4.2a, §2.3b step 1). `register.tsx` gathers the facts — the
 * registry, each vault's `domains.json`, the open shards held in module
 * memory, `sealed/names.json` — and asks three questions here:
 *
 *   1. `sealRootsFor`: which absolute folders the model's file tools may not
 *      reach (fed to `checkSealedAccess`).
 *   2. `sanitizeWrite`: does a Write/Edit into a SOURCE note carry a remote
 *      image embed or an over-length URL? Strip them on the way down, so no
 *      file is ever rewritten after the fact.
 *   3. `leakVerdict`: does a write reproduce a private title somewhere that
 *      title must not go?
 *
 * Pure — no `$`, no Node. Every caller wraps these in try/catch and fails
 * open; a guard bug must never block a tool call.
 */

import {
  sealedRoots,
  protectedRoots,
  shardOfNote,
  isVisible,
  isPrivate,
  MAIN,
  type DomainMap,
} from "./scope.js";
import { normalizePath, isUnder, type SealRoots } from "./seal.js";
import { sanitizeIngestedBody, splitFrontmatterRaw } from "../index/sanitize.js";
import { checkSealedLeak, type SealedName } from "../guard.js";

export type GuardVault = {
  /** The registered path, normalised. */
  path: string;
  /** Where it lands when it differs (`$.fs.stat` realPath), else absent. */
  real?: string;
  domains: DomainMap;
  /** Registry id, label and aliases (absent in tests that only exercise paths). */
  id?: string;
  label?: string;
  aliases?: string[];
  isPrivate?: boolean;
};

export type OpenOf = (vaultPath: string) => ReadonlySet<string>;

const strip = (p: string) => p.replace(/\/+$/, "");

/** Both spellings of a vault: registered and resolved. */
const spellings = (v: GuardVault) => [...new Set([strip(v.path), ...(v.real ? [strip(v.real)] : [])])];

/** `sealedRoots` always lists `.wiki/sealed`; anything more is a sealed domain. */
const anySealed = (v: GuardVault, open: ReadonlySet<string>) =>
  sealedRoots(v.domains, v.path, open).length > 1;

/**
 * Seal roots for every vault. `.wiki/sealed` is always under-denied (the
 * model never reads sealed artefacts; commonplace serves them), but it only
 * makes the vault ROOT un-scannable while some domain is actually sealed —
 * the user's rule (Q9): root greps are denied while any domain is sealed, and
 * a vault with nothing sealed keeps working as a plain folder.
 */
export function sealRootsFor(vaults: readonly GuardVault[], openOf: OpenOf): SealRoots {
  const sealed: string[] = [];
  const noScan: string[] = [];
  const protectedWrite: string[] = [];
  for (const v of vaults) {
    const open = openOf(v.path);
    const scanBlocked = anySealed(v, open);
    for (const base of spellings(v)) {
      const roots = sealedRoots(v.domains, base, open);
      const wikiSealed = `${base}/.wiki/sealed`;
      for (const r of roots) {
        if (r === wikiSealed && !scanBlocked) noScan.push(r);
        else sealed.push(r);
      }
      protectedWrite.push(...protectedRoots(base));
    }
  }
  return { sealed, protectedWrite, sealedNoScan: noScan };
}

/** The vault a path lies in, and the path relative to it. */
export function locate(
  vaults: readonly GuardVault[],
  absPath: string,
): { vault: GuardVault; rel: string } | null {
  let best: { vault: GuardVault; rel: string; len: number } | null = null;
  for (const v of vaults) {
    for (const base of spellings(v)) {
      if (!isUnder(absPath, base) || absPath === base) continue;
      if (!best || base.length > best.len) best = { vault: v, rel: absPath.slice(base.length + 1), len: base.length };
    }
  }
  return best ? { vault: best.vault, rel: best.rel } : null;
}

/** A source note: a `.md` under some registered domain folder, outside `.wiki/`. */
export function isSourceNotePath(v: GuardVault, rel: string): boolean {
  if (!rel.endsWith(".md") || rel === ".wiki" || rel.startsWith(".wiki/")) return false;
  return Object.values(v.domains).some((d) => {
    const p = strip(d.path ?? "");
    return !!p && rel.startsWith(`${p}/`);
  });
}

/**
 * Sanitise a Write/Edit into a source note on the way down.
 * Returns the replacement fields and what was stripped, or null when the
 * write is not a source-note write or nothing needed stripping. Frontmatter
 * is never touched (a `source:` URL there is metadata, not a rendered link).
 */
export function sanitizeWrite(
  tool: string,
  input: Record<string, unknown>,
  vaults: readonly GuardVault[],
  cwd: string,
): { patch: Record<string, string>; stripped: string[] } | null {
  const field = tool === "Write" ? "content" : tool === "Edit" ? "new_string" : "";
  if (!field) return null;
  const target = typeof input.file_path === "string" ? normalizePath(input.file_path, cwd) : "";
  const text = typeof input[field] === "string" ? (input[field] as string) : "";
  if (!target || !text) return null;
  const at = locate(vaults, target);
  if (!at || !isSourceNotePath(at.vault, at.rel)) return null;
  const { frontmatterBlock, body } = splitFrontmatterRaw(text);
  const { body: clean, stripped } = sanitizeIngestedBody(body);
  if (stripped.length === 0) return null;
  return { patch: { [field]: frontmatterBlock + clean }, stripped };
}

const LEAK_FIELDS: Record<string, string> = { Write: "content", Edit: "new_string", NotebookEdit: "new_source" };

/**
 * Leak verdict for a write. `names` is the union of every registered vault's
 * private titles, each stamped with its `vault` path.
 *
 * - Outside every vault: any private title (prose or link) is checked. The
 *   caller decides whether such a write is in scope at all (today: only in a
 *   code repository).
 * - Inside a vault: names of the SAME shard are the target's own material and
 *   pass; names from another shard of the same vault are checked for explicit
 *   `[[links]]` only — a link from public (or another private group) into a
 *   private note is the one-way violation; a phrase is not worth a deny there.
 *   Names from another vault are checked fully (B13).
 * - Writes into `.wiki/` (indexes, logs) are commonplace's own and pass.
 */
/**
 * Leak-guard shard carrying every title of a vault registered `isPrivate`.
 * Never openable; guards writes OUTSIDE that vault only.
 */
export const PRIVATE_VAULT_SHARD = "private-vault";

export function leakVerdict(
  tool: string,
  input: Record<string, unknown>,
  vaults: readonly GuardVault[],
  names: readonly SealedName[],
  openOf: OpenOf,
  cwd: string,
): { deny: string } | null {
  const field = LEAK_FIELDS[tool];
  if (!field || names.length === 0) return null;
  const text = typeof input[field] === "string" ? (input[field] as string) : "";
  const rawTarget = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : "";
  if (!text || !rawTarget) return null;
  const isOpen = (n: SealedName) => isVisible(n.shard, n.vault ? openOf(n.vault) : new Set<string>());
  const at = locate(vaults, normalizePath(rawTarget, cwd));
  if (!at) return checkSealedLeak(text, names, isOpen);
  if (at.rel.startsWith(".wiki/")) return null;
  const targetShard = shardOfNote(at.vault.domains, at.rel);
  const same = (n: SealedName) => n.vault === at.vault.path;
  const foreign = names.filter((n) => !same(n));
  const otherShard = names.filter((n) => same(n) && n.shard !== targetShard && n.shard !== PRIVATE_VAULT_SHARD);
  return (
    checkSealedLeak(text, foreign, isOpen) ??
    checkSealedLeak(text, otherShard, isOpen, { linksOnly: true })
  );
}

/** Legacy fallback: private titles derived from the v1 jsonl records. */
export function namesFromLegacy(
  records: readonly Record<string, unknown>[],
  domains: DomainMap,
  vault: string,
): SealedName[] {
  const out: SealedName[] = [];
  for (const r of records) {
    if (r.scope !== "private") continue;
    const t = String(r.title ?? r.name ?? "").trim();
    if (!t) continue;
    const dom = r.domain ? String(r.domain) : "";
    const shard = dom && isPrivate(domains[dom]) ? domains[dom].linkGroup || dom : "loose";
    out.push({ t, shard: shard === MAIN ? "loose" : shard, vault });
  }
  return out;
}
