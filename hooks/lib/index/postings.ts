/**
 * Field-weighted inverted index (`graph/main.postings.jsonl`, plan §3.4).
 *
 * Replaces scoring every index record per query (linear in the vault) with a
 * lookup of the query's terms: a query touches only its postings lists.
 *
 * fieldScore = 4·title + 4·alias + 3·abstraction + 2·heading + W·cues
 *            + 1·(anchor display text + tags + MOC names)
 * `cues:` are other phrasings a reader would search by (Doc2Query--, Gospodinov
 * et al. 2023): written by `commonplace cues`, kept only if each one retrieves
 * its own note.
 * Body text is NOT indexed — postings are a jumping-off point to notes worth
 * reading, not a substitute for reading them (CLAUDE.md "No RAG").
 *
 * Two kinds of knob, kept apart because they cost differently:
 *   TERMS  what a posting key IS (stemming, phrase keys, field weights). Baked
 *          into the artefact, so the manifest records `termSig(TERMS)` and a
 *          loader built for another shape treats the index as absent (rebuild).
 *   RANK   how a query scores against the keys (saturation, coverage, phrase
 *          weight). Query-time only; changing it needs no rebuild.
 * `commonplace eval:search --tune` searches both against the vault's gold set.
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
  cues?: string[];
  anchors?: string[];
  tags?: string[];
  mocs?: string[];
};

export type PostingsRow = { t: string; df: number; n: [number, number][] };

export type FieldWeights = { title: number; alias: number; abstraction: number; heading: number; cues: number; other: number };

export const FIELD_WEIGHTS: FieldWeights = { title: 4, alias: 4, abstraction: 3, heading: 2, cues: 2, other: 1 };

export type TermConfig = {
  /** "s": the S-stemmer (plural folding only — readable stems, almost no false merges). */
  stem: "none" | "s";
  /** Also index adjacent-word pairs within one field ("long-term memory" as a unit). */
  phrases: boolean;
  weights: FieldWeights;
};

export type RankConfig = {
  /** BM25-style saturation of a term's field score; Infinity = linear. */
  k1: number;
  /** Score × (matched query terms / query terms)^coverage; 0 = off. */
  coverage: number;
  /** Weight of a matched phrase key relative to a word key; 0 = ignore phrases. */
  phrase: number;
  /**
   * Score × (1 + authority · prior(id)), prior = the note's HITS authority
   * normalised to [0, 1] (`authorityPrior`); 0 or absent = off.
   */
  authority?: number;
};

/**
 * Defaults chosen with `eval:search` on a real ~750-note vault (30 find / 24
 * connect gold questions): over v2.0's scoring, Find MRR 0.667 → 0.753 and
 * Connect pool recall 0.81 → 1.00, better on both held-out halves. Phrase keys
 * measured no gain there, so they stay off (the tuner can still try them).
 * An authority prior of 2 (AUTH_EXP 0.25) lifted the objective 3.101 → 3.157,
 * better on both halves, moving only paraphrase questions up.
 *
 * `cues:` are supported but no vault is expected to have them yet. A
 * haiku-drafted set on ~480 notes raised Find MRR 0.762 → 0.823 (with
 * authority 1), but per question that was one rescue (rank 19 → 4) and
 * first-page reshuffles, while Connect lost a gold note outright — too thin
 * against 467 note edits and cue upkeep. Revisit with a larger paraphrase gold
 * set and a rephrase-once eval.
 */
export const TERMS: TermConfig = { stem: "s", phrases: false, weights: FIELD_WEIGHTS };
export const RANK: RankConfig = { k1: 4, coverage: 2, phrase: 0, authority: 2 };
/**
 * v2.0's linear, coverage-blind scale. Prime's absolute thresholds
 * (PRIME_MIN_SCORE, PRIME_MIN_MARGIN) were calibrated on it, so prime ranks
 * with this until `eval:prime` re-pins them.
 */
export const RANK_LINEAR: RankConfig = { k1: Infinity, coverage: 0, phrase: 0 };

/** Stable signature of a term shape, recorded in the manifest. */
export function termSig(c: TermConfig): string {
  const w = c.weights;
  return `stem=${c.stem};phr=${c.phrases ? 1 : 0};w=${w.title},${w.alias},${w.abstraction},${w.heading},${w.other};c=${w.cues}`;
}

/**
 * Harman's S-stemmer, plus `-is` left alone (analysis, thesis): folds plurals
 * so "memories" meets "memory" and "agents" meets "agent", and nothing else.
 * A stronger stemmer merges words a reader would not (`retrieval`/`retrieve`
 * is fine, `general`/`generate` is not), and stems surface in `matched`.
 */
