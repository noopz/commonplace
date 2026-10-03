/**
 * HITS hub/authority over a CSR (Kleinberg). Same semantics as
 * scripts/lib/hits.ts (weighted, L2-normalised each iteration), on typed
 * arrays so it runs over the in-memory graph without building per-node maps.
 *
 * `exclude` drops nodes from the computation entirely — used to score the
 * PUBLIC subgraph only, so a sealed note's links never shape public ranks.
 */

import type { Csr } from "./csr.js";

export function hitsCsr(
  g: Csr,
  opts: { maxIterations?: number; tolerance?: number; exclude?: ReadonlySet<number> } = {},
): { hub: Float64Array; auth: Float64Array } {
  const maxIt = opts.maxIterations ?? 50;
  const tol = opts.tolerance ?? 1e-6;
  const ex = opts.exclude ?? new Set<number>();
  const n = g.n;
  let hub = new Float64Array(n);
  let auth = new Float64Array(n);
  const live = (u: number) => !ex.has(u) && (g.outPtr[u + 1] > g.outPtr[u] || g.inPtr[u + 1] > g.inPtr[u]);
  for (let u = 0; u < n; u++) if (live(u)) { hub[u] = 1; auth[u] = 1; }

  const norm = (v: Float64Array) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += v[i] * v[i];
    if (s === 0) return;
    const k = Math.sqrt(s);
    for (let i = 0; i < n; i++) v[i] /= k;
  };

  for (let it = 0; it < maxIt; it++) {
    const na = new Float64Array(n);
    for (let u = 0; u < n; u++) {
      if (ex.has(u)) continue;
      for (let e = g.inPtr[u]; e < g.inPtr[u + 1]; e++) {
        const s = g.inFrom[e];
        if (!ex.has(s)) na[u] += g.inW[e] * hub[s];
      }
    }
    norm(na);
    const nh = new Float64Array(n);
    for (let u = 0; u < n; u++) {
      if (ex.has(u)) continue;
      for (let e = g.outPtr[u]; e < g.outPtr[u + 1]; e++) {
        const t = g.outTo[e];
        if (!ex.has(t)) nh[u] += g.outW[e] * na[t];
      }
    }
    norm(nh);
    let d = 0;
    for (let i = 0; i < n; i++) d += (nh[i] - hub[i]) ** 2 + (na[i] - auth[i]) ** 2;
    hub = nh;
    auth = na;
    if (Math.sqrt(d) < tol) break;
  }
  return { hub, auth };
}
