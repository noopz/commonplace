/**
 * Local Personalized PageRank by forward push (Andersen–Chung–Lang 2006).
 *
 * Why push instead of power iteration (scripts/lib/ppr.ts): power iteration
 * touches every node every step, so its cost grows with the vault. Push only
 * touches nodes the residual actually reaches — cost tracks the seed's
 * neighbourhood, not vault size, which is what lets the walk stay ~ms at 50×.
 *
 * Runs on the SYMMETRISED graph (out ∪ in), matching `buildContentGraph`'s
 * undirected graph so `eval:connection` calibration carries over.
 *
 * ABSORPTION. Nodes in `blocked` (sealed private nodes / their sentinels) are
 * absorbing: residual that reaches one is dropped and counted in `absorbed`,
 * never pushed onward and never teleported back. So a walk cannot pass
 * THROUGH a sealed note to reach the public notes on its far side, and mass
 * conservation still holds: Σ estimate + Σ residual + absorbed = 1.
 *
 * Sandbox-safe; deterministic (FIFO queue, ids visited in insertion order).
 */

import { type Csr, forEachNeighbour } from "./csr.js";

export type PushOptions = {
  /** Restart (teleport) probability. 0.15 ≡ scripts/lib/ppr.ts alpha 0.85. */
  restart?: number;
  /** Push threshold per unit weighted degree. Smaller = more accurate, more work. */
  epsilon?: number;
  /** Hard cap on push operations (safety valve on pathological graphs). */
  maxPushes?: number;
  /** Absorbing nodes: residual reaching them is dropped. */
  blocked?: ReadonlySet<number>;
};

export type PushResult = {
  /** PPR estimate per node (sparse). */
  p: Map<number, number>;
  /** Mass dropped at blocked nodes. */
  absorbed: number;
  /** Residual left unpushed (below threshold). */
  residual: number;
  /**
   * For each reached node, the neighbour that sent it the most residual —
   * the "via" edge: why the walk reached it.
   */
  via: Map<number, number>;
  pushes: number;
};

export function pushPpr(
  g: Csr,
  seeds: ReadonlyMap<number, number>,
  opts: PushOptions = {},
): PushResult {
  const restart = opts.restart ?? 0.15;
  const eps = opts.epsilon ?? 1e-5;
  const maxPushes = opts.maxPushes ?? 200_000;
  const blocked = opts.blocked ?? new Set<number>();

  const p = new Map<number, number>();
  const r = new Map<number, number>();
  const via = new Map<number, number>();
  const viaMass = new Map<number, number>();
  let absorbed = 0;

  let total = 0;
  for (const [s, w] of seeds) if (w > 0 && s >= 0 && s < g.n) total += w;
  if (total === 0) return { p, absorbed: 0, residual: 0, via, pushes: 0 };

  const queue: number[] = [];
  const queued = new Set<number>();
  const enqueue = (u: number) => {
    if (!queued.has(u) && (r.get(u) ?? 0) > eps * Math.max(g.wdeg[u], 1)) {
      queued.add(u);
      queue.push(u);
    }
  };

  for (const [s, w] of seeds) {
    if (!(w > 0) || s < 0 || s >= g.n) continue;
    if (blocked.has(s)) {
      absorbed += w / total;
      continue;
    }
    r.set(s, (r.get(s) ?? 0) + w / total);
  }
  for (const s of r.keys()) enqueue(s);

  let pushes = 0;
  let head = 0;
  while (head < queue.length && pushes < maxPushes) {
    const u = queue[head++];
    queued.delete(u);
    const ru = r.get(u) ?? 0;
    const du = g.wdeg[u];
    if (ru <= eps * Math.max(du, 1)) continue;
    pushes++;
    p.set(u, (p.get(u) ?? 0) + restart * ru);
    r.set(u, 0);
    if (du === 0) {
      // Dangling (isolated) node: in the undirected graph it has no
      // neighbours, so its walk mass stays home — fold it into the estimate.
      p.set(u, (p.get(u) ?? 0) + (1 - restart) * ru);
      continue;
    }
    const spread = (1 - restart) * ru;
    forEachNeighbour(g, u, (v, w) => {
      const share = (spread * w) / du;
      if (blocked.has(v)) {
        absorbed += share;
        return;
      }
      r.set(v, (r.get(v) ?? 0) + share);
      if (share > (viaMass.get(v) ?? 0)) {
        viaMass.set(v, share);
        via.set(v, u);
      }
      enqueue(v);
    });
    if (head > 4096 && head * 2 > queue.length) {
      queue.splice(0, head);
      head = 0;
    }
  }

  let residual = 0;
  for (const v of r.values()) residual += v;
  return { p, absorbed, residual, via, pushes };
}

export type PoolEntry = { id: number; score: number; via: number | null };

/**
 * Rank the walk's estimate into a pool of k, excluding the seeds themselves
 * and anything in `exclude`. Ties break by id so the pool is deterministic.
 */
export function topPool(
  res: PushResult,
  seeds: ReadonlyMap<number, number>,
  k: number,
  exclude: ReadonlySet<number> = new Set(),
): PoolEntry[] {
  return [...res.p.entries()]
    .filter(([id]) => !seeds.has(id) && !exclude.has(id))
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, Math.max(0, k))
    .map(([id, score]) => ({ id, score, via: res.via.get(id) ?? null }));
}
