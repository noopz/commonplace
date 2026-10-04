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
  "contests",
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
  contests: 3,
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
  // Bucket by source (counting sort), then sort and merge each row by
  // (to, kind): O(m log d) with no string keys — the 50× vault has 300k+
  // edges and a Map keyed by "from:to:kind" dominated the rebuild.
  const cnt = new Int32Array(n + 1);
  const keep: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (e.from === e.to || e.from < 0 || e.to < 0 || e.from >= n || e.to >= n) continue;
    const w = e.w ?? KIND_WEIGHT[e.kind];
    if (!(w > 0)) continue;
    keep.push(i);
    cnt[e.from + 1]++;
  }
  for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
  const order = new Int32Array(keep.length);
  const fillPos = cnt.slice(0, n);
  for (const i of keep) order[fillPos[edges[i].from]++] = i;

  const tmpTo: number[] = [];
  const tmpKind: number[] = [];
  const tmpW: number[] = [];
  const outPtr = new Int32Array(n + 1);
  const row: number[] = [];
  for (let u = 0; u < n; u++) {
    row.length = 0;
    for (let k = cnt[u]; k < cnt[u + 1]; k++) row.push(order[k]);
    row.sort((x, y) => edges[x].to - edges[y].to || KIND_INDEX[edges[x].kind] - KIND_INDEX[edges[y].kind]);
    let lastTo = -1;
    let lastKind = -1;
    for (const i of row) {
      const e = edges[i];
      const kind = KIND_INDEX[e.kind];
      const w = e.w ?? KIND_WEIGHT[e.kind];
      if (e.to === lastTo && kind === lastKind) {
        tmpW[tmpW.length - 1] += w;
        continue;
      }
      tmpTo.push(e.to);
      tmpKind.push(kind);
      tmpW.push(w);
      lastTo = e.to;
      lastKind = kind;
    }
    outPtr[u + 1] = tmpTo.length;
  }
  const m = tmpTo.length;
  const outTo = Int32Array.from(tmpTo);
  const outKind = Uint8Array.from(tmpKind);
  const outW = Float64Array.from(tmpW);
  const inPtr = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) inPtr[outTo[e] + 1]++;
  for (let i = 0; i < n; i++) inPtr[i + 1] += inPtr[i];
  const inFrom = new Int32Array(m);
  const inKind = new Uint8Array(m);
  const inW = new Float64Array(m);
  const ic = inPtr.slice(0, n);
  const wdeg = new Float64Array(n);
  // Visiting sources in id order leaves every in-row sorted by source id.
  for (let u = 0; u < n; u++) {
    for (let e = outPtr[u]; e < outPtr[u + 1]; e++) {
      const v = outTo[e];
      const k = ic[v]++;
      inFrom[k] = u;
      inKind[k] = outKind[e];
      inW[k] = outW[e];
      wdeg[u] += outW[e];
      wdeg[v] += outW[e];
    }
  }
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

/**
 * Read-only adjacency the walks and paths run over. A `Csr` is one; the
 * in-memory overlay a journal patch or an opened shard produces
 * (`hooks/lib/index/view.ts`) is another — so a patched graph is walkable
 * without rebuilding the CSR.
 */
export interface Adjacency {
  readonly n: number;
  eachOut(u: number, cb: (v: number, w: number, kindIdx: number) => void): void;
  eachIn(u: number, cb: (v: number, w: number, kindIdx: number) => void): void;
  /** Weighted degree over out ∪ in. */
  wdegOf(u: number): number;
  /** Unweighted degree over out ∪ in. */
  degOf(u: number): number;
}

const wrapped = new WeakMap<Csr, Adjacency>();

