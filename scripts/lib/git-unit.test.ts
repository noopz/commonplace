import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { blobOfFile, commitUnit, inverseOnto, recordAppendOnly, recordTouch, repoOf } from "./git-unit.ts";

const who = { actor: "test-agent", session: "s1" };

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cp-unit-test-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  writeFileSync(join(root, "Alpha.md"), "alpha v1\n");
  writeFileSync(join(root, "Beta.md"), "beta v1\n");
  writeFileSync(join(root, ".gitignore"), ".wiki/\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  return root;
}

const sh = (root: string, ...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" }).toString();

/** One agent write: blob before, the write, blob after, recorded. */
function agentWrite(root: string, unit: string, rel: string, text: string | null) {
  const r = repoOf(root)!;
  const before = blobOfFile(r, rel, true);
  if (text === null) unlinkSync(join(root, rel));
  else writeFileSync(join(root, rel), text);
  const after = blobOfFile(r, rel, true);
  recordTouch(root, unit, who, rel, before, after, r);
}

test("a clean unit commits only its own paths and leaves the owner's edits uncommitted", () => {
  const root = repo();
  try {
    writeFileSync(join(root, "Beta.md"), "owner edit\n"); // owner, uncommitted
    agentWrite(root, "u1", "Alpha.md", "alpha v2\n");
    agentWrite(root, "u1", "Gamma.md", "new note\n");
    const r = commitUnit(root, "u1", { message: "ingest Gamma", trailers: { "Revision-Event": "e1" } });
    assert.equal(r.status, "committed");
    assert.deepEqual(sh(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), ["Alpha.md", "Gamma.md"]);
    assert.match(sh(root, "log", "-1", "--format=%B"), /Unit: u1\nActor: test-agent\nRevision-Event: e1/);
    assert.match(sh(root, "log", "-1", "--format=%an"), /commonplace \(test-agent\)/);
    // The owner's edit is still in the working tree, still uncommitted, and git status is sane.
    assert.equal(readFileSync(join(root, "Beta.md"), "utf-8"), "owner edit\n");
    assert.equal(sh(root, "status", "--porcelain").trim(), "M Beta.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the owner's staged changes stay staged and out of the agent's commit", () => {
  const root = repo();
  try {
    writeFileSync(join(root, "Beta.md"), "staged by owner\n");
    sh(root, "add", "Beta.md");
    agentWrite(root, "u1", "Alpha.md", "alpha v2\n");
    assert.equal(commitUnit(root, "u1", { message: "edit" }).status, "committed");
    assert.equal(sh(root, "diff", "--cached", "--name-only").trim(), "Beta.md");
    assert.equal(sh(root, "show", "HEAD:Beta.md"), "beta v1\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an owner edit to the same file after the agent wrote it blocks the commit", () => {
  const root = repo();
  try {
    agentWrite(root, "u1", "Alpha.md", "alpha v2\n");
    writeFileSync(join(root, "Alpha.md"), "alpha v2\nowner line\n");
    const r = commitUnit(root, "u1", { message: "edit" });
    assert.equal(r.status, "conflict");
    assert.equal(sh(root, "log", "--oneline").trim().split("\n").length, 1);
    assert.equal(readFileSync(join(root, "Alpha.md"), "utf-8"), "alpha v2\nowner line\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an edit between two agent writes taints the path; the whole unit is held back", () => {
  const root = repo();
  try {
    agentWrite(root, "u1", "Gamma.md", "one\n");
    agentWrite(root, "u1", "Alpha.md", "alpha v2\n");
    writeFileSync(join(root, "Alpha.md"), "alpha owner\n");
    agentWrite(root, "u1", "Alpha.md", "alpha owner\nagent again\n");
    const r = commitUnit(root, "u1", { message: "edit" });
    assert.equal(r.status, "conflict");
    if (r.status === "conflict") assert.equal(r.conflicts[0].path, "Alpha.md");
    assert.equal(sh(root, "log", "--oneline").trim().split("\n").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manual commit of another file in between is rebased onto, not overwritten", () => {
  const root = repo();
  try {
    agentWrite(root, "u1", "Alpha.md", "alpha v2\n");
    writeFileSync(join(root, "Beta.md"), "owner commit\n");
    sh(root, "commit", "-q", "-m", "owner", "--", "Beta.md");
    const r = commitUnit(root, "u1", { message: "edit" });
    assert.equal(r.status, "committed");
    assert.equal(sh(root, "show", "HEAD:Beta.md"), "owner commit\n");
    assert.equal(sh(root, "show", "HEAD:Alpha.md"), "alpha v2\n");
    assert.equal(sh(root, "status", "--porcelain").trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit landing between build and update-ref is detected and retried", () => {
  const root = repo();
  try {
    agentWrite(root, "u1", "Alpha.md", "alpha v2\n");
    let raced = false;
    const r = commitUnit(root, "u1", {
      message: "edit",
      beforeUpdateRef: () => {
        if (raced) return;
        raced = true;
        writeFileSync(join(root, "Beta.md"), "racing owner\n");
        sh(root, "commit", "-q", "-m", "race", "--", "Beta.md");
      },
    });
    assert.equal(r.status, "committed");
    assert.equal(sh(root, "show", "HEAD:Beta.md"), "racing owner\n");
    assert.equal(sh(root, "show", "HEAD^:Beta.md"), "racing owner\n");
    assert.equal(sh(root, "show", "HEAD:Alpha.md"), "alpha v2\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deletion commits as a removal", () => {
  const root = repo();
  try {
    agentWrite(root, "u1", "Beta.md", null);
    assert.equal(commitUnit(root, "u1", { message: "prune" }).status, "committed");
    assert.throws(() => sh(root, "show", "HEAD:Beta.md"));
    assert.equal(sh(root, "status", "--porcelain").trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("append-only ledgers commit while the committed copy is a prefix", () => {
  const root = repo();
  try {
    mkdirSync(join(root, ".revision"), { recursive: true });
    writeFileSync(join(root, ".revision/s1.jsonl"), '{"id":"a"}\n');
    recordAppendOnly(root, "u1", who, [".revision/s1.jsonl"]);
    assert.equal(commitUnit(root, "u1", { message: "ledger" }).status, "committed");
    appendFileSync(join(root, ".revision/s1.jsonl"), '{"id":"b"}\n');
    recordAppendOnly(root, "u2", who, [".revision/s1.jsonl"]);
    assert.equal(commitUnit(root, "u2", { message: "ledger 2" }).status, "committed");
    writeFileSync(join(root, ".revision/s1.jsonl"), '{"id":"rewritten"}\n');
    recordAppendOnly(root, "u3", who, [".revision/s1.jsonl"]);
    assert.equal(commitUnit(root, "u3", { message: "ledger 3" }).status, "conflict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("swept ledgers ride along with real work, never alone and never as a conflict", () => {
  const root = repo();
  try {
    mkdirSync(join(root, ".revision"), { recursive: true });
    writeFileSync(join(root, ".revision/s1.jsonl"), '{"id":"a"}\n');
    const sweep = [".revision/s1.jsonl", ".revision/s2.jsonl"];
    agentWrite(root, "u1", "Alpha.md", "alpha v2\n");
    assert.equal(commitUnit(root, "u1", { message: "work", sweep }).status, "committed");
    assert.deepEqual(sh(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), [".revision/s1.jsonl", "Alpha.md"]);
    appendFileSync(join(root, ".revision/s1.jsonl"), '{"id":"b"}\n');
    agentWrite(root, "u2", "Alpha.md", "alpha v2\n"); // nothing new to commit
    assert.equal(commitUnit(root, "u2", { message: "noop", sweep }).status, "empty");
    writeFileSync(join(root, ".revision/s1.jsonl"), '{"id":"rewritten"}\n');
    agentWrite(root, "u3", "Beta.md", "beta v2\n");
    assert.equal(commitUnit(root, "u3", { message: "more", sweep }).status, "committed");
    assert.deepEqual(sh(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["Beta.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a vault in a subfolder of the repository commits repository-relative paths", () => {
  const root = repo();
  try {
    mkdirSync(join(root, "vault"));
    const vault = join(root, "vault");
    agentWrite(vault, "u1", "Delta.md", "delta\n");
    assert.equal(commitUnit(vault, "u1", { message: "sub" }).status, "committed");
    assert.equal(sh(root, "show", "HEAD:vault/Delta.md"), "delta\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty, missing and detached units report instead of committing", () => {
  const root = repo();
  try {
    assert.equal(commitUnit(root, "nope", { message: "x" }).status, "missing");
    agentWrite(root, "u1", "Alpha.md", "alpha v2\n");
    agentWrite(root, "u1", "Alpha.md", "alpha v1\n"); // back to the committed text
    assert.equal(commitUnit(root, "u1", { message: "x" }).status, "empty");
    agentWrite(root, "u2", "Beta.md", "beta v2\n");
    sh(root, "checkout", "-q", "--detach");
    assert.equal(commitUnit(root, "u2", { message: "x" }).status, "detached");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inverseOnto undoes one change and keeps later edits", () => {
  const root = repo();
  try {
    const r = repoOf(root)!;
    const before = "a\nb\nc\nd\ne\n";
    const after = "a\nB-agent\nc\nd\ne\n";
    const current = "a\nB-agent\nc\nd\ne-owner\n";
    assert.equal(inverseOnto(r, current, after, before), "a\nb\nc\nd\ne-owner\n");
    assert.equal(inverseOnto(r, "a\nB-owner\nc\nd\ne\n", after, before), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a unit never lands on a branch other than the one the session pinned", () => {
  const root = repo();
  try {
    agentWrite(root, "u-pin", "Alpha.md", "alpha pinned\n");
    sh(root, "checkout", "-q", "-b", "side");
    const r = commitUnit(root, "u-pin", { message: "m", pin: "refs/heads/main" });
    assert.equal(r.status, "off-branch");
    assert.equal(sh(root, "log", "--oneline").trim().split("\n").length, 1, "nothing committed on either branch");
    sh(root, "checkout", "-q", "main");
    assert.equal(commitUnit(root, "u-pin", { message: "m", pin: "refs/heads/main" }).status, "committed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
