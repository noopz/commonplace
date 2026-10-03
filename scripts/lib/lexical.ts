/**
 * Deterministic lexical relevance over note text — the query-focusing term in
 * the Connect score and the source of PPR seed nodes. idf-weighted query-term
 * overlap (BM25-lite): frequent words count for little, rare ones for a lot.
 * Lexical only, no embeddings (CLAUDE.md "No RAG").
 */

import { tokenize as coreTokenize } from "../../hooks/lib/core/text.js";

/** node id -> tokenizable text (title + abstraction + tags/anchors, caller's choice). */
export interface LexNode {
  path: string;
  text: string;
}

/** Shared tokenizer (hooks/lib/core/text.ts): length >= 3, minus the one stopword set. */
export function tokenize(s: string): string[] {
  return coreTokenize(s);
}

/**
 * idf-weighted overlap score per node. `df` is document frequency over the
 * given node set, so idf is corpus-relative: a term shared by half the vault
 * barely moves a score, a term in three notes dominates it. Nodes with no
 * overlap are omitted from the returned map (score 0).
 */
export function lexicalScores(query: string, nodes: LexNode[]): Map<string, number> {
  const queryTerms = [...new Set(tokenize(query))];
  const nodeTokens = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const n of nodes) {
    const toks = new Set(tokenize(n.text));
    nodeTokens.set(n.path, toks);
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = nodes.length;
  const idf = (t: string) => Math.log(1 + N / ((df.get(t) ?? 0) + 1));

  const out = new Map<string, number>();
  for (const n of nodes) {
    const toks = nodeTokens.get(n.path)!;
    let s = 0;
    for (const t of queryTerms) if (toks.has(t)) s += idf(t);
    if (s > 0) out.set(n.path, s);
  }
  return out;
}

/** Top-k nodes by lexical score, as a normalized distribution (weights sum to 1). */
export function topLexicalSeeds(scores: Map<string, number>, k: number): Map<string, number> {
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  const sum = top.reduce((acc, [, v]) => acc + v, 0) || 1;
  return new Map(top.map(([n, v]) => [n, v / sum]));
}
