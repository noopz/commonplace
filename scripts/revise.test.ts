/**
 * `commonplace revise` end to end over an invented git vault: propose →
 * review → verify → because → accept (a commit carrying the edge and the
 * ledger) → revert (a compensating commit). The model calls the module would
 * make are replaced by recorded verdicts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dirname!, "..");
const ENV = { ...process.env, COMMONPLACE_ACTOR: "test-runner", COMMONPLACE_SESSION: "t1", COMMONPLACE_OPEN: "" };

const CLAIM = "Kestrel batches settle within two hours.";

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "revise-vault-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  mkdirSync(join(root, ".wiki"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".wiki/\n");
  writeFileSync(join(root, ".wiki", "config.json"), JSON.stringify({ structure: { sources: "Research", concepts: "Concepts", mocs: "Maps" } }));
  writeFileSync(join(root, ".wiki", "domains.json"), JSON.stringify({ domains: { alpha: { path: "Research/Alpha", scope: "public" } } }));
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("Research/Alpha/Old Finding.md", `---\ntitle: Old Finding\n---\n# Old Finding\n\n## Findings\n\n${CLAIM} Retries are rare.\n`);
  put("Research/Alpha/New Finding.md", "---\ntitle: New Finding\n---\n# New Finding\n\n## Findings\n\nKestrel batches now take up to nine hours under load; the old two-hour figure came from an idle cluster.\n");
  put("Concepts/Batch Window.md", "# Batch Window\n\nHow long a batch takes to settle, per [[Old Finding]].\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  execFileSync(process.execPath, [join(ROOT, "bin", "commonplace"), "index", "--vault", root], { stdio: "ignore" });
  return root;
}

const revise = (root: string, args: string[], stdin?: unknown) => {
  let out: string;
  try {
    out = execFileSync(process.execPath, [join(ROOT, "bin", "commonplace"), "revise", ...args, "--json", "--offline", "--vault", root], {
      encoding: "utf-8",
      env: ENV,
      input: stdin === undefined ? "" : JSON.stringify(stdin),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? ""); // a refusal exits 1 and still prints its JSON
  }
  return JSON.parse(out.trim().split("\n").pop()!);
};
const git = (root: string, ...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf-8" });

const REVIEW = {
  verdict: "supersedes",
  kindOf: "correction",
  because: "measured under load, the settle time is up to nine hours",
  quotesOld: [CLAIM],
  quotesNew: ["up to nine hours under load"],
  model: "test",
};

/** Walk a proposal to the accept stage with recorded verdicts. */
function toAccept(root: string, id: string) {
  assert.equal(revise(root, ["next"]).stage, "review");
  assert.equal(revise(root, ["record", "--proposal", id, "--stage", "review"], REVIEW).status, "verify");
  assert.equal(revise(root, ["record", "--proposal", id, "--stage", "verify"], {
    result: "confirmed",
    reason: "the newer source measures nine hours",
    evidence: [{ note: "Research/Alpha/New Finding.md", artifact: "sha256:test", locator: "chars 0-100" }],
    model: "test",
  }).status, "because");
  assert.equal(revise(root, ["record", "--proposal", id, "--stage", "because"], { text: REVIEW.because, checked: true, flipped: false }).status, "accept");
}

