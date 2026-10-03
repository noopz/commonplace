/**
 * The private-domain scope model (plan §4).
 *
 * Private domains are EXPLICIT-ENTRY, and links between scopes are ONE-WAY:
 * a private note may link out to public notes; a public note never links in.
 * A note's scope comes from where it lives (its domain folder, or a
 * note-level `scope: private`) — never from who links to it.
 *
 * A private domain is opened ("unsealed") by exactly two signals:
 *   1. the session STARTED inside the domain's folder (session-start cwd only;
 *      a later `cd` is the model's to make and unlocks nothing);
 *   2. the person ran `/vault open <id|alias>`.
 * A prompt that merely names a sealed domain only PROPOSES the command — a
 * pasted page or injected text must not unseal anything.
 *
 * Opening a domain opens its linkGroup (the shard). Opening one private
 * domain never opens another. The scope truth lives in module memory only;
 * a reload re-seals everything.
 *
 * Pure — no `$`, no Node.
 */

export type DomainDef = {
  path?: string;
  scope?: string;
  linkGroup?: string;
  aliases?: string[];
};
export type DomainMap = Record<string, DomainDef>;

/** Shards that can never be opened in v2.0 (§3.6). */
export const UNOPENABLE = new Set(["loose", "quarantine"]);
export const MAIN = "main";

export function isPrivate(d: DomainDef | undefined): boolean {
  return d?.scope === "private";
}

/** Shard of a domain: `main` for public, linkGroup ?? id for private. */
export function shardOfDomain(domains: DomainMap, id: string): string {
  const d = domains[id];
  if (!isPrivate(d)) return MAIN;
  return d!.linkGroup || id;
}

/**
 * Shard of a note from its vault-relative path and its own frontmatter scope.
 * Longest domain path wins (nested domains). A note-level `scope: private` in
 * a public domain is `loose` (sealed, unopenable in v2.0); a `scope: public`
 * note inside a private domain stays private — the domain governs its path.
 */
export function shardOfNote(domains: DomainMap, relPath: string, noteScope?: string): string {
  let best: string | null = null;
  let bestLen = -1;
  for (const [id, d] of Object.entries(domains)) {
    const p = (d.path ?? "").replace(/\/+$/, "");
    if (!p) continue;
    if ((relPath === p || relPath.startsWith(`${p}/`)) && p.length > bestLen) {
      best = id;
      bestLen = p.length;
    }
  }
  const shard = best ? shardOfDomain(domains, best) : MAIN;
  if (shard === MAIN && noteScope === "private") return "loose";
  return shard;
}

export function isVisible(shard: string, open: ReadonlySet<string>): boolean {
  return shard === MAIN || (!UNOPENABLE.has(shard) && open.has(shard));
}

const strip = (p: string) => p.replace(/\/+$/, "");

/** Signal 1: shards whose folder contains the session-start cwd. */
export function openFromStartCwd(domains: DomainMap, vaultPath: string, startCwd: string): Set<string> {
  const open = new Set<string>();
  if (!vaultPath || !startCwd) return open;
  const cwd = strip(startCwd);
  for (const [id, d] of Object.entries(domains)) {
    if (!isPrivate(d) || !d.path) continue;
    const root = strip(`${strip(vaultPath)}/${d.path}`);
    if (cwd === root || cwd.startsWith(`${root}/`)) open.add(shardOfDomain(domains, id));
  }
  return open;
}

/**
 * Signal 2: `/vault open <ref>` — exact id (case-insensitive) or a configured
 * alias. Only private domains resolve: a public domain needs no opening, and
 * an unknown ref gets the same answer as a public one so the reply cannot be
 * used to probe for sealed ids.
 */
export function resolveOpenRef(domains: DomainMap, ref: string): { shard: string; domain: string } | null {
  const r = ref.trim().toLowerCase();
  if (!r) return null;
  for (const [id, d] of Object.entries(domains)) {
    if (!isPrivate(d)) continue;
    if (id.toLowerCase() === r || (d.aliases ?? []).some((a) => a.toLowerCase() === r)) {
      return { shard: shardOfDomain(domains, id), domain: id };
    }
  }
  return null;
}

/** Prompt origins that count as the person typing (d.ts PromptOrigin). */
export const TYPED_ORIGINS = new Set(["composer", "bridge"]);
const PROPOSE_WINDOW = 200;

/**
 * Domains a typed prompt names that are currently sealed — to PROPOSE
 * `/vault open`, never to open. Whole-word match within the first 200 typed
 * characters (a long paste mentioning the name further down does not count),
 * ids of ≥4 characters (with `-`/`_` read as spaces) and configured aliases.
 */
export function proposeFromPrompt(
  domains: DomainMap,
  text: string,
  originKind: string,
  open: ReadonlySet<string>,
): string[] {
  if (!TYPED_ORIGINS.has(originKind)) return [];
  const hay = ` ${String(text ?? "").slice(0, PROPOSE_WINDOW).toLowerCase()} `;
  const word = (needle: string) => {
    const n = needle.toLowerCase().trim();
    if (!n) return false;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_ ]+/g, "[-_ ]+");
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(hay);
  };
  const out: string[] = [];
  for (const [id, d] of Object.entries(domains)) {
    if (!isPrivate(d)) continue;
    const shard = shardOfDomain(domains, id);
    if (open.has(shard)) continue;
    const names = [...(id.length >= 4 ? [id] : []), ...(d.aliases ?? [])];
    if (names.some(word)) out.push(id);
  }
  return out;
}

/**
 * Absolute roots the sealing guard denies: every private domain folder whose
 * shard is not open, plus `<vault>/.wiki/sealed` (always — the model never
 * reads sealed artefacts, open or not; commonplace serves them).
 */
export function sealedRoots(domains: DomainMap, vaultPath: string, open: ReadonlySet<string>): string[] {
  const v = strip(vaultPath);
  const roots = [`${v}/.wiki/sealed`];
  for (const [id, d] of Object.entries(domains)) {
    if (!isPrivate(d) || !d.path) continue;
    if (isVisible(shardOfDomain(domains, id), open)) continue;
    roots.push(strip(`${v}/${d.path}`));
  }
  return roots;
}

export function protectedRoots(vaultPath: string): string[] {
  const v = strip(vaultPath);
  return [`${v}/.wiki/skills`, `${v}/.wiki/agents`];
}

/** Public domain ids — the only ones any listing may name while sealed. */
export function listableDomains(domains: DomainMap, open: ReadonlySet<string>): string[] {
  return Object.keys(domains)
    .filter((id) => isVisible(shardOfDomain(domains, id), open))
    .sort();
}
