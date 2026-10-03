/**
 * Scope model — invented domains: alpha (public), gamma + delta (private,
 * linkGroup g1), epsilon (private, alone), nested alpha/sub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shardOfDomain, shardOfNote, isVisible, openFromStartCwd, resolveOpenRef,
  proposeFromPrompt, sealedRoots, listableDomains, type DomainMap,
} from "./scope.ts";

const D: DomainMap = {
  alpha: { path: "02 - Research/Alpha", scope: "public" },
  gamma: { path: "04 - Explorations/Gamma", scope: "private", linkGroup: "g1", aliases: ["worlds"] },
  delta: { path: "04 - Explorations/Delta", scope: "private", linkGroup: "g1" },
  epsilon: { path: "04 - Explorations/Epsilon", scope: "private" },
  "alpha-sub": { path: "02 - Research/Alpha/Sub", scope: "private" },
  xyz: { path: "04 - Explorations/Xyz", scope: "private" },
};
const V = "/vaults/acme";

test("shards: public → main, private → linkGroup ?? id, nested folder wins", () => {
  assert.equal(shardOfDomain(D, "alpha"), "main");
  assert.equal(shardOfDomain(D, "gamma"), "g1");
  assert.equal(shardOfDomain(D, "epsilon"), "epsilon");
  assert.equal(shardOfNote(D, "02 - Research/Alpha/Alpha Report.md"), "main");
  assert.equal(shardOfNote(D, "02 - Research/Alpha/Sub/Inner.md"), "alpha-sub");
  assert.equal(shardOfNote(D, "04 - Explorations/Delta/x.md"), "g1");
  assert.equal(shardOfNote(D, "02 - Research/Alpha/Odd.md", "private"), "loose");
  assert.equal(shardOfNote(D, "04 - Explorations/Gamma/x.md", "public"), "g1", "domain governs");
  assert.equal(shardOfNote(D, "03 - Concepts/Gamma Term.md"), "main", "concept lives in a public folder");
});

test("signal 1: session-start cwd opens that shard (and its group) only", () => {
  assert.deepEqual([...openFromStartCwd(D, V, `${V}/04 - Explorations/Gamma/drafts`)], ["g1"]);
  assert.equal(openFromStartCwd(D, V, V).size, 0);
  assert.equal(openFromStartCwd(D, V, `${V}/04 - Explorations/Gamma2`).size, 0);
  const open = openFromStartCwd(D, V, `${V}/04 - Explorations/Gamma`);
  assert.ok(isVisible("g1", open));
  assert.ok(!isVisible("epsilon", open), "another private domain stays sealed");
  assert.ok(!isVisible("loose", new Set(["loose"])), "loose is never openable");
});

test("signal 2: /vault open resolves private ids and aliases only", () => {
  assert.deepEqual(resolveOpenRef(D, "GAMMA"), { shard: "g1", domain: "gamma" });
  assert.deepEqual(resolveOpenRef(D, "worlds"), { shard: "g1", domain: "gamma" });
  assert.equal(resolveOpenRef(D, "alpha"), null, "public needs no opening — same answer as unknown");
  assert.equal(resolveOpenRef(D, "nope"), null);
});

test("prompts only propose, only from typed origins, only in the first 200 chars", () => {
  const none = new Set<string>();
  assert.deepEqual(proposeFromPrompt(D, "let's work on the gamma timeline", "composer", none), ["gamma"]);
  assert.deepEqual(proposeFromPrompt(D, "back to my worlds notes", "bridge", none), ["gamma"]);
  assert.deepEqual(proposeFromPrompt(D, "gamma rays", "plugin", none), [], "plugin origin never counts");
  assert.deepEqual(proposeFromPrompt(D, "gamma rays", "sdk", none), []);
  assert.deepEqual(proposeFromPrompt(D, `${"x ".repeat(150)} gamma`, "composer", none), [], "past the window");
  assert.deepEqual(proposeFromPrompt(D, "the xyz file", "composer", none), [], "ids under 4 chars never proposed");
  assert.deepEqual(proposeFromPrompt(D, "gamma", "composer", new Set(["g1"])), [], "already open");
  assert.deepEqual(proposeFromPrompt(D, "alpha sub notes", "composer", none), ["alpha-sub"], "- reads as space");
  assert.deepEqual(proposeFromPrompt(D, "gammaray", "composer", none), [], "whole word only");
});

test("sealed roots: closed private folders + .wiki/sealed always", () => {
  const closed = sealedRoots(D, V, new Set());
  assert.ok(closed.includes(`${V}/.wiki/sealed`));
  assert.ok(closed.includes(`${V}/04 - Explorations/Gamma`));
  assert.ok(!closed.includes(`${V}/02 - Research/Alpha`));
  const g1 = sealedRoots(D, V, new Set(["g1"]));
  assert.ok(!g1.includes(`${V}/04 - Explorations/Gamma`) && !g1.includes(`${V}/04 - Explorations/Delta`));
  assert.ok(g1.includes(`${V}/04 - Explorations/Epsilon`));
  assert.ok(g1.includes(`${V}/.wiki/sealed`), "artefacts stay sealed even when open");
});

test("listable domains never include a sealed one", () => {
  assert.deepEqual(listableDomains(D, new Set()), ["alpha"]);
  assert.deepEqual(listableDomains(D, new Set(["g1"])), ["alpha", "delta", "gamma"]);
});
