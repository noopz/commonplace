/**
 * The one wikilink resolver (plan §3.8). Sandbox-safe: no Node, no `$`.
 *
 * Obsidian wikilinks are case-insensitive, may carry a section anchor
 * (`Note#Heading`) or block ref (`Note#^id`), a display alias (`Note|shown`),
 * may target an attachment (`.pdf`, `.png`, …) and may resolve through
 * frontmatter `aliases:`. Every consumer that turns a link into a note — the
 * indexer, PPR edge building, lint, scope-check, `vault_note` — goes through
 * here, so they cannot disagree about what a link points at.
 *
 * Collisions are resolved by a TOTAL order (review finding A16): for each key,
 * the claimant list is sorted stem match > alias > title, then by path
 * (plain code-unit comparison, not locale), then by id. First-wins in file
 * order made the winner depend on glob order, so a journal-patched graph and a
 * full rebuild could disagree; a total order makes them identical, and keeping
 * the whole list lets a delete hand the key to the next claimant.
 */

export const ATTACHMENT_EXTS: ReadonlySet<string> = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".flac",
  ".zip", ".csv", ".xlsx", ".docx", ".pptx",
]);

export interface NameNode {
  id: number;
  path: string;
  /**
   * Display title (H1 / frontmatter title / concept or MOC name). Pass "" when
   * the consumer must follow Obsidian's own resolution, which never resolves a
   * body link by title — only by filename stem and alias.
   */
  title: string;
  aliases: string[];
}

/** key -> claimant ids, best first. */
export type Names = Map<string, number[]>;

const RANK_STEM = 0;
const RANK_ALIAS = 1;
const RANK_TITLE = 2;

/** Filename without directory or `.md`, as typed (not lowercased). */
export function stemOf(path: string): string {
  const base = String(path).split(/[\\/]/).pop() ?? "";
  return base.replace(/\.md$/i, "");
}

/**
 * Reduce a raw wikilink target to its lookup key, or null when it cannot name
 * a note: an intra-document anchor (`#Heading`), an attachment, or empty.
 * Strips `|display`, `#anchor` and `^block`, a trailing `.md`, surrounding
 * whitespace, and lowercases.
 */
export function normalizeKey(raw: string): string | null {
  let t = String(raw ?? "");
  const pipe = t.indexOf("|");
  if (pipe !== -1) t = t.slice(0, pipe);
  const hash = t.indexOf("#");
  if (hash !== -1) t = t.slice(0, hash);
  const caret = t.indexOf("^");
  if (caret !== -1) t = t.slice(0, caret);
  t = t.trim();
  if (!t) return null;
  const dot = t.lastIndexOf(".");
  if (dot > 0) {
    const ext = t.slice(dot).toLowerCase();
    if (ext === ".md") t = t.slice(0, dot).trim();
    else if (ATTACHMENT_EXTS.has(ext)) return null;
  }
  return t ? t.toLowerCase() : null;
}

function cleanKey(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const k = s.trim().toLowerCase();
  return k ? k : null;
}

/**
 * Build key -> claimant list. Keys are the lowercased filename stem, aliases
 * and title. A node claiming one key several ways is listed once, at its best
 * rank. The result does not depend on the order of `nodes`.
 */
export function buildNames(nodes: readonly NameNode[]): Names {
  const claims = new Map<string, Map<number, { rank: number; path: string }>>();
  const claim = (key: string | null, n: NameNode, rank: number) => {
    if (!key) return;
    let byId = claims.get(key);
    if (!byId) claims.set(key, (byId = new Map()));
    const prev = byId.get(n.id);
    if (!prev || rank < prev.rank) byId.set(n.id, { rank, path: n.path });
  };
  for (const n of nodes) {
    claim(cleanKey(stemOf(n.path)), n, RANK_STEM);
    for (const a of Array.isArray(n.aliases) ? n.aliases : []) claim(cleanKey(a), n, RANK_ALIAS);
    claim(cleanKey(n.title), n, RANK_TITLE);
  }
  const names: Names = new Map();
  const keys = [...claims.keys()].sort();
  for (const key of keys) {
    const list = [...claims.get(key)!.entries()].sort(
      ([ia, a], [ib, b]) =>
        a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || ia - ib,
    );
    names.set(key, list.map(([id]) => id));
  }
  return names;
}

/** Every claimant of the key `raw` normalises to, best first ([] if none). */
export function claimants(names: Names, raw: string): number[] {
  const key = normalizeKey(raw);
  return key ? names.get(key) ?? [] : [];
}

/** The winning node id for a raw wikilink target, or null. */
export function resolve(names: Names, raw: string): number | null {
  return claimants(names, raw)[0] ?? null;
}
