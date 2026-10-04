/**
 * Pure scoring + tuning for `eval:search` — the v2 model-facing path
 * (`vault_search` postings and the in-module Connect pool), which
 * `eval:retrieval` / `eval:connect` do not measure (they drive the v1 CLI
 * seed and connect code).
 *
 * Tuning is EvolveMem's loop without the LLM: coordinate ascent over a fixed
 * grid, a change kept only if the objective strictly improves (revert on
 * regression is the default, not a branch). With a 30-question gold set the
 * risk is fitting the set, so `crossValidate` tunes on one half and scores on
 * the other: a gain that does not survive the held-out half is noise.
 */

export const KS = [5, 8, 15, 25] as const;

export type FindResult = { id: string; type: string; rr: number; recall: Record<number, number>; firstRank: number | null };

/** Rank-based metrics of one question against its expected notes. */
export function findMetrics(id: string, type: string, expected: readonly string[], ranked: readonly string[]): FindResult {
  const exp = new Set(expected);
  const idx = ranked.findIndex((r) => exp.has(r));
  const recall: Record<number, number> = {};
  for (const k of KS) {
    const top = new Set(ranked.slice(0, k));
    recall[k] = exp.size === 0 ? 1 : [...exp].filter((e) => top.has(e)).length / exp.size;
  }
  return { id, type, rr: idx >= 0 ? 1 / (idx + 1) : 0, recall, firstRank: idx >= 0 ? idx + 1 : null };
}

export type PoolResult = { id: string; type: string; recall: number; rr: number };

export function poolResult(id: string, type: string, targets: readonly string[], pool: readonly string[]): PoolResult {
  const t = new Set(targets);
  if (t.size === 0) return { id, type, recall: 1, rr: 1 };
  const idx = pool.findIndex((p) => t.has(p));
  return { id, type, recall: pool.filter((p) => t.has(p)).length / t.size, rr: idx >= 0 ? 1 / (idx + 1) : 0 };
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export type Summary = {
  find: { n: number; mrr: number; recall: Record<number, number>; byType: Record<string, { n: number; mrr: number; r8: number }> };
  connect: { n: number; recall: number; mrr: number; byType: Record<string, { n: number; recall: number; mrr: number }> };
  objective: number;
};

/**
 * One number to climb: Find MRR + Find recall@8 (the default page) + pool
 * recall + pool MRR, equally weighted. Every part is reported beside it, so a
 * gain bought on one side at the other's expense is visible.
 */
export function summarize(find: readonly FindResult[], pool: readonly PoolResult[]): Summary {
  const recall: Record<number, number> = {};
  for (const k of KS) recall[k] = mean(find.map((f) => f.recall[k]));
  const fByType: Summary["find"]["byType"] = {};
  for (const t of [...new Set(find.map((f) => f.type))].sort()) {
    const xs = find.filter((f) => f.type === t);
    fByType[t] = { n: xs.length, mrr: mean(xs.map((x) => x.rr)), r8: mean(xs.map((x) => x.recall[8])) };
  }
  const cByType: Summary["connect"]["byType"] = {};
  for (const t of [...new Set(pool.map((p) => p.type))].sort()) {
    const xs = pool.filter((p) => p.type === t);
    cByType[t] = { n: xs.length, recall: mean(xs.map((x) => x.recall)), mrr: mean(xs.map((x) => x.rr)) };
  }
  const fMrr = mean(find.map((f) => f.rr));
  const cRec = mean(pool.map((p) => p.recall));
  const cMrr = mean(pool.map((p) => p.rr));
  return {
    find: { n: find.length, mrr: fMrr, recall, byType: fByType },
    connect: { n: pool.length, recall: cRec, mrr: cMrr, byType: cByType },
    objective: (find.length ? fMrr + recall[8] : 0) + (pool.length ? cRec + cMrr : 0),
  };
}

export type Grid<C> = { [K in keyof C]?: readonly C[K][] };

/**
 * Coordinate ascent: for each parameter in turn, try every grid value with the
 * others fixed and keep the best strictly-better one; repeat until a full pass
 * changes nothing (or `maxPasses`). Deterministic: grid order, first-best wins.
 */
export function coordinateAscent<C extends Record<string, unknown>>(
  start: C,
  grid: Grid<C>,
  score: (c: C) => number,
  maxPasses = 3,
): { best: C; score: number; evaluations: number } {
  let best = { ...start };
  let bestScore = score(best);
  let evaluations = 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const key of Object.keys(grid) as (keyof C)[]) {
      for (const v of grid[key] ?? []) {
        if (Object.is(best[key], v)) continue;
        const cand = { ...best, [key]: v };
        const s = score(cand);
        evaluations++;
        if (s > bestScore + 1e-9) {
          best = cand;
          bestScore = s;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return { best, score: bestScore, evaluations };
}

/** Stable two-way split by id (FNV-1a), so folds do not move between runs. */
export function foldOf(id: string): 0 | 1 {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 1) as 0 | 1;
}
