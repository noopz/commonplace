import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeRetrievalFixtureVault, removeRetrievalFixtureVault } from "./fixture-vault.ts";

const RUN = join(import.meta.dirname!, "run.ts");
const GOLD = join(import.meta.dirname!, "fixtures", "gold.jsonl");

function runEval(extraArgs: string[]): { stdout: string } {
  const { vaultRoot } = makeRetrievalFixtureVault();
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", RUN, "--vault", vaultRoot, "--gold", GOLD, "--json", ...extraArgs],
      { encoding: "utf-8" },
    );
    return { stdout };
  } finally {
    removeRetrievalFixtureVault(vaultRoot);
  }
}

test("baseline flat seeding: exact-phrase question hits, paraphrase question misses", () => {
  const { stdout } = runEval([]);
  const out = JSON.parse(stdout);
  const byId = Object.fromEntries(out.perQuestion.map((r: { id: string }) => [r.id, r]));

  // q1 shares "frontier ranking" with the target title — flat grep finds it.
  assert.equal(byId.q1.recall, 1, "q1 (lexical overlap) should have recall 1");

  // q3 is the Memora abstraction-gap case: zero shared strings with the
  // target record. Flat baseline MUST miss it. If this ever becomes 1
  // WITHOUT the abstraction layer, the fixture has been perturbed.
  assert.equal(byId.q3.recall, 0, "q3 (paraphrase, no lexical overlap) must miss at flat baseline");
  assert.deepEqual(byId.q3.missedExpected, ["02 - Research/Beta/Beta Consolidation Report.md"]);

  assert.equal(out.n, 8);
  assert.ok(out.overall > 0 && out.overall < 1, "baseline should be partial, not perfect or zero");
  assert.deepEqual(Object.keys(out.byType).sort(), ["cross-domain", "multi-hop", "single-hop"]);
  assert.equal(out.seedMode, "flat");
  assert.equal(typeof out.meanMrr, "number");

  // Contamination signature (I1): before the re-relativization fix, the
  // tmpdir prefix (e.g. "retrieval-eval-vault-") made "retrieval" match
  // every absolutized record path, so every question's candidate set
  // included all 16 fixture records. That must no longer happen.
  const fullRecordCount = 16;
  for (const r of out.perQuestion) {
    assert.notEqual(r.nCandidates, fullRecordCount, `${r.id} should not match every fixture record`);
  }
});

test("--history appends a JSONL record to the vault's .wiki", () => {
  const { vaultRoot } = makeRetrievalFixtureVault();
  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx", RUN, "--vault", vaultRoot, "--gold", GOLD, "--history"],
      { encoding: "utf-8" },
    );
    const historyPath = join(vaultRoot, ".wiki", "eval-history.jsonl");
    assert.ok(existsSync(historyPath), "history file missing");
    const lines = readFileSync(historyPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.seedMode, "flat");
    assert.equal(rec.n, 8);
    assert.equal(typeof rec.overall, "number");
  } finally {
    removeRetrievalFixtureVault(vaultRoot);
  }
});

test("--answers scores transcripts for citation overlap and groundedness", () => {
  const { vaultRoot } = makeRetrievalFixtureVault();
  const answersDir = mkdtempSync(join(tmpdir(), "eval-answers-"));
  try {
    writeFileSync(join(answersDir, "q1.json"), JSON.stringify({
      answer: 'The study reports a 42% gain and calls it "spectral drift".',
      cited: ["02 - Research/Alpha/Frontier Ranking Study.md"],
    }));
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", RUN, "--vault", vaultRoot, "--gold", GOLD, "--json", "--answers", answersDir],
      { encoding: "utf-8" },
    );
    const out = JSON.parse(stdout);
    assert.equal(out.answerScores.q1.citationRecall, 1);
    assert.equal(out.answerScores.q1.citationPrecision, 1);
    // Fixture note bodies contain neither the number nor the quote.
    // SPECIFIC_NUMBER_RE tries the percent alternative first, so "42%" is
    // extracted whole (not "42") — pinning actual lib behavior here.
    assert.deepEqual(out.answerScores.q1.ungroundedNumbers, ["42%"]);
    assert.deepEqual(out.answerScores.q1.ungroundedQuotes, ["spectral drift"]);
  } finally {
    rmSync(answersDir, { recursive: true, force: true });
    removeRetrievalFixtureVault(vaultRoot);
  }
});

test("unknown --seed-mode fails loudly", () => {
  const { vaultRoot } = makeRetrievalFixtureVault();
  try {
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", RUN, "--vault", vaultRoot, "--gold", GOLD, "--seed-mode", "vector"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ),
    );
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", RUN, "--vault", vaultRoot, "--gold", GOLD, "--seed-mode", "flat", "--no-abstraction"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ),
    );
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", RUN, "--vault", vaultRoot, "--gold", GOLD, "--seed-mode", "flat", "--no-authority"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ),
    );
  } finally {
    removeRetrievalFixtureVault(vaultRoot);
  }
});

test("tiered seeding closes the paraphrase gap via the abstraction tier (Memora ablation)", () => {
  const { vaultRoot } = makeRetrievalFixtureVault();
  try {
    const runWith = (extra: string[]) => {
      const stdout = execFileSync(
        process.execPath,
        ["--import", "tsx", RUN, "--vault", vaultRoot, "--gold", GOLD, "--json", ...extra],
        { encoding: "utf-8" },
      );
      const out = JSON.parse(stdout);
      return Object.fromEntries(out.perQuestion.map((r: { id: string }) => [r.id, r]));
    };

    const flat = runWith(["--seed-mode", "flat"]);
    const tiered = runWith(["--seed-mode", "tiered"]);
    const ablated = runWith(["--seed-mode", "tiered", "--no-abstraction"]);

    // The Memora result in miniature: the paraphrase question is unreachable
    // lexically (flat 0), reachable through the abstraction key (tiered 1),
    // and unreachable again with the abstraction tier ablated (0).
    assert.equal(flat.q3.recall, 0);
    assert.equal(tiered.q3.recall, 1);
    assert.equal(ablated.q3.recall, 0);

    // Lexical-overlap questions stay solved in tiered mode.
    assert.equal(tiered.q1.recall, 1);

    // Position-sensitive metric: q3's target seeds at Tier A and, with no
    // authority scores in the fixture, keeps stable index order — Beta
    // Consolidation Report precedes the other Tier-A hit, so it ranks #1.
    assert.equal(tiered.q3.mrr, 1);
    assert.equal(flat.q3.mrr, 0);
  } finally {
    removeRetrievalFixtureVault(vaultRoot);
  }
});
