/**
 * CSR, push-PPR, hub-penalised path, HITS — on invented graphs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCsr, outEdges, inEdges, csrToJson, csrFromJson, degree, type EdgeInput } from "./csr.ts";
import { pushPpr, topPool } from "./walk.ts";
import { findPath } from "./path.ts";
import { hitsCsr } from "./hits.ts";
import { computeHITS } from "../../../scripts/lib/hits.ts";
import { buildContentGraph, personalizedPageRank } from "../../../scripts/lib/ppr.ts";

// 0 Alpha Report → 1 Gamma Term, 0 → 2 Beta Theory (buildsOn), 3 Delta Note → 1,
// 4 Hub MOC links everything, 5 isolated, 6 Sealed Note between 2 and 7, 7 Far Note.
const E: EdgeInput[] = [
  { from: 0, to: 1, kind: "body" },
  { from: 0, to: 1, kind: "body" }, // repeat → merged weight 2
  { from: 0, to: 2, kind: "buildsOn" },
  { from: 3, to: 1, kind: "body" },
  { from: 4, to: 0, kind: "moc" },
  { from: 4, to: 1, kind: "moc" },
  { from: 4, to: 2, kind: "moc" },
  { from: 4, to: 3, kind: "moc" },
  { from: 2, to: 6, kind: "body" },
  { from: 6, to: 7, kind: "body" },
  { from: 1, to: 1, kind: "body" }, // self-loop dropped
];

test("CSR merges duplicates, drops self-loops, exposes out and in rows", () => {
  const g = buildCsr(8, E);
  const out0 = outEdges(g, 0);
  assert.deepEqual(out0.map((e) => [e.id, e.kind, e.w]), [[1, "body", 2], [2, "buildsOn", 3]]);
  assert.deepEqual(inEdges(g, 1).map((e) => e.id), [0, 3, 4]);
  assert.equal(degree(g, 5), 0);
  assert.equal(outEdges(g, 1).length, 0, "self-loop dropped");
});

test("CSR is order-independent and round-trips through JSON", () => {
  const a = buildCsr(8, E);
  const b = buildCsr(8, [...E].reverse());
  assert.deepEqual(csrToJson(a), csrToJson(b));
  const c = csrFromJson(8, JSON.parse(JSON.stringify(csrToJson(a))));
  assert.deepEqual(csrToJson(c), csrToJson(a));
  assert.deepEqual([...c.wdeg], [...a.wdeg]);
});

test("push-PPR conserves mass and absorbs at blocked nodes", () => {
  const g = buildCsr(8, E);
  const seeds = new Map([[0, 1]]);
  const res = pushPpr(g, seeds, { epsilon: 1e-9, blocked: new Set([6]) });
  let sum = res.absorbed + res.residual;
  for (const v of res.p.values()) sum += v;
  assert.ok(Math.abs(sum - 1) < 1e-6, `mass ${sum}`);
  assert.ok(res.absorbed > 0, "some mass hit the sealed node");
  assert.ok(!res.p.has(6), "blocked node never scored");
  assert.ok(!res.p.has(7), "nothing reachable only through the sealed node");
  const pool = topPool(res, seeds, 10);
  assert.ok(!pool.some((p) => p.id === 0), "seed excluded");
  assert.ok(pool.every((p) => p.via !== null), "every pooled node has a via edge");
});

test("a seed adjacent only to blocked nodes yields an empty pool", () => {
  const g = buildCsr(3, [{ from: 0, to: 1, kind: "body" }, { from: 1, to: 2, kind: "body" }]);
  const res = pushPpr(g, new Map([[0, 1]]), { blocked: new Set([1]) });
  assert.equal(topPool(res, new Map([[0, 1]]), 5).length, 0);
});

test("push-PPR ranks like power-iteration PPR on the same undirected graph", () => {
  // Same graph through the legacy builder (paths as ids, backlinks as body edges).
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => `${x}.md`);
  const backlinks = new Map<string, { source: string; count: number }[]>();
  for (const e of buildCsr(8, E).outTo.length ? E : []) {
    if (e.from === e.to) continue;
    const t = names[e.to];
    const list = backlinks.get(t) ?? [];
    const w = e.kind === "buildsOn" ? 3 : 1;
    const ex = list.find((x) => x.source === names[e.from]);
    if (ex) ex.count += w; else list.push({ source: names[e.from], count: w });
    backlinks.set(t, list);
  }
  const adj = buildContentGraph({
    sources: names.map((p) => ({ path: p, title: p, concepts: [], mocs: [], buildsOn: [], comparesWith: [], usesMethod: [] })) as never,
    concepts: [], mocs: [],
    backlinks: [...backlinks].map(([target, bl]) => ({ target, backlinks: bl })),
  });
  const power = personalizedPageRank(adj, new Map([[names[3], 1]]));
  const push = pushPpr(buildCsr(8, E), new Map([[3, 1]]), { epsilon: 1e-10 });
  const orderPower = names.map((n, i) => [i, power.get(n) ?? 0] as const).filter(([i]) => i !== 3 && i !== 5)
    .sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const orderPush = topPool(push, new Map([[3, 1]]), 8).map((p) => p.id);
  assert.deepEqual(orderPush, orderPower);
});

test("path avoids hubs and never crosses a blocked node", () => {
  // 3 → 1 → 0 → 2 is specific; 3 → 4(hub) → 2 is shorter but through the MOC.
  const extra: EdgeInput[] = [...E];
  for (let i = 10; i < 40; i++) extra.push({ from: 4, to: i, kind: "moc" }); // make 4 a real hub
  const g = buildCsr(40, extra);
  const viaHub = findPath(g, 3, 2, { avoidHubs: false });
  assert.deepEqual(viaHub!.steps.map((s) => s.to), [4, 2]);
  const specific = findPath(g, 3, 2);
  assert.ok(!specific!.steps.some((s) => s.to === 4), "hub avoided");
  assert.equal(specific!.steps.at(-1)!.to, 2);
  assert.equal(specific!.steps[0].dir, "out", "3 links to 1 (out)");
  assert.equal(findPath(g, 2, 7, { blocked: new Set([6]) }), null, "sealed node impassable");
  assert.equal(findPath(g, 2, 6, { blocked: new Set([6]) }), null, "sealed endpoint");
  assert.equal(findPath(g, 0, 5), null, "isolated");
  assert.equal(findPath(g, 2, 7, { maxHops: 1 }), null, "hop cap");
});

test("HITS over CSR matches the legacy map-based HITS; excluded nodes score zero", () => {
  const g = buildCsr(8, E);
  const { hub, auth } = hitsCsr(g);
  const legacy = computeHITS(
    E.filter((e) => e.from !== e.to).map((e) => ({ source: String(e.from), target: String(e.to), weight: e.kind === "buildsOn" ? 3 : 1 })),
  );
  for (const [id, s] of legacy) {
    assert.ok(Math.abs(hub[Number(id)] - s.hub) < 1e-4, `hub ${id}`);
    assert.ok(Math.abs(auth[Number(id)] - s.authority) < 1e-4, `auth ${id}`);
  }
  assert.ok(auth[1] > auth[3], "Gamma Term (3 in-links) out-ranks Delta Note");
  const pub = hitsCsr(g, { exclude: new Set([6]) });
  assert.equal(pub.hub[6], 0);
  assert.equal(pub.auth[6], 0);
  assert.equal(pub.auth[7], 0, "only reachable via the excluded node");
});
