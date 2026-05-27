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
