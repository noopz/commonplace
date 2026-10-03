/**
 * Field-weighted inverted index (`graph/main.postings.jsonl`, plan §3.4).
 *
 * Replaces scoring every index record per query (linear in the vault) with a
 * lookup of the query's terms: a query touches only its postings lists.
 *
 * fieldScore = 4·title + 4·alias + 3·abstraction + 2·heading
 *            + 1·(anchor display text + tags + MOC names)
 * Body text is NOT indexed — postings are a jumping-off point to notes worth
 * reading, not a substitute for reading them (CLAUDE.md "No RAG").
 *
 * Built on the PUBLIC subgraph only by the caller: anchor text from links
 * into sealed notes must never become a public term (review B8).
 *
 * Sandbox-safe.
 */

import { tokenize, GENERIC } from "../core/text.js";

export type PostingsInput = {
  id: number;
  title: string;
  aliases?: string[];
  abstraction?: string;
  headings?: string[];
  anchors?: string[];
  tags?: string[];
  mocs?: string[];
};

export type PostingsRow = { t: string; df: number; n: [number, number][] };

export const FIELD_WEIGHTS = { title: 4, alias: 4, abstraction: 3, heading: 2, other: 1 } as const;

export type PostingsOptions = {
  /** Keep only the top-N docs per term (by field score). */
  maxPerTerm?: number;
  /** Drop terms appearing in more than this fraction of docs (too common to discriminate). */
  maxDfRatio?: number;
};

const toks = (s: string | undefined) => (s ? tokenize(s) : []);

/** Field score of each term for one note. */
export function noteTerms(n: PostingsInput): Map<string, number> {
  const m = new Map<string, number>();
  const add = (terms: string[], w: number) => {
    for (const t of new Set(terms)) m.set(t, (m.get(t) ?? 0) + w);
  };
  add(toks(n.title), FIELD_WEIGHTS.title);
  add((n.aliases ?? []).flatMap(toks), FIELD_WEIGHTS.alias);
  add(toks(n.abstraction), FIELD_WEIGHTS.abstraction);
  add((n.headings ?? []).flatMap(toks), FIELD_WEIGHTS.heading);
  add([...(n.anchors ?? []), ...(n.tags ?? []), ...(n.mocs ?? [])].flatMap(toks), FIELD_WEIGHTS.other);
  return m;
}

export function buildPostings(nodes: readonly PostingsInput[], opts: PostingsOptions = {}): PostingsRow[] {
  const maxPer = opts.maxPerTerm ?? 512;
  const maxDf = opts.maxDfRatio ?? 0.2;
  const N = nodes.length;
  const lists = new Map<string, [number, number][]>();
  for (const n of nodes) {
    for (const [t, s] of noteTerms(n)) {
      let l = lists.get(t);
      if (!l) lists.set(t, (l = []));
      l.push([n.id, s]);
    }
  }
  const rows: PostingsRow[] = [];
  for (const [t, l] of lists) {
    // Small vaults keep everything: a df cap on a 10-note vault would drop
    // the only word two notes share.
    if (N >= 50 && l.length / N > maxDf) continue;
    l.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    rows.push({ t, df: l.length, n: l.slice(0, maxPer) });
  }
  rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return rows;
}

export type PostingsIndex = { N: number; rows: Map<string, PostingsRow> };

export function indexPostings(rows: readonly PostingsRow[], N: number): PostingsIndex {
  return { N, rows: new Map(rows.map((r) => [r.t, r])) };
}

export type SearchHit = { id: number; score: number; matched: string[] };

/**
 * Rank notes for a query: Σ over query terms of fieldScore · idf, where
 * idf = ln(1 + N/df). Generic vocabulary is dropped from the QUERY (it is
 * kept in the index — a title made only of generic words must still be
 * findable by an exact query). `visible` filters before ranking, so a hidden
 * note leaves no trace in counts or scores.
 */
export function searchPostings(
  idx: PostingsIndex,
  query: string,
  opts: { limit?: number; visible?: (id: number) => boolean; minScore?: number } = {},
): SearchHit[] {
  const limit = opts.limit ?? 8;
  const raw = [...new Set(tokenize(query))];
  const terms = raw.filter((t) => !GENERIC.has(t));
  const use = terms.length > 0 ? terms : raw;
  const acc = new Map<number, { score: number; matched: string[] }>();
  for (const t of use) {
    const row = idx.rows.get(t);
    if (!row) continue;
    const idf = Math.log(1 + idx.N / Math.max(1, row.df));
    for (const [id, fs] of row.n) {
      if (opts.visible && !opts.visible(id)) continue;
      const a = acc.get(id) ?? { score: 0, matched: [] };
      a.score += fs * idf;
      a.matched.push(t);
      acc.set(id, a);
    }
  }
  const min = opts.minScore ?? 0;
  return [...acc.entries()]
    .filter(([, a]) => a.score > min)
    .sort((x, y) => y[1].score - x[1].score || y[1].matched.length - x[1].matched.length || x[0] - y[0])
    .slice(0, limit)
    .map(([id, a]) => ({ id, score: a.score, matched: a.matched }));
}
