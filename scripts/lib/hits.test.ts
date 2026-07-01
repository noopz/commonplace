import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHITS } from "./hits.ts";

test("bowtie graph: hubs that link to more shared authorities score higher", () => {
  // hub1 and hub2 both link to auth1 and auth2; "other" links only to auth1.
  const scores = computeHITS([
    { source: "hub1", target: "auth1" },
    { source: "hub1", target: "auth2" },
    { source: "hub2", target: "auth1" },
    { source: "hub2", target: "auth2" },
    { source: "other", target: "auth1" },
  ]);

  const hub1 = scores.get("hub1")!;
  const hub2 = scores.get("hub2")!;
  const other = scores.get("other")!;
  const auth1 = scores.get("auth1")!;
  const auth2 = scores.get("auth2")!;

  // hub1 and hub2 are structurally identical — equal hub scores, both higher than "other".
  assert.ok(Math.abs(hub1.hub - hub2.hub) < 1e-9);
  assert.ok(hub1.hub > other.hub);

  // auth1 receives links from three hubs, auth2 from two — auth1 wins.
  assert.ok(auth1.authority > auth2.authority);

  // Pure hubs never receiving in-links have zero authority.
  assert.equal(hub1.authority, 0);
  assert.equal(other.authority, 0);
  // Pure authorities never linking out have zero hub score.
  assert.equal(auth1.hub, 0);
});

test("isolated node with no edges never appears (edge list defines the node set)", () => {
  const scores = computeHITS([{ source: "a", target: "b" }]);
  assert.equal(scores.size, 2);
  assert.equal(scores.has("isolated"), false);
});

test("simple directed cycle converges without NaN and stays non-negative", () => {
  const scores = computeHITS([
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "a" },
  ]);
  for (const [, { hub, authority }] of scores) {
    assert.ok(Number.isFinite(hub));
    assert.ok(Number.isFinite(authority));
    assert.ok(hub >= 0);
    assert.ok(authority >= 0);
  }
  // Symmetric cycle: every node has identical hub and authority scores.
  const vals = [...scores.values()];
  for (const v of vals) {
    assert.ok(Math.abs(v.hub - vals[0].hub) < 1e-6);
    assert.ok(Math.abs(v.authority - vals[0].authority) < 1e-6);
  }
});

test("edge weight scales contribution (repeated backlinks count more)", () => {
  const scores = computeHITS([
    { source: "hub1", target: "auth1", weight: 5 },
    { source: "hub2", target: "auth1", weight: 1 },
    { source: "hub1", target: "auth2", weight: 1 },
    { source: "hub2", target: "auth2", weight: 1 },
  ]);
  // hub1's heavily-weighted link to auth1 should make hub1 out-earn hub2 in hub score,
  // since auth1 ends up with more authority than auth2 would under unweighted counting.
  const hub1 = scores.get("hub1")!;
  const hub2 = scores.get("hub2")!;
  assert.ok(hub1.hub > hub2.hub);
});

test("converges within default iteration budget for a slightly larger graph", () => {
  const edges = [];
  for (let i = 0; i < 10; i++) {
    edges.push({ source: `hub${i}`, target: "auth1" });
    edges.push({ source: `hub${i}`, target: "auth2" });
  }
  const scores = computeHITS(edges);
  assert.ok(scores.get("auth1")!.authority > 0);
  assert.ok(scores.get("hub0")!.hub > 0);
});