test("accept writes the edge into the newer note and commits it with the ledger; revert takes it back out", () => {
  const root = vault();
  try {
    const en = revise(root, ["ensure"]);
    assert.deepEqual(en.enabled, ["main"]);

    const p = revise(root, ["propose", "--old", "Old Finding", "--new", "New Finding", "--claim", CLAIM]);
    assert.equal(p.status, "proposed", JSON.stringify(p));
    assert.equal(revise(root, ["propose", "--old", "Old Finding", "--new", "New Finding", "--claim", CLAIM]).status, "duplicate");
    toAccept(root, p.id);

    const a = revise(root, ["accept", "--proposal", p.id]);
    assert.equal(a.status, "accepted", JSON.stringify(a));
    assert.equal(a.stale, 1, "the concept citing the old note is marked to recheck");

    const newer = readFileSync(join(root, "Research/Alpha/New Finding.md"), "utf-8");
    assert.match(newer, /supersedes:/);
    assert.ok(newer.includes(CLAIM), newer);
    assert.equal(readFileSync(join(root, "Research/Alpha/Old Finding.md"), "utf-8").includes("supersedes"), false, "the older note is never edited");

    // One commit: the newer note and the ledger, nothing else, with the event trailer.
    const files = git(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort();
    assert.ok(files.includes("Research/Alpha/New Finding.md"), files.join(","));
    assert.ok(files.some((f) => f.startsWith(".revision/")), files.join(","));
    assert.match(git(root, "log", "-1", "--format=%B"), new RegExp(`Revision-Event: ${a.accept}`));
    // Only the ledger's publish events (committed, stale) follow the commit; they
    // are append-only and ride with the next commit that touches the ledger.
    assert.deepEqual(git(root, "status", "--porcelain").trim().split("\n").filter((l) => l && !l.includes(".revision/")), []);

    const proj = JSON.parse(readFileSync(join(root, ".wiki/revision/projection.json"), "utf-8"));
    assert.equal(proj.accepted.length, 1);
    assert.equal(proj.stale.length, 1);

    const log = revise(root, ["log", "--note", "Old Finding"]);
    assert.equal(log[0].status, "accepted");
    assert.equal(log[0].relation, "supersedes");

    const r = revise(root, ["revert", "--event", "last", "--reason", "test"]);
    assert.equal(r.status, "reverted", JSON.stringify(r));
    assert.ok(r.commit, "the revert is its own commit");
    assert.equal(readFileSync(join(root, "Research/Alpha/New Finding.md"), "utf-8").includes("supersedes"), false);
    assert.match(git(root, "log", "-1", "--format=%B"), new RegExp(`Reverts-Event: ${a.accept}`));
    const after = JSON.parse(readFileSync(join(root, ".wiki/revision/projection.json"), "utf-8"));
    assert.equal(after.accepted.length, 0);
    assert.equal(revise(root, ["log"])[0].status, "reverted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an accept waits while the newer note has uncommitted changes, and pause stops it", () => {
  const root = vault();
  try {
    revise(root, ["ensure"]);
    const rel = "Research/Alpha/New Finding.md";
    writeFileSync(join(root, rel), readFileSync(join(root, rel), "utf-8") + "\nOwner's draft line.\n");
    const p = revise(root, ["propose", "--old", "Old Finding", "--new", "New Finding", "--claim", CLAIM]);
    toAccept(root, p.id);
    const a = revise(root, ["accept", "--proposal", p.id]);
    assert.equal(a.status, "deferred");
    assert.match(a.reason, /uncommitted/);
    assert.ok(readFileSync(join(root, rel), "utf-8").includes("Owner's draft line."), "the owner's edit is untouched");
    assert.equal(readFileSync(join(root, rel), "utf-8").includes("supersedes"), false);
    // A deferred accept is skipped by `next` for a while rather than retried in a loop.
    assert.equal(revise(root, ["next"]).none, true);

    git(root, "commit", "-qam", "owner commits");
    revise(root, ["pause"]);
    assert.equal(revise(root, ["accept", "--proposal", p.id]).status, "deferred");
    revise(root, ["resume"]);
    // Once the owner's line is committed the note is exactly what was reviewed, and the accept goes through.
    const done = revise(root, ["accept", "--proposal", p.id]);
    assert.equal(done.status, "accepted", JSON.stringify(done));
    assert.ok(readFileSync(join(root, rel), "utf-8").includes("Owner's draft line."));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a note edited after review goes pending instead of being accepted on stale evidence", () => {
  const root = vault();
  try {
    revise(root, ["ensure"]);
    const p = revise(root, ["propose", "--old", "Old Finding", "--new", "New Finding", "--claim", CLAIM]);
    toAccept(root, p.id);
    const rel = "Research/Alpha/Old Finding.md";
    writeFileSync(join(root, rel), readFileSync(join(root, rel), "utf-8") + "\nA later caveat.\n");
    git(root, "commit", "-qam", "owner edits the old note");
    const a = revise(root, ["accept", "--proposal", p.id]);
    assert.equal(a.status, "pending");
    assert.match(a.reason, /older note changed/);
    assert.equal(revise(root, ["log"])[0].status, "pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a claim not quoted exactly is refused, and a manual-mode vault never enables", () => {
  const root = vault();
  try {
    const bad = revise(root, ["propose", "--old", "Old Finding", "--new", "New Finding", "--claim", "Kestrel batches are fast."]);
    assert.equal(bad.status, "refused");
    writeFileSync(join(root, ".wiki", "config.json"), JSON.stringify({ revision: "manual", structure: { sources: "Research", concepts: "Concepts", mocs: "Maps" } }));
    assert.deepEqual(revise(root, ["ensure"]).enabled, []);
    assert.equal(existsSync(join(root, ".wiki/revision/projection.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
