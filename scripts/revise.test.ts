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
import { blobOfFile, recordTouch, repoOf } from "./lib/git-unit.ts";
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

const revise = (root: string, args: string[], stdin?: unknown, env: Record<string, string> = {}) => {
  let out: string;
  try {
    out = execFileSync(process.execPath, [join(ROOT, "bin", "commonplace"), "revise", ...args, "--json", "--offline", "--vault", root], {
      encoding: "utf-8",
      env: { ...ENV, ...env },
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
    // are append-only and ride with the next commit, or the session-end ledger commit.
    assert.deepEqual(git(root, "status", "--porcelain").trim().split("\n").filter((l) => l && !l.includes(".revision/")), []);
    assert.equal(revise(root, ["ledger-commit"]).status, "committed");
    assert.equal(git(root, "status", "--porcelain", "--", ".revision").trim(), "", "the session-end commit leaves no ledger line only on disk");
    assert.equal(git(root, "log", "-1", "--format=%s").trim(), "commonplace revision: ledger");
    assert.equal(revise(root, ["ledger-commit"]).status, "empty", "nothing grew: no commit");

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
    // One recheck, the revert's: the reverted accept no longer asks for one.
    assert.deepEqual(after.stale.map((m: { event: string }) => m.event), [r.revert]);
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
    // A commit since the deferral is what clears it: `next` offers the accept again at once.
    const again = revise(root, ["next"]);
    assert.equal(again.proposal, p.id, JSON.stringify(again));
    assert.equal(again.stage, "accept");
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

test("commit-waiting commits only the notes accepts wait on, and the accepts then land", () => {
  const root = vault();
  try {
    revise(root, ["ensure"]);
    const rel = "Research/Alpha/New Finding.md";
    writeFileSync(join(root, rel), readFileSync(join(root, rel), "utf-8") + "\nOwner's draft line.\n");
    const other = "Concepts/Batch Window.md";
    writeFileSync(join(root, other), readFileSync(join(root, other), "utf-8") + "\nUnrelated owner edit.\n");
    const p = revise(root, ["propose", "--old", "Old Finding", "--new", "New Finding", "--claim", CLAIM]);
    toAccept(root, p.id);
    assert.equal(revise(root, ["accept", "--proposal", p.id]).status, "deferred");
    assert.deepEqual(revise(root, ["waiting"]), { rels: [rel], proposals: 1 });
    assert.deepEqual(revise(root, ["status"]).waiting, { notes: 1, proposals: 1 });

    const c = revise(root, ["commit-waiting"]);
    assert.equal(c.status, "committed", JSON.stringify(c));
    assert.deepEqual(c.paths, [rel]);
    assert.match(git(root, "status", "--porcelain"), /Batch Window/, "an unrelated edit stays uncommitted");
    assert.deepEqual(revise(root, ["waiting"]), { rels: [], proposals: 0 });
    assert.equal(revise(root, ["accept", "--proposal", p.id]).status, "accepted");
    assert.equal(revise(root, ["commit-waiting"]).status, "empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one newer note can carry several accepted edges: the first accept does not stale the rest", () => {
  const root = vault();
  try {
    const CLAIM2 = "Kestrel retries never exceed three.";
    writeFileSync(join(root, "Research/Alpha/Older Survey.md"), `---\ntitle: Older Survey\n---\n# Older Survey\n\n## Findings\n\n${CLAIM2}\n`);
    git(root, "add", ".");
    git(root, "commit", "-qm", "another older note");
    execFileSync(process.execPath, [join(ROOT, "bin", "commonplace"), "index", "--vault", root], { stdio: "ignore" });
    revise(root, ["ensure"]);
    const p1 = revise(root, ["propose", "--old", "Old Finding", "--new", "New Finding", "--claim", CLAIM]);
    const p2 = revise(root, ["propose", "--old", "Older Survey", "--new", "New Finding", "--claim", CLAIM2]);
    assert.equal(p2.status, "proposed", JSON.stringify(p2));
    toAccept(root, p1.id);
    assert.equal(revise(root, ["accept", "--proposal", p1.id]).status, "accepted");
    assert.equal(revise(root, ["record", "--proposal", p2.id, "--stage", "review"], { ...REVIEW, quotesOld: [CLAIM2] }).status, "verify");
    assert.equal(revise(root, ["record", "--proposal", p2.id, "--stage", "verify"], {
      result: "confirmed", reason: "r", evidence: [{ note: "Research/Alpha/New Finding.md", artifact: "sha256:test", locator: "chars 0-100" }], model: "test",
    }).status, "because");
    assert.equal(revise(root, ["record", "--proposal", p2.id, "--stage", "because"], { text: REVIEW.because, checked: true, flipped: false }).status, "accept");
    const a2 = revise(root, ["accept", "--proposal", p2.id]);
    assert.equal(a2.status, "accepted", JSON.stringify(a2));
    const newer = readFileSync(join(root, "Research/Alpha/New Finding.md"), "utf-8");
    assert.ok(newer.includes("[[Old Finding]]") && newer.includes("[[Older Survey]]"), newer);
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

test("stale-derivation lint lists the concept citing a revised note until a receipt clears it", () => {
  const root = vault();
  try {
    revise(root, ["ensure"]);
    const p = revise(root, ["propose", "--old", "Old Finding", "--new", "New Finding", "--claim", CLAIM]);
    toAccept(root, p.id);
    const a = revise(root, ["accept", "--proposal", p.id]);
    const lint = () => {
      const out = execFileSync(process.execPath, [join(ROOT, "bin", "commonplace"), "lint", "--vault", root, "--check", "stale-derivation", "--json"], { encoding: "utf-8", env: ENV });
      const res = JSON.parse(out);
      return [...res.critical, ...res.improvement, ...res.suggestion].filter((i: { check: string }) => i.check === "stale-derivation");
    };
    const before = lint();
    assert.equal(before.length, 1);
    assert.equal(before[0].file, "Concepts/Batch Window.md");
    assert.equal(revise(root, ["checked", "--note", "Concepts/Batch Window.md", "--event", a.accept], undefined, { COMMONPLACE_UNIT: "u-recheck" }).ok, true);
    assert.equal(lint().length, 0);
    // The receipt belongs to the unit that recorded it: a unit that wrote no note still commits it.
    const c = execFileSync(process.execPath, [join(ROOT, "bin", "commonplace"), "commit", "--vault", root, "--unit", "u-recheck", "--message", "recheck", "--json"], { encoding: "utf-8", env: ENV });
    assert.equal(JSON.parse(c).status, "committed", c);
    assert.match(git(root, "show", "--format=", "HEAD", "--", ".revision"), /"kind":"checked"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const NEW = "Research/Alpha/New Finding.md";
const OLD = "Research/Alpha/Old Finding.md";

test("job queue: one job per unit at its note versions, generated and frontmatter-only writes skipped", () => {
  const root = vault();
  try {
    const q = revise(root, ["job-enqueue"], { written: [NEW], reads: [{ rel: OLD, rev: "sha256:readversion" }], origin: "main" });
    assert.equal(q.queued.length, 1, JSON.stringify(q));
    assert.ok(readFileSync(join(root, ".revision/t1.jsonl"), "utf-8").includes('"rev":"sha256:readversion"'), "the version each note was read at is kept");
    assert.equal(revise(root, ["job-enqueue"], { written: [NEW], reads: [OLD], origin: "main" }).duplicate, 1, "same note versions: no second job");
    assert.match(revise(root, ["job-enqueue"], { written: [NEW], origin: "commonplace:wiki-linter" }).skipped[0].why, /generated/);

    // A unit that only touched frontmatter makes no claim.
    const r = repoOf(root)!;
    const before = blobOfFile(r, NEW, true);
    writeFileSync(join(root, NEW), readFileSync(join(root, NEW), "utf-8").replace("title: New Finding", "title: New Finding\ntags: [x]"));
    recordTouch(root, "u-fm", { actor: "main", session: "t1" }, NEW, before, blobOfFile(r, NEW, true), r);
    assert.match(revise(root, ["job-enqueue"], { written: [NEW], origin: "main", unit: "u-fm" }).skipped[0].why, /frontmatter-only/);

    // A body edit is a new version: a new job.
    writeFileSync(join(root, NEW), readFileSync(join(root, NEW), "utf-8") + "\nA new paragraph.\n");
    assert.equal(revise(root, ["job-enqueue"], { written: [NEW], origin: "main" }).queued.length, 1);
    assert.ok(readFileSync(join(root, ".revision/t1.jsonl"), "utf-8").includes('"kind":"job-queued"'), "jobs are durable in the ledger");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job queue: one claimed at a time, failures retried up to the limit, then abandoned", () => {
  const root = vault();
  try {
    revise(root, ["job-enqueue"], { written: [NEW], origin: "main" });
    writeFileSync(join(root, OLD), readFileSync(join(root, OLD), "utf-8") + "\nMore.\n");
    revise(root, ["job-enqueue"], { written: [OLD], origin: "main" });
    const first = revise(root, ["job-next"]).job;
    assert.equal(first.attempt, 1);
    assert.equal(revise(root, ["job-next"]).busy, true, "concurrency bound: the second waits");
    revise(root, ["job-failed", "--job", first.job, "--reason", "no answer"]);
    // The failed job is queued again (oldest first); the second job is behind it.
    for (const attempt of [2, 3]) {
      const j = revise(root, ["job-next"]).job;
      assert.equal(j.job, first.job);
      assert.equal(j.attempt, attempt);
      revise(root, ["job-failed", "--job", j.job, "--reason", "no answer"]);
    }
    const second = revise(root, ["job-next"]).job;
    assert.notEqual(second.job, first.job, "the first was abandoned after three attempts");
    assert.equal(revise(root, ["job-next"]).busy, true);
    assert.equal(revise(root, ["job-done", "--job", second.job], { poolSize: 2, proposals: 0 }).ok, true);
    assert.equal(revise(root, ["job-next"]).none, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an accept off the pinned branch waits, and nothing is written into the note", () => {
  const root = vault();
  try {
    revise(root, ["ensure"]);
    const p = revise(root, ["propose", "--old", "Old Finding", "--new", "New Finding", "--claim", CLAIM]);
    toAccept(root, p.id);
    git(root, "checkout", "-q", "-b", "side");
    const a = revise(root, ["accept", "--proposal", p.id], undefined, { COMMONPLACE_PIN: "refs/heads/main" });
    assert.equal(a.status, "deferred");
    assert.match(a.reason, /moved off main/);
    assert.equal(readFileSync(join(root, NEW), "utf-8").includes("supersedes"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a job claimed by a session that has exited is retried at once, not held for its lease", () => {
  const root = vault();
  try {
    revise(root, ["job-enqueue"], { written: [NEW], origin: "main" });
    // An impossible pid on this host: the claiming session is gone.
    const first = revise(root, ["job-next"], undefined, { COMMONPLACE_CALLER_PID: String(2 ** 22 + 4321) }).job;
    const again = revise(root, ["job-next"]).job;
    assert.equal(again.job, first.job);
    assert.equal(again.attempt, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