export function stemS(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && !w.endsWith("eies") && !w.endsWith("aies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("es") && !w.endsWith("aes") && !w.endsWith("ees") && !w.endsWith("oes")) return w.slice(0, -1);
  if (w.endsWith("s") && !w.endsWith("us") && !w.endsWith("ss") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

const stemmer = (c: TermConfig) => (c.stem === "s" ? stemS : (w: string) => w);

/** Word keys of one field string, in order (duplicates kept). */
export function wordKeys(s: string | undefined, c: TermConfig = TERMS): string[] {
  if (!s) return [];
  const st = stemmer(c);
  return tokenize(s).map(st);
}

/** Phrase keys (adjacent word keys) of one field string. */
export function phraseKeys(s: string | undefined, c: TermConfig = TERMS): string[] {
  if (!c.phrases) return [];
  const w = wordKeys(s, c);
  const out: string[] = [];
  for (let i = 0; i + 1 < w.length; i++) if (w[i] !== w[i + 1]) out.push(`${w[i]} ${w[i + 1]}`);
  return out;
}

/** Field score of each key for one note. */
export function noteTerms(n: PostingsInput, c: TermConfig = TERMS): Map<string, number> {
  const m = new Map<string, number>();
  const W = c.weights;
  const field = (strings: readonly (string | undefined)[], w: number) => {
    if (!(w > 0)) return; // a zero-weight field must not create postings (they would inflate df)
    const keys = new Set<string>();
    for (const s of strings) for (const k of [...wordKeys(s, c), ...phraseKeys(s, c)]) keys.add(k);
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + w);
  };
  field([n.title], W.title);
  field(n.aliases ?? [], W.alias);
  field([n.abstraction], W.abstraction);
  field(n.headings ?? [], W.heading);
  field(n.cues ?? [], W.cues);
  field([...(n.anchors ?? []), ...(n.tags ?? []), ...(n.mocs ?? [])], W.other);
  return m;
}

export type PostingsOptions = {
  /** Keep only the top-N docs per term (by field score). */
  maxPerTerm?: number;
  /** Drop terms appearing in more than this fraction of docs (too common to discriminate). */
  maxDfRatio?: number;
  terms?: TermConfig;
};

export function buildPostings(nodes: readonly PostingsInput[], opts: PostingsOptions = {}): PostingsRow[] {
  const maxPer = opts.maxPerTerm ?? 512;
  const maxDf = opts.maxDfRatio ?? 0.2;
  const N = nodes.length;
  const lists = new Map<string, [number, number][]>();
  for (const n of nodes) {
    for (const [t, s] of noteTerms(n, opts.terms)) {
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
 * The query's keys. Generic vocabulary is dropped from the QUERY (it is kept
 * in the index — a title made only of generic words must still be findable by
 * an exact query), judged on the word as typed and on its stem.
 */
export function queryKeys(query: string, c: TermConfig = TERMS): { words: string[]; phrases: string[] } {
  const st = stemmer(c);
  const raw = tokenize(query);
  const all = [...new Set(raw.map(st))];
  const kept = [...new Set(raw.filter((w) => !GENERIC.has(w) && !GENERIC.has(st(w))).map(st))];
  return { words: kept.length > 0 ? kept : all, phrases: [...new Set(phraseKeys(query, c))] };
}

/** One key's contribution: idf · saturated field score. */
export function keyScore(fs: number, df: number, N: number, r: RankConfig): number {
  const idf = Math.log(1 + Math.max(N, 1) / Math.max(1, df));
  const sat = Number.isFinite(r.k1) ? (fs * (r.k1 + 1)) / (fs + r.k1) : fs;
  return idf * sat;
}

/** Coverage factor: notes matching more of the query's words outrank one rare-word hit. */
export function coverageFactor(matched: number, words: number, r: RankConfig): number {
  if (!(r.coverage > 0) || words <= 1) return 1;
  return Math.pow(matched / words, r.coverage);
}

/**
 * HITS authority as a [0, 1] prior: (auth / max)^AUTH_EXP. Authority is
 * heavy-tailed (a few MOC-cited notes hold most of it), so the root spreads
 * it out instead of boosting only the top handful.
 */
export const AUTH_EXP = 0.25;
export function authorityPrior(auth: ArrayLike<number> | undefined): ((id: number) => number) | undefined {
  if (!auth || auth.length === 0) return undefined;
  let max = 0;
  for (let i = 0; i < auth.length; i++) if (auth[i] > max) max = auth[i];
  if (!(max > 0)) return undefined;
  return (id) => {
    const a = id < auth.length ? auth[id] : 0;
    return a > 0 ? Math.pow(a / max, AUTH_EXP) : 0;
  };
}

export function rankHits(
  acc: Map<number, { score: number; matched: string[] }>,
  words: number,
  r: RankConfig,
  limit: number,
  min = 0,
  prior?: (id: number) => number,
): SearchHit[] {
  const w = prior && r.authority ? r.authority : 0;
  return [...acc.entries()]
    .map(([id, a]) => ({
      id,
      score: a.score * coverageFactor(a.matched.length, words, r) * (w > 0 ? 1 + w * prior!(id) : 1),
      matched: a.matched,
    }))
    .filter((h) => h.score > min)
    .sort((x, y) => y.score - x.score || y.matched.length - x.matched.length || x.id - y.id)
    .slice(0, limit);
}

/**
 * Rank notes for a query: Σ over query keys of keyScore, phrase keys weighted
 * by `rank.phrase` and not counted in `matched`, then the coverage factor.
 * `visible` filters before ranking, so a hidden note leaves no trace in counts
 * or scores.
 */
export function searchPostings(
  idx: PostingsIndex,
  query: string,
  opts: {
    limit?: number;
    visible?: (id: number) => boolean;
    minScore?: number;
    terms?: TermConfig;
    rank?: RankConfig;
    prior?: (id: number) => number;
  } = {},
): SearchHit[] {
  const r = opts.rank ?? RANK;
  const q = queryKeys(query, opts.terms);
  const acc = new Map<number, { score: number; matched: string[] }>();
  const run = (t: string, mul: number, word: boolean) => {
    const row = idx.rows.get(t);
    if (!row || !(mul > 0)) return;
    for (const [id, fs] of row.n) {
      if (opts.visible && !opts.visible(id)) continue;
      if (!word && !acc.has(id)) continue; // a phrase only boosts a note a word already found
      const a = acc.get(id) ?? { score: 0, matched: [] };
      a.score += mul * keyScore(fs, row.df, idx.N, r);
      if (word) a.matched.push(t);
      acc.set(id, a);
    }
  };
  for (const t of q.words) run(t, 1, true);
  for (const t of q.phrases) run(t, r.phrase, false);
  return rankHits(acc, q.words.length, r, opts.limit ?? 8, opts.minScore ?? 0, opts.prior);
}
