/**
 * In-module "Connect" (plan §2.6): the same pool `commonplace connect` builds —
 *   score(n) = norm(PPR(n)) + λ · norm(lexical(n)),  λ = 0.25
 * with PPR personalised on the top lexical seeds — but over the loaded graph
 * view, so it sees exactly what this session may see (sealed shards absorb at
 * their sentinels) and costs ~2 ms instead of a ~400 ms subprocess.
 *
 * Seeds are weighted by kind, after HippoRAG 2 (Gutiérrez et al. 2025): a
 * concept or MOC hit is a phrase node — the shared idea that bridges the
 * sources citing it — so it seeds at full weight, while a source hit seeds at
 * `docSeed` of its lexical score. Without `kindOf` every seed is a document.
 * `eval:search --tune` picks seedK, restart and docSeed on the vault's gold.
 *
 * A pool is a jumping-off point, never a relevance verdict (CLAUDE.md "No
 * RAG"): the ambient pass still reads the note and asks the judge.
 *
 * Pure.
 */

import type { VaultView } from "../index/view.js";
import { pushPpr } from "../graph/walk.js";

export type ConnectCandidate = { id: number; ppr: number; lex: number; score: number };

export type ConnectOptions = {
  k?: number;
  lambda?: number;
  seedK?: number;
  restart?: number;
  /** Seed weight of a source note relative to a concept/MOC (1 = no distinction). */
  docSeed?: number;
  kindOf?: (id: number) => string | undefined;
};

/**
 * restart 0.5 (HippoRAG 2's damping) keeps the walk near its seeds. The kind
 * weighting measured WORSE on a real vault (docSeed 0.2 / 0.5 / 1 → Connect MRR
 * 0.385 / 0.469 / 0.495): there the sources are the targets and many concept
 * notes are stubs, so it is off by default and left to the tuner.
 */
export const CONNECT = { seedK: 5, restart: 0.5, docSeed: 1, lambda: 0.25 } as const;

export function connectPool(view: VaultView, query: string, opts: ConnectOptions = {}): ConnectCandidate[] {
  const k = opts.k ?? 6;
  const lambda = opts.lambda ?? CONNECT.lambda;
  const seedK = opts.seedK ?? CONNECT.seedK;
  const docSeed = opts.docSeed ?? CONNECT.docSeed;
  const lexHits = view.search(query, { limit: Math.max(seedK, 25) });
  if (lexHits.length === 0) return [];
  const seeds = new Map<number, number>();
  for (const h of lexHits.slice(0, seedK)) {
    const kind = opts.kindOf?.(h.id);
    seeds.set(h.id, h.score * (kind === "concept" || kind === "moc" ? 1 : docSeed));
  }
  const res = pushPpr(view, seeds, { restart: opts.restart ?? CONNECT.restart, epsilon: 1e-5, blocked: view.sentinels });
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
