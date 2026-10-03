/**
 * Shortest link path between two notes, penalising hubs.
 *
 * Without the penalty nearly every path in a vault runs through a MOC or a
 * hub concept — technically short, and useless as an explanation of how two
 * notes relate. Each INTERMEDIATE node costs `1 + 0.5·ln(1 + degree)`, so a
 * path through specific notes beats one through a 300-link hub unless the hub
 * route is much shorter. Endpoints are never penalised.
 *
 * Edges are traversed in both directions (a backlink is as much a relation as
 * a link) but each step reports the direction it was actually linked.
 * Stronger edges are slightly cheaper (typed relations weigh 3). `blocked`
 * nodes are impassable — a sealed note can be neither a hop nor an endpoint.
 *
 * Dijkstra with a binary heap; deterministic tie-break on node id.
 */

import { type Csr, type Adjacency, adj, EDGE_KINDS, type EdgeKind } from "./csr.js";

export type PathOptions = {
  maxHops?: number;
  avoidHubs?: boolean;
  blocked?: ReadonlySet<number>;
};

export type PathStep = { from: number; to: number; kind: EdgeKind; w: number; dir: "out" | "in" };
export type PathResult = { steps: PathStep[]; cost: number } | null;

class Heap {
  private a: [number, number, number][] = []; // [cost, hops, id]
  get size() { return this.a.length; }
  push(x: [number, number, number]) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
    }
  }
  pop(): [number, number, number] | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}
const less = (x: [number, number, number], y: [number, number, number]) =>
  x[0] < y[0] - 1e-12 || (Math.abs(x[0] - y[0]) <= 1e-12 && (x[2] < y[2]));

export function hubCost(deg: number): number {
  return 1 + 0.5 * Math.log(1 + deg);
}

export function findPath(graph: Csr | Adjacency, from: number, to: number, opts: PathOptions = {}): PathResult {
  const maxHops = opts.maxHops ?? 4;
  const avoidHubs = opts.avoidHubs ?? true;
  const blocked = opts.blocked ?? new Set<number>();
  const g = adj(graph);
  if (from === to || blocked.has(from) || blocked.has(to)) return null;
  if (from < 0 || to < 0 || from >= g.n || to >= g.n) return null;

  const dist = new Map<number, number>([[from, 0]]);
  const hops = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, PathStep>();
  const heap = new Heap();
  heap.push([0, 0, from]);

  const stepCost = (v: number, w: number) => {
    const node = v === to || !avoidHubs ? 1 : hubCost(g.degOf(v));
    // Typed relations (w=3) are a little cheaper than a single body link.
    return node / (1 + 0.25 * Math.min(w - 1, 2));
  };

  while (heap.size > 0) {
    const [d, h, u] = heap.pop()!;
    if (d > (dist.get(u) ?? Infinity) + 1e-12) continue;
    if (u === to) break;
    if (h >= maxHops) continue;
    const relax = (v: number, w: number, kindIdx: number, dir: "out" | "in") => {
      if (blocked.has(v) || v === u) return;
      const nd = d + stepCost(v, w);
      const old = dist.get(v);
      if (old === undefined || nd < old - 1e-12 || (Math.abs(nd - old) <= 1e-12 && u < (prev.get(v)?.from ?? Infinity))) {
        dist.set(v, nd);
        hops.set(v, h + 1);
        prev.set(v, { from: u, to: v, kind: EDGE_KINDS[kindIdx], w, dir });
        heap.push([nd, h + 1, v]);
      }
    };
    g.eachOut(u, (v, w, k) => relax(v, w, k, "out"));
    g.eachIn(u, (v, w, k) => relax(v, w, k, "in"));
  }

  if (!prev.has(to)) return null;
  const steps: PathStep[] = [];
  let cur = to;
  while (cur !== from) {
    const s = prev.get(cur)!;
    steps.push(s);
    cur = s.from;
  }
  steps.reverse();
  return { steps, cost: dist.get(to)! };
}
