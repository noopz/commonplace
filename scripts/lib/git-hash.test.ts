import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { currentHash } from "./git-hash.ts";

function makeGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "git-hash-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  return root;
}

function commitFile(root: string, relPath: string, contents: string): string {
  writeFileSync(join(root, relPath), contents);
  execFileSync("git", ["add", relPath], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", `write ${relPath}`], { cwd: root });
  return execFileSync("git", ["log", "-1", "--format=%H", "--", relPath], { cwd: root })
    .toString()
    .trim();
}

test("currentHash returns the commit hash that last touched the file", () => {
  const root = makeGitRepo();
  try {
    const hash = commitFile(root, "note.md", "v1");
    assert.equal(currentHash(root, "note.md"), hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("currentHash reflects a new hash after the file is re-committed", () => {
  const root = makeGitRepo();
  try {
    const firstHash = commitFile(root, "note.md", "v1");
    const secondHash = commitFile(root, "note.md", "v2");
    assert.notEqual(firstHash, secondHash);
    assert.equal(currentHash(root, "note.md"), secondHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("currentHash returns null for a path never committed", () => {
  const root = makeGitRepo();
  try {
    assert.equal(currentHash(root, "never-committed.md"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("currentHash returns null when vaultPath is not a git repo", () => {
  const root = mkdtempSync(join(tmpdir(), "no-git-"));
  try {
    writeFileSync(join(root, "note.md"), "v1");
    assert.equal(currentHash(root, "note.md"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