/** View a Csr (or pass an Adjacency through). */
export function adj(g: Csr | Adjacency): Adjacency {
  if (!("outPtr" in g)) return g;
  let a = wrapped.get(g);
  if (!a) {
    a = {
      n: g.n,
      eachOut: (u, cb) => {
        for (let e = g.outPtr[u]; e < g.outPtr[u + 1]; e++) cb(g.outTo[e], g.outW[e], g.outKind[e]);
      },
      eachIn: (u, cb) => {
        for (let e = g.inPtr[u]; e < g.inPtr[u + 1]; e++) cb(g.inFrom[e], g.inW[e], g.inKind[e]);
      },
      wdegOf: (u) => g.wdeg[u] ?? 0,
      degOf: (u) => degree(g, u),
    };
    wrapped.set(g, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// Compact on-disk form (`graph/main.csr.json`): OUT rows only, as base64 typed
// arrays — P0 measured base64 Int32 loading 2× faster than JSON arrays, and
// in-rows are a counting sort away. Weights are clamped to 1..255 (a note
// citing one target more than 255 times ranks no differently).
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INV[B64.charCodeAt(i)] = i;

export function bytesToB64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const x = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += B64[x >> 18] + B64[(x >> 12) & 63] + B64[(x >> 6) & 63] + B64[x & 63];
    if (chunk.length > 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const x = bytes[i] << 16;
    chunk += B64[x >> 18] + B64[(x >> 12) & 63] + "==";
  } else if (rest === 2) {
    const x = (bytes[i] << 16) | (bytes[i + 1] << 8);
    chunk += B64[x >> 18] + B64[(x >> 12) & 63] + B64[(x >> 6) & 63] + "=";
  }
  parts.push(chunk);
  return parts.join("");
}

export function b64ToBytes(s: string): Uint8Array {
  let len = s.length;
  while (len > 0 && s[len - 1] === "=") len--;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const v = B64_INV[s.charCodeAt(i)];
    if (v < 0) throw new Error("bad base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out;
}

const i32ToB64 = (a: Int32Array) => bytesToB64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const b64ToI32 = (s: string) => {
  const b = b64ToBytes(s);
  return new Int32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
};

export type CsrPacked = { n: number; m: number; ptr: string; to: string; kind: string; w: string };

export function packCsr(g: Csr): CsrPacked {
  const w = new Uint8Array(g.outW.length);
  for (let i = 0; i < w.length; i++) w[i] = Math.max(1, Math.min(255, Math.round(g.outW[i])));
  return {
    n: g.n,
    m: g.outTo.length,
    ptr: i32ToB64(g.outPtr),
    to: i32ToB64(g.outTo),
    kind: bytesToB64(g.outKind),
    w: bytesToB64(w),
  };
}

/** Rebuild the full CSR (in-rows by counting sort, wdeg) from the packed out rows. */
export function unpackCsr(p: CsrPacked): Csr {
  const n = p.n;
  const outPtr = b64ToI32(p.ptr);
  const outTo = b64ToI32(p.to);
  const outKind = b64ToBytes(p.kind);
  const wb = b64ToBytes(p.w);
  const m = outTo.length;
  const outW = new Float64Array(m);
  for (let i = 0; i < m; i++) outW[i] = wb[i];
  const inPtr = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) inPtr[outTo[e] + 1]++;
  for (let i = 0; i < n; i++) inPtr[i + 1] += inPtr[i];
  const inFrom = new Int32Array(m);
  const inKind = new Uint8Array(m);
  const inW = new Float64Array(m);
  const fill = inPtr.slice(0, n);
  const wdeg = new Float64Array(n);
  for (let u = 0; u < n; u++) {
    for (let e = outPtr[u]; e < outPtr[u + 1]; e++) {
      const v = outTo[e];
      const k = fill[v]++;
      inFrom[k] = u;
      inKind[k] = outKind[e];
      inW[k] = outW[e];
      wdeg[u] += outW[e];
      wdeg[v] += outW[e];
    }
  }
  return { n, outPtr, outTo, outKind, outW, inPtr, inFrom, inKind, inW, wdeg };
}
