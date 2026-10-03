/**
 * In-module "Connect" (plan §2.6): the same pool `commonplace connect` builds —
 *   score(n) = norm(PPR(n)) + λ · norm(lexical(n)),  λ = 0.25
 * with PPR personalised on the top lexical seeds — but over the loaded graph
 * view, so it sees exactly what this session may see (sealed shards absorb at
 * their sentinels) and costs ~2 ms instead of a ~400 ms subprocess.
 *
 * A pool is a jumping-off point, never a relevance verdict (CLAUDE.md "No
 * RAG"): the ambient pass still reads the note and asks the judge.
 *
 * Pure.
 */

import type { VaultView } from "../index/view.js";
import { pushPpr } from "../graph/walk.js";

export type ConnectCandidate = { id: number; ppr: number; lex: number; score: number };

export function connectPool(
  view: VaultView,
  query: string,
  opts: { k?: number; lambda?: number; seedK?: number; restart?: number } = {},
): ConnectCandidate[] {
  const k = opts.k ?? 6;
  const lambda = opts.lambda ?? 0.25;
  const lexHits = view.search(query, { limit: Math.max(opts.seedK ?? 5, 25) });
  if (lexHits.length === 0) return [];
  const seeds = new Map<number, number>();
  for (const h of lexHits.slice(0, opts.seedK ?? 5)) seeds.set(h.id, h.score);
  const res = pushPpr(view, seeds, { restart: opts.restart ?? 0.15, epsilon: 1e-5, blocked: view.sentinels });
  const lex = new Map(lexHits.map((h) => [h.id, h.score]));
  const ids = new Set<number>([...res.p.keys(), ...lex.keys()]);
  let maxP = 0;
  let maxL = 0;
  for (const id of ids) {
    maxP = Math.max(maxP, res.p.get(id) ?? 0);
    maxL = Math.max(maxL, lex.get(id) ?? 0);
  }
  const out: ConnectCandidate[] = [];
  for (const id of ids) {
    if (!view.visible(id)) continue;
    const p = maxP > 0 ? (res.p.get(id) ?? 0) / maxP : 0;
    const l = maxL > 0 ? (lex.get(id) ?? 0) / maxL : 0;
    out.push({ id, ppr: p, lex: l, score: p + lambda * l });
  }
  return out.sort((a, b) => b.score - a.score || a.id - b.id).slice(0, k);
}
