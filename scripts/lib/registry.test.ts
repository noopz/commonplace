import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegistry, EMPTY_REGISTRY } from "./registry.ts";
import { findById, getDefaultEntry } from "./registry.ts";
import { matchByPhrase } from "./registry.ts";
import { addVault, migrateFromVaultPath } from "./registry.ts";

test("parseRegistry reads a well-formed registry", () => {
  const reg = parseRegistry(JSON.stringify({
    default: "main",
    vaults: [{ id: "main", path: "/v/main", label: "Main", aliases: ["m"] }],
  }));
  assert.equal(reg.default, "main");
  assert.equal(reg.vaults.length, 1);
  assert.equal(reg.vaults[0].path, "/v/main");
  assert.deepEqual(reg.vaults[0].aliases, ["m"]);
});

test("parseRegistry tolerates missing aliases and bad shape", () => {
  const reg = parseRegistry(JSON.stringify({ vaults: [{ id: "x", path: "/v/x", label: "X" }] }));
  assert.equal(reg.default, null);
  assert.deepEqual(reg.vaults[0].aliases, []);
});

test("parseRegistry returns empty registry on garbage", () => {
  assert.deepEqual(parseRegistry("not json"), EMPTY_REGISTRY);
  assert.deepEqual(parseRegistry("{}"), EMPTY_REGISTRY);
});

const sample = parseRegistry(JSON.stringify({
  default: "main",
  vaults: [
    { id: "main", path: "/v/main", label: "Main", aliases: [] },
    { id: "alice", path: "/v/alice", label: "Alice", aliases: ["a"] },
  ],
}));

test("findById returns the matching entry or undefined", () => {
  assert.equal(findById(sample, "alice")?.path, "/v/alice");
  assert.equal(findById(sample, "nope"), undefined);
});

test("getDefaultEntry resolves the default id", () => {
  assert.equal(getDefaultEntry(sample)?.id, "main");
  assert.equal(getDefaultEntry(EMPTY_REGISTRY), undefined);
});

test("matchByPhrase matches id, label, or alias case-insensitively", () => {
  assert.deepEqual(matchByPhrase(sample, "search in alice").map((v) => v.id), ["alice"]);
  assert.deepEqual(matchByPhrase(sample, "look in MAIN").map((v) => v.id), ["main"]);
  // alias "a" must match as a whole word, not inside "search"
  assert.deepEqual(matchByPhrase(sample, "the a vault").map((v) => v.id), ["alice"]);
});

test("matchByPhrase returns multiple entries when ambiguous", () => {
  const reg = parseRegistry(JSON.stringify({
    default: null,
    vaults: [
      { id: "alice", path: "/v/alice", label: "Alice", aliases: [] },
      { id: "alice-work", path: "/v/alice-work", label: "Alice Work", aliases: [] },
    ],
  }));
  assert.equal(matchByPhrase(reg, "in alice").length, 2);
});

test("matchByPhrase returns [] when nothing matches", () => {
  assert.deepEqual(matchByPhrase(sample, "in zenith"), []);
});

test("addVault appends and sets default when registry is empty", () => {
  const reg = addVault(EMPTY_REGISTRY, { id: "main", path: "/v/main", label: "Main", aliases: [] });
  assert.equal(reg.default, "main");
  assert.equal(reg.vaults.length, 1);
});

test("addVault replaces an entry with the same id or path, keeps default", () => {
  const base = addVault(EMPTY_REGISTRY, { id: "main", path: "/v/main", label: "Main", aliases: [] });
  const reg = addVault(base, { id: "main", path: "/v/main", label: "Renamed", aliases: ["m"] });
  assert.equal(reg.vaults.length, 1);
  assert.equal(reg.vaults[0].label, "Renamed");
  assert.equal(reg.default, "main");
});

test("migrateFromVaultPath builds a single-entry default registry", () => {
  const reg = migrateFromVaultPath("/Users/z/vaults/My Notes");
  assert.equal(reg.vaults.length, 1);
  assert.equal(reg.vaults[0].path, "/Users/z/vaults/My Notes");
  assert.equal(reg.vaults[0].id, "my-notes");
  assert.equal(reg.default, "my-notes");
});

// ---------------------------------------------------------------------------
// Private vaults and project pins
// ---------------------------------------------------------------------------

import { findByRef, setDefault, parsePins, pinFor } from "./registry.ts";

test("a private vault is parsed, and never honoured as default", () => {
  const reg = parseRegistry(JSON.stringify({
    default: "gamma",
    vaults: [
      { id: "alpha", path: "/v/alpha" },
      { id: "gamma", path: "/v/gamma", isPrivate: true },
    ],
  }));
  assert.equal(reg.vaults[1].isPrivate, true);
  assert.equal(reg.default, null);
});

test("addVault never makes a private vault the default by being first", () => {
  const reg = addVault(EMPTY_REGISTRY, { id: "gamma", path: "/v/gamma", label: "G", aliases: [], isPrivate: true });
  assert.equal(reg.default, null);
  const reg2 = addVault(reg, { id: "alpha", path: "/v/alpha", label: "A", aliases: [] });
  assert.equal(reg2.default, "alpha");
});

test("setDefault refuses a private vault with a pin hint", () => {
  const reg = parseRegistry(JSON.stringify({
    default: "alpha",
    vaults: [{ id: "alpha", path: "/v/alpha" }, { id: "gamma", path: "/v/gamma", isPrivate: true }],
  }));
  const out = setDefault(reg, "gamma");
  assert.equal(typeof out, "string");
  assert.match(out as string, /vault use gamma/);
  assert.equal((setDefault(reg, "alpha") as { default: string }).default, "alpha");
});

test("findByRef matches id, alias, label and path", () => {
  const reg = parseRegistry(JSON.stringify({
    vaults: [{ id: "alpha", path: "/v/alpha", label: "Alpha Notes", aliases: ["work"] }],
  }));
  for (const ref of ["alpha", "ALPHA", "work", "alpha notes", "/v/alpha", "/v/alpha/"]) {
    assert.equal(findByRef(reg, ref)?.id, "alpha", ref);
  }
  assert.equal(findByRef(reg, "beta"), undefined);
});

test("pinFor picks the longest pinned root containing cwd", () => {
  const pins = parsePins(JSON.stringify({ "/r/mono": "alpha", "/r/mono/pkg": "beta", "/x": 7 }));
  assert.equal(pinFor(pins, "/r/mono/src"), "alpha");
  assert.equal(pinFor(pins, "/r/mono/pkg/lib"), "beta");
  assert.equal(pinFor(pins, "/r/monorepo"), undefined, "prefix sibling is not inside");
  assert.equal(pinFor(pins, "/x"), undefined, "non-string pin dropped");
  assert.deepEqual(parsePins("not json"), {});
});
