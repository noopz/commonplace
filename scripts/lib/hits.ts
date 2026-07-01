/**
 * HITS (Hyperlink-Induced Topic Search) — Kleinberg's hub/authority algorithm,
 * pure and file-I/O-free so it's unit-testable on small synthetic graphs.
 *
 * hub(p)       = sum of authority(q) over out-neighbors q of p
 * authority(p) = sum of hub(q) over in-neighbors q of p
 * Both vectors are L2-normalized after each iteration to prevent unbounded growth.
 */

export interface HitsEdge {
  source: string;
  target: string;
  /** Repeated-link weight, e.g. backlink count. Defaults to 1. */
  weight?: number;
}

export interface HitsScore {
  hub: number;
  authority: number;
}

export interface HitsOptions {
  maxIterations?: number;
  /** Stop early once the L2 change in both vectors combined drops below this. */
  tolerance?: number;
}

function l2Normalize(scores: Map<string, number>): void {
  let sumSquares = 0;
  for (const v of scores.values()) sumSquares += v * v;
  if (sumSquares === 0) return; // all-zero vector (e.g. no in/out edges) — nothing to scale
  const norm = Math.sqrt(sumSquares);
  for (const [k, v] of scores) scores.set(k, v / norm);
}

function l2Delta(a: Map<string, number>, b: Map<string, number>): number {
  let sumSquares = 0;
  for (const [k, v] of a) {
    const diff = v - (b.get(k) ?? 0);
    sumSquares += diff * diff;
  }
  return Math.sqrt(sumSquares);
}

export function computeHITS(
  edges: HitsEdge[],
  options: HitsOptions = {}
): Map<string, HitsScore> {
  const { maxIterations = 50, tolerance = 1e-6 } = options;

  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.source);
    nodes.add(e.target);
  }

  const outEdges = new Map<string, { target: string; weight: number }[]>();
  const inEdges = new Map<string, { source: string; weight: number }[]>();
  for (const n of nodes) {
    outEdges.set(n, []);
    inEdges.set(n, []);
  }
  for (const e of edges) {
    const weight = e.weight ?? 1;
    outEdges.get(e.source)!.push({ target: e.target, weight });
    inEdges.get(e.target)!.push({ source: e.source, weight });
  }

  let hub = new Map<string, number>();
  let authority = new Map<string, number>();
  for (const n of nodes) {
    hub.set(n, 1);
    authority.set(n, 1);
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    const newAuthority = new Map<string, number>();
    for (const n of nodes) {
      let sum = 0;
      for (const { source, weight } of inEdges.get(n)!) sum += weight * hub.get(source)!;
      newAuthority.set(n, sum);
    }
    l2Normalize(newAuthority);

    const newHub = new Map<string, number>();
    for (const n of nodes) {
      let sum = 0;
      for (const { target, weight } of outEdges.get(n)!) sum += weight * newAuthority.get(target)!;
      newHub.set(n, sum);
    }
    l2Normalize(newHub);

    const delta = l2Delta(hub, newHub) + l2Delta(authority, newAuthority);
    hub = newHub;
    authority = newAuthority;
    if (delta < tolerance) break;
  }

  const result = new Map<string, HitsScore>();
  for (const n of nodes) {
    result.set(n, { hub: hub.get(n)!, authority: authority.get(n)! });
  }
  return result;
}
