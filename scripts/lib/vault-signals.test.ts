import { test } from "node:test";
import assert from "node:assert/strict";
import { hasVaultIntent } from "./vault-signals.ts";

test("hasVaultIntent still matches regex signals with no paths", () => {
  assert.equal(hasVaultIntent("please run wiki-query for me"), true);
  assert.equal(hasVaultIntent("just refactor this function"), false);
});

test("hasVaultIntent matches when text contains any of several vault paths", () => {
  const paths = ["/Users/z/vaults/main", "/Users/z/vaults/alice"];
  assert.equal(hasVaultIntent("open /Users/z/vaults/alice/note.md", paths), true);
  assert.equal(hasVaultIntent("nothing vault-shaped here", paths), false);
});

test("hasVaultIntent accepts a single path string (back-compat)", () => {
  assert.equal(hasVaultIntent("see /v/main/x.md", "/v/main"), true);
});
