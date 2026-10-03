/**
 * Compressed sparse row adjacency for the vault's content graph.
 *
 * Integer node ids, typed arrays, out- AND in-rows, so "every link out of X"
 * and "every link into X" are both one slice — no scan over the whole edge
 * list, which is what grepping `backlink-index.jsonl` amounted to.
 *
 * Sandbox-safe (no Node): built by the indexer (Node) and held in memory by
 * the hooks module. Edge KIND is kept per edge so callers can follow only
 * typed relations, only body links, etc.
 */

export const EDGE_KINDS = [
  "body",
  "concept",
  "moc",
  "buildsOn",
  "comparesWith",
  "usesMethod",
  "supersedes",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];
export const KIND_INDEX: Record<EdgeKind, number> = Object.fromEntries(
  EDGE_KINDS.map((k, i) => [k, i]),
) as Record<EdgeKind, number>;

/** Default weight per kind when a caller has no count (ppr.ts DEFAULT_EDGE_WEIGHTS). */
export const KIND_WEIGHT: Record<EdgeKind, number> = {
  body: 1,
  concept: 1,
  moc: 1,
  buildsOn: 3,
  comparesWith: 3,
  usesMethod: 3,
  supersedes: 3,
};

export type EdgeInput = { from: number; to: number; kind: EdgeKind; w?: number };

export type Csr = {
  /** Node count; ids are 0..n-1 (holes allowed — a retired id just has no edges). */
  n: number;
  outPtr: Int32Array;
  outTo: Int32Array;
  outKind: Uint8Array;
  outW: Float64Array;
  inPtr: Int32Array;
  inFrom: Int32Array;
  inKind: Uint8Array;
  inW: Float64Array;
  /** Weighted degree over out ∪ in (the symmetrised graph walks run on). */
  wdeg: Float64Array;
};

/**
 * Build a CSR from an edge list. Self-loops are dropped; duplicate
 * (from, to, kind) triples are merged with summed weight, so a note linking
 * the same target three times is one edge of weight 3 — the same semantics
 * as the backlink index's `count`.
 */
export function buildCsr(n: number, edges: readonly EdgeInput[]): Csr {
  const merged = new Map<string, EdgeInput & { w: number }>();
  for (const e of edges) {
    if (e.from === e.to || e.from < 0 || e.to < 0 || e.from >= n || e.to >= n) continue;
    const w = e.w ?? KIND_WEIGHT[e.kind];
    if (!(w > 0)) continue;
    const key = `${e.from}:${e.to}:${KIND_INDEX[e.kind]}`;
    const prev = merged.get(key);
    if (prev) prev.w += w;
    else merged.set(key, { from: e.from, to: e.to, kind: e.kind, w });
  }
  // Deterministic order: by from, then to, then kind — so two builds of the
  // same graph are byte-identical whatever order the edges arrived in.
  const list = [...merged.values()].sort(
    (a, b) => a.from - b.from || a.to - b.to || KIND_INDEX[a.kind] - KIND_INDEX[b.kind],
  );
  const m = list.length;
  const outPtr = new Int32Array(n + 1);
  const inPtr = new Int32Array(n + 1);
  for (const e of list) {
    outPtr[e.from + 1]++;
    inPtr[e.to + 1]++;
  }
  for (let i = 0; i < n; i++) {
    outPtr[i + 1] += outPtr[i];
    inPtr[i + 1] += inPtr[i];
  }
  const outTo = new Int32Array(m);
  const outKind = new Uint8Array(m);
  const outW = new Float64Array(m);
  const inFrom = new Int32Array(m);
  const inKind = new Uint8Array(m);
  const inW = new Float64Array(m);
  const oc = outPtr.slice(0, n);
  const ic = inPtr.slice(0, n);
  const wdeg = new Float64Array(n);
  for (const e of list) {
    const o = oc[e.from]++;
    outTo[o] = e.to;
    outKind[o] = KIND_INDEX[e.kind];
    outW[o] = e.w;
    const i = ic[e.to]++;
    inFrom[i] = e.from;
    inKind[i] = KIND_INDEX[e.kind];
    inW[i] = e.w;
    wdeg[e.from] += e.w;
    wdeg[e.to] += e.w;
  }
  // In-rows sorted by source id for determinism (the fill above already
  // visits edges in `from` order, so they are).
  return { n, outPtr, outTo, outKind, outW, inPtr, inFrom, inKind, inW, wdeg };
}

export type Neighbour = { id: number; w: number; kind: EdgeKind; dir: "out" | "in" };

/** Out-links of `u`. */
export function outEdges(g: Csr, u: number): Neighbour[] {
  const res: Neighbour[] = [];
  for (let e = g.outPtr[u]; e < g.outPtr[u + 1]; e++) {
    res.push({ id: g.outTo[e], w: g.outW[e], kind: EDGE_KINDS[g.outKind[e]], dir: "out" });
  }
  return res;
}

/** In-links (backlinks) of `u`. */
export function inEdges(g: Csr, u: number): Neighbour[] {
  const res: Neighbour[] = [];
  for (let e = g.inPtr[u]; e < g.inPtr[u + 1]; e++) {
    res.push({ id: g.inFrom[e], w: g.inW[e], kind: EDGE_KINDS[g.inKind[e]], dir: "in" });
  }
  return res;
}

/**
 * Visit every neighbour of `u` in the symmetrised graph (out ∪ in). A pair
 * linked both ways is visited twice, once per direction — walks treat that
 * as the stronger tie it is.
 */
export function forEachNeighbour(
  g: Csr,
  u: number,
  cb: (v: number, w: number, kindIdx: number) => void,
): void {
  for (let e = g.outPtr[u]; e < g.outPtr[u + 1]; e++) cb(g.outTo[e], g.outW[e], g.outKind[e]);
  for (let e = g.inPtr[u]; e < g.inPtr[u + 1]; e++) cb(g.inFrom[e], g.inW[e], g.inKind[e]);
}

/** Unweighted degree over out ∪ in — the hub penalty's input. */
export function degree(g: Csr, u: number): number {
  return g.outPtr[u + 1] - g.outPtr[u] + (g.inPtr[u + 1] - g.inPtr[u]);
}

/** Plain-JSON form for `graph/main.json` (§3.1). */
export type CsrJson = {
  ptr: number[]; to: number[]; kind: number[]; w: number[];
  iptr: number[]; from: number[]; ikind: number[]; iw: number[];
};

export function csrToJson(g: Csr): CsrJson {
  return {
    ptr: [...g.outPtr], to: [...g.outTo], kind: [...g.outKind], w: [...g.outW],
    iptr: [...g.inPtr], from: [...g.inFrom], ikind: [...g.inKind], iw: [...g.inW],
  };
}

export function csrFromJson(n: number, j: CsrJson): Csr {
  const g: Csr = {
    n,
    outPtr: Int32Array.from(j.ptr),
    outTo: Int32Array.from(j.to),
    outKind: Uint8Array.from(j.kind),
    outW: Float64Array.from(j.w),
    inPtr: Int32Array.from(j.iptr),
    inFrom: Int32Array.from(j.from),
    inKind: Uint8Array.from(j.ikind),
    inW: Float64Array.from(j.iw),
    wdeg: new Float64Array(n),
  };
  for (let u = 0; u < n; u++) {
    for (let e = g.outPtr[u]; e < g.outPtr[u + 1]; e++) {
      g.wdeg[u] += g.outW[e];
      g.wdeg[g.outTo[e]] += g.outW[e];
    }
  }
  return g;
}
