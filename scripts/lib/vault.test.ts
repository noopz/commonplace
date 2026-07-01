import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isCwdInCommonplaceRepo } from "./vault.ts";

function makeCommonplaceRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "commonplace-repo-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "commonplace" }));
  return root;
}

test("isCwdInCommonplaceRepo is true at the repo root", () => {
  const root = makeCommonplaceRepo();
  try {
    assert.equal(isCwdInCommonplaceRepo(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isCwdInCommonplaceRepo walks up from a subdirectory", () => {
  const root = makeCommonplaceRepo();
  try {
    const sub = join(root, "scripts", "lib");
    mkdirSync(sub, { recursive: true });
    assert.equal(isCwdInCommonplaceRepo(sub), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isCwdInCommonplaceRepo is false for an unrelated directory", () => {
  const root = mkdtempSync(join(tmpdir(), "unrelated-repo-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "some-other-project" }));
    assert.equal(isCwdInCommonplaceRepo(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isCwdInCommonplaceRepo is false with no package.json at all", () => {
  const root = mkdtempSync(join(tmpdir(), "no-pkg-"));
  try {
    assert.equal(isCwdInCommonplaceRepo(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
