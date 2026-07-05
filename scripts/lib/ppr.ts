/**
 * Personalized PageRank (PPR) over the vault's content graph — the "Connect"
 * substrate. Where HITS (lib/hits.ts) scores global hub/authority, PPR scores
 * every note by its graph proximity to a set of SEED notes (the personalization
 * vector), so "what connects to where I'm standing" is a first-class query.
 *
 * Two pure, file-I/O-free pieces so both are unit-testable on synthetic graphs:
 *   buildContentGraph  — index records → weighted undirected adjacency
 *   personalizedPageRank — adjacency + seed distribution → proximity scores
 *
 * No embeddings, no persistent vector index (CLAUDE.md "No RAG"): the graph is
 * the frontmatter/backlink structure the indexer already emits, rebuilt per call.
 */

import type { SourceNote, ConceptNote, MocNote } from "./types.js";

/** Undirected weighted adjacency: node -> (neighbor -> summed edge weight). */
export type Adjacency = Map<string, Map<string, number>>;

/** One backlink-index.jsonl record: who links TO `target`, and how often. */
export interface BacklinkRecord {
  target: string;
  backlinks: { source: string; count: number }[];
}

export interface ContentGraphInput {
  sources: SourceNote[];
  concepts: ConceptNote[];
  mocs: MocNote[];
  /** Optional body-wikilink structure; edges weighted by repeat-link count. */
  backlinks?: BacklinkRecord[];
}

/** Edge weights by kind. Defaults match the validated Connect eval. */
export interface EdgeWeights {
  /** buildsOn / comparesWith / usesMethod — the strongest, typed relations. */
  rel: number;
  /** source→concept membership. */
  concept: number;
  /** source→MOC and MOC→source membership. */
  moc: number;
}

export const DEFAULT_EDGE_WEIGHTS: EdgeWeights = { rel: 3, concept: 1, moc: 1 };

export interface PprOptions {
  /** Teleport-back (restart) probability's complement; higher = wander farther. */
  alpha?: number;
  maxIterations?: number;
  /** Stop once the L1 change across the vector drops below this. */
  tolerance?: number;
}

/**
 * Build the weighted undirected content graph from index records. Node ids are
 * the records' `path` strings — the caller MUST pass all record paths and
 * backlink paths in ONE consistent space (this repo uses vault-relative).
 * Relations reference notes by title / concept name / MOC name; those are
 * resolved to paths, and any unresolved or dangling endpoint is skipped.
 */
export function buildContentGraph(
  input: ContentGraphInput,
  weights: EdgeWeights = DEFAULT_EDGE_WEIGHTS,
): Adjacency {
  const { sources, concepts, mocs, backlinks = [] } = input;

  const nodes = new Set<string>();
  for (const s of sources) nodes.add(s.path);
  for (const c of concepts) nodes.add(c.path);
  for (const m of mocs) nodes.add(m.path);

  const titleToPath = new Map<string, string>();
  for (const s of sources) titleToPath.set(s.title, s.path);
  const conceptNameToPath = new Map<string, string>();
  for (const c of concepts) conceptNameToPath.set(c.name, c.path);
  const mocNameToPath = new Map<string, string>();
  for (const m of mocs) mocNameToPath.set(m.name, m.path);

  const adj: Adjacency = new Map();
  const addEdge = (a: string, b: string | undefined, w: number) => {
    if (!a || !b || a === b || !nodes.has(a) || !nodes.has(b) || w <= 0) return;
    if (!adj.has(a)) adj.set(a, new Map());
    if (!adj.has(b)) adj.set(b, new Map());
    adj.get(a)!.set(b, (adj.get(a)!.get(b) ?? 0) + w);
    adj.get(b)!.set(a, (adj.get(b)!.get(a) ?? 0) + w);
  };

  for (const s of sources) {
    for (const cn of s.concepts) addEdge(s.path, conceptNameToPath.get(cn), weights.concept);
    for (const mn of s.mocs) addEdge(s.path, mocNameToPath.get(mn), weights.moc);
    for (const t of [...s.buildsOn, ...s.comparesWith, ...s.usesMethod]) {
      addEdge(s.path, titleToPath.get(t) ?? conceptNameToPath.get(t), weights.rel);
    }
  }
  for (const m of mocs) {
    for (const t of m.sources) addEdge(m.path, titleToPath.get(t), weights.moc);
  }
  for (const b of backlinks) {
    for (const bl of b.backlinks) addEdge(bl.source, b.target, bl.count);
  }
  return adj;
}

/**
 * Personalized PageRank via power iteration. `personalization` is the restart
 * distribution (seed node -> weight); it is normalized internally, so raw
 * weights are fine. Dangling nodes (no out-edges) redistribute their mass to
 * the personalization vector each step, keeping the chain stochastic. Returns a
 * score for every node in the graph (plus any personalization-only nodes),
 * summing to ~1.
 */
export function personalizedPageRank(
  adj: Adjacency,
  personalization: Map<string, number>,
  options: PprOptions = {},
): Map<string, number> {
  const { alpha = 0.85, maxIterations = 200, tolerance = 1e-9 } = options;

  const nodes = new Set<string>(adj.keys());
  for (const n of personalization.keys()) nodes.add(n);
  const nodeList = [...nodes];
  if (nodeList.length === 0) return new Map();

  const persSum = [...personalization.values()].reduce((a, b) => a + b, 0) || 1;
  const teleport = new Map<string, number>(
    nodeList.map((n) => [n, (personalization.get(n) ?? 0) / persSum]),
  );
  const outWeight = new Map<string, number>(
    nodeList.map((n) => [n, [...(adj.get(n)?.values() ?? [])].reduce((a, b) => a + b, 0)]),
  );

  let rank = new Map<string, number>(teleport);
  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Map<string, number>(
      nodeList.map((n) => [n, (1 - alpha) * teleport.get(n)!]),
    );
    let dangling = 0;
    for (const n of nodeList) {
      const rn = rank.get(n)!;
      const ow = outWeight.get(n)!;
      if (ow === 0) {
        dangling += rn;
        continue;
      }
      for (const [nb, w] of adj.get(n)!) {
        next.set(nb, next.get(nb)! + alpha * rn * (w / ow));
      }
    }
    if (dangling > 0) {
      for (const n of nodeList) next.set(n, next.get(n)! + alpha * dangling * teleport.get(n)!);
    }
    let delta = 0;
    for (const n of nodeList) delta += Math.abs(next.get(n)! - rank.get(n)!);
    rank = next;
    if (delta < tolerance) break;
  }
  return rank;
}
