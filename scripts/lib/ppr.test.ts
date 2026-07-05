import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContentGraph,
  personalizedPageRank,
  DEFAULT_EDGE_WEIGHTS,
  type Adjacency,
} from "./ppr.ts";
import type { SourceNote, ConceptNote, MocNote } from "./types.ts";

const src = (over: Partial<SourceNote> & { title: string; path: string }): SourceNote => ({
  domain: "d", scope: "public", tags: [], concepts: [], mocs: [],
  buildsOn: [], comparesWith: [], usesMethod: [], ...over,
});
const con = (name: string, path: string): ConceptNote => ({
  name, path, domains: ["d"], backlinkCount: 0, isStub: false,
});
const moc = (name: string, path: string, sources: string[] = []): MocNote => ({
  name, path, domains: ["d"], sourceCount: sources.length, sources, declaredCount: null,
});

test("buildContentGraph: typed relations weigh more than concept membership, edges symmetric", () => {
  const adj = buildContentGraph({
    sources: [
      src({ title: "A", path: "A.md", concepts: ["X"], buildsOn: ["B"] }),
      src({ title: "B", path: "B.md", concepts: ["X"] }),
    ],
    concepts: [con("X", "X.md")],
    mocs: [],
  });
  // A—B via buildsOn = rel weight (3); A—X and B—X via concept = 1.
  assert.equal(adj.get("A.md")!.get("B.md"), DEFAULT_EDGE_WEIGHTS.rel);
  assert.equal(adj.get("B.md")!.get("A.md"), DEFAULT_EDGE_WEIGHTS.rel); // undirected
  assert.equal(adj.get("A.md")!.get("X.md"), DEFAULT_EDGE_WEIGHTS.concept);
  assert.equal(adj.get("X.md")!.get("A.md"), DEFAULT_EDGE_WEIGHTS.concept);
});

test("buildContentGraph: dangling relation targets and self-loops are skipped", () => {
  const adj = buildContentGraph({
    sources: [src({ title: "A", path: "A.md", buildsOn: ["A", "Ghost"], concepts: ["Nope"] })],
    concepts: [],
    mocs: [],
  });
  // self-loop (A builds on A) and unresolved targets produce no edges.
  assert.equal(adj.get("A.md"), undefined);
});

test("buildContentGraph: backlink counts become edge weights", () => {
  const adj = buildContentGraph({
    sources: [src({ title: "A", path: "A.md" }), src({ title: "B", path: "B.md" })],
    concepts: [],
    mocs: [],
    backlinks: [{ target: "B.md", backlinks: [{ source: "A.md", count: 4 }] }],
  });
  assert.equal(adj.get("A.md")!.get("B.md"), 4);
});

test("personalizedPageRank: proximity to the seed decays with distance, mass ~1", () => {
  // A—B—C—D line; seed at A. Among non-seed nodes mass decays with distance
  // (B > C > D); the seed holds far more mass than a distant node (A > C).
  // (A vs B is genuinely ambiguous: pendant seed A only receives from B, while
  // central B receives from both A and C — this is correct PPR, not a bug.)
  const adj: Adjacency = new Map([
    ["A", new Map([["B", 1]])],
    ["B", new Map([["A", 1], ["C", 1]])],
    ["C", new Map([["B", 1], ["D", 1]])],
    ["D", new Map([["C", 1]])],
  ]);
  const r = personalizedPageRank(adj, new Map([["A", 1]]));
  assert.ok(r.get("B")! > r.get("C")!);
  assert.ok(r.get("C")! > r.get("D")!);
  assert.ok(r.get("A")! > r.get("C")!);
  const total = [...r.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `mass ${total} != 1`);
});

test("personalizedPageRank: different seeds yield different rankings (it is personalized)", () => {
  const adj: Adjacency = new Map([
    ["A", new Map([["B", 1]])],
    ["B", new Map([["A", 1], ["C", 1]])],
    ["C", new Map([["B", 1]])],
  ]);
  const fromA = personalizedPageRank(adj, new Map([["A", 1]]));
  const fromC = personalizedPageRank(adj, new Map([["C", 1]]));
  assert.ok(fromA.get("A")! > fromC.get("A")!);
  assert.ok(fromC.get("C")! > fromA.get("C")!);
});

test("personalizedPageRank: a dangling seed keeps mass finite and normalized", () => {
  const adj: Adjacency = new Map(); // no edges at all
  const r = personalizedPageRank(adj, new Map([["lonely", 1]]));
  assert.ok(Math.abs(r.get("lonely")! - 1) < 1e-9);
});
