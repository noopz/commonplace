import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegistry, EMPTY_REGISTRY } from "./registry.ts";

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
