/**
 * Tests for the graph seed tier.
 *
 * FIXTURES ARE INVENTED. Per CLAUDE.md: this repo is public, so no note title,
 * concept name, domain slug or path below comes from a real vault.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  connectArgv,
  parseConnectOutput,
  mergeSeeds,
  CONNECT_K,
  CONNECT_QUERY_CHARS,
} from "./graph.ts";

test("connectArgv asks for JSON and flattens the query to one line", () => {
  const argv = connectArgv("alpha lattice\nfolding\t scheme  ");
  assert.deepEqual(argv, [
    "connect",
    "--query",
    "alpha lattice folding scheme",
    "--k",
    String(CONNECT_K),
    "--json",
  ]);
});

test("connectArgv caps the query it sends across the argv boundary", () => {
  const argv = connectArgv("x".repeat(CONNECT_QUERY_CHARS * 3));
  assert.equal(argv[2].length, CONNECT_QUERY_CHARS);
});

test("parseConnectOutput reads the candidate pool", () => {
  const out = parseConnectOutput(
    JSON.stringify({
      candidates: [
        { path: "concepts/alpha/Alpha Lattice.md", title: "Alpha Lattice", ppr: 0.09, lex: 25.9, score: 1.25 },
        { path: "concepts/gamma/Gamma Term.md", title: "Gamma Term", ppr: 0.03, lex: 3.8, score: 0.44 },
      ],
    }),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].label, "Alpha Lattice");
  assert.equal(out[1].ppr, 0.03);
});

test("parseConnectOutput keeps the graph-only candidate", () => {
  // The whole reason this tier exists: a candidate reached on graph proximity
  // with almost no lexical overlap must survive parsing intact.
  const out = parseConnectOutput(
    JSON.stringify({ candidates: [{ path: "concepts/gamma/Gamma Term.md", title: "Gamma Term", ppr: 0.036, lex: 0, score: 0.44 }] }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].lex, 0);
});

test("parseConnectOutput shrugs at anything unexpected", () => {
  // A seed tier that throws would trip the pass's circuit breaker — far too
  // loud a failure for "the graph had no opinion".
  for (const bad of ["", "not json", "null", "[]", "{}", '{"candidates":"nope"}']) {
    assert.deepEqual(parseConnectOutput(bad), [], `should be empty: ${bad}`);
  }
  // Entries missing a path or title are dropped, the rest survive.
  const mixed = parseConnectOutput(
    JSON.stringify({ candidates: [{ title: "No Path" }, { path: "a/B.md" }, { path: "a/C.md", title: "C" }] }),
  );
  assert.deepEqual(mixed.map((c) => c.path), ["a/C.md"]);
});

test("mergeSeeds puts the lexical tier first and dedupes", () => {
  const merged = mergeSeeds(
    [{ path: "a/Alpha.md", label: "Alpha" }],
    [
      { path: "a/Alpha.md", label: "Alpha" },
      { path: "g/Gamma.md", label: "Gamma" },
    ],
    () => true,
    [],
    4,
  );
  assert.deepEqual(merged, [
    { path: "a/Alpha.md", label: "Alpha", tier: "lexical" },
    { path: "g/Gamma.md", label: "Gamma", tier: "graph" },
  ]);
});

test("mergeSeeds is fail-closed on anything it cannot vouch for", () => {
  // `connect` ranks the whole vault with no scope filter, so a path with no
  // surfaceable record behind it must be dropped, not surfaced.
  const merged = mergeSeeds(
    [],
    [
      { path: "maps/Some Map.md", label: "Some Map" },
      { path: "d/Delta Ledger.md", label: "Delta Ledger" },
      { path: "g/Gamma.md", label: "Gamma" },
    ],
    (p) => p === "g/Gamma.md",
    [],
    4,
  );
  assert.deepEqual(merged.map((c) => c.path), ["g/Gamma.md"]);
});

test("mergeSeeds drops notes already seen this session and honours the limit", () => {
  const merged = mergeSeeds(
    [{ path: "a/Alpha.md", label: "Alpha" }],
    [
      { path: "g/Gamma.md", label: "Gamma" },
      { path: "b/Beta.md", label: "Beta" },
    ],
    () => true,
    ["a/Alpha.md"],
    1,
  );
  assert.deepEqual(merged.map((c) => c.path), ["g/Gamma.md"]);
});
