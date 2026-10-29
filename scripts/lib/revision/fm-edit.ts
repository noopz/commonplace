/**
 * Add or remove one revision edge in a note's frontmatter, leaving every other
 * line of the file byte-for-byte as it was. Only the relation key's own block
 * is rewritten (in the mapping form); the result is re-parsed and refused if
 * it does not hold exactly the intended edges.
 */

import { parseFrontmatter } from "../../../hooks/lib/index/yaml.ts";
import {
  RELATION_KEYS,
  edgeItemYaml,
  fmEdges,
  targetKey,
  type EdgeRel,
  type FmEdge,
  type RevisionRelation,
} from "../../../hooks/lib/revision/edges.ts";

type Split = { lines: string[]; open: number; close: number };

function split(text: string): Split | null {
  const lines = text.split("\n");
  if (lines[0]?.replace(/\r$/, "") !== "---") return null;
  for (let i = 1; i < lines.length; i++) if (lines[i].replace(/\r$/, "") === "---") return { lines, open: 0, close: i };
  return null;
}

/** [start, end) of a top-level key's block inside the frontmatter, or null. */
function keyRange(s: Split, keys: readonly string[]): { start: number; end: number; key: string } | null {
  for (let i = s.open + 1; i < s.close; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:/.exec(s.lines[i]);
    if (!m || !keys.includes(m[1])) continue;
    let end = i + 1;
    while (end < s.close && (/^\s/.test(s.lines[end]) || /^-(\s|$)/.test(s.lines[end]) || s.lines[end].trim() === "")) end++;
    while (end > i + 1 && s.lines[end - 1].trim() === "") end--;
    return { start: i, end, key: m[1] };
  }
  return null;
}

const norm = (x?: string) => (x ?? "").replace(/\s+/g, " ").trim();

function blockFor(key: string, edges: readonly FmEdge[]): string[] {
  const out = [`${key}:`];
  for (const e of edges) {
    if (e.rel) out.push(...edgeItemYaml(e.inner, e.rel));
    else out.push(`  - ${JSON.stringify(`[[${e.inner}]]`)}`);
  }
  return out;
}

function edgesUnder(text: string, keys: readonly string[]): { key: string | null; edges: FmEdge[] } {
  const fm = parseFrontmatter(text);
  if (fm.error) throw new Error(`frontmatter does not parse: ${fm.error}`);
  for (const k of keys) if (k in fm.data) return { key: k, edges: fmEdges(fm.data[k]) };
  return { key: null, edges: [] };
}

const same = (e: FmEdge, toTitle: string, claim?: string) =>
  targetKey(e.inner) === targetKey(toTitle) && norm(e.rel?.claim) === norm(claim);

function rewrite(text: string, relation: RevisionRelation, next: (edges: FmEdge[]) => FmEdge[]): string {
  const keys = RELATION_KEYS[relation];
  const { edges } = edgesUnder(text, keys);
  const wanted = next(edges);
  const s = split(text);
  let out: string;
  if (!s) {
    if (wanted.length === 0) return text;
    out = ["---", ...blockFor(keys[0], wanted), "---", text].join("\n");
  } else {
    const r = keyRange(s, keys);
    const block = wanted.length ? blockFor(r?.key ?? keys[0], wanted) : [];
    const lines = [...s.lines];
    if (r) lines.splice(r.start, r.end - r.start, ...block);
    else lines.splice(s.close, 0, ...block);
    out = lines.join("\n");
  }
  // Refuse anything that does not round-trip to exactly the intended edges.
  const check = edgesUnder(out, keys).edges;
  const sig = (l: FmEdge[]) => JSON.stringify(l.map((e) => [targetKey(e.inner), norm(e.rel?.claim), norm(e.rel?.because), norm(e.rel?.within), e.rel?.kind ?? "", e.rel?.effective ?? ""]));
  if (sig(check) !== sig(wanted)) throw new Error("frontmatter edit did not round-trip");
  return out;
}

/** Add (or replace, for the same note and claim) one edge. */
export function insertEdge(text: string, relation: RevisionRelation, toTitle: string, rel: EdgeRel): string {
  return rewrite(text, relation, (edges) => [...edges.filter((e) => !same(e, toTitle, rel.claim)), { inner: toTitle, rel }]);
}

/** Remove the edge to `toTitle` for `claim` (a whole-note edge when claim is empty). */
export function removeEdge(text: string, relation: RevisionRelation, toTitle: string, claim?: string): string {
  return rewrite(text, relation, (edges) => edges.filter((e) => !same(e, toTitle, claim)));
}

/** True when the note's frontmatter carries this edge. */
export function hasEdge(text: string, relation: RevisionRelation, toTitle: string, claim?: string): boolean {
  try {
    return edgesUnder(text, RELATION_KEYS[relation]).edges.some((e) => same(e, toTitle, claim));
  } catch {
    return false;
  }
}
