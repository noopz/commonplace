#!/usr/bin/env tsx
/**
 * Retrieval eval runner — commonplace's analog of Memora's ablation table.
 *
 * Deterministic by default: runs the seed procedure over a gold set of
 * {question, expected_notes} and reports seed recall (did the right notes
 * make the candidate set?). Zero LLM tokens.
 *
 * Gold set: --gold <path>, default $VAULT/.wiki/evals/gold.jsonl (per-vault,
 * NEVER committed — real gold questions reference real vault content).
 * The committed fixture gold set (evals/retrieval/fixtures/gold.jsonl) is
 * for CI only, paired with the fixture vault.
 *
 * Optional: --answers <dir> scores answer transcripts (<id>.json files of
 * {"answer": "...", "cited": ["vault-relative.md", ...]}) for citation
 * recall/precision + regex groundedness. Producing those transcripts is an
 * agent task (wiki-query per gold question), not this script's job.
 *
 * Ablation flags land with their features: --seed-mode tiered (mixed-key
 * spec), --rank authority (authority spec). Unknown values fail loudly so
 * a typo can't silently measure the wrong thing.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join, relative, dirname } from "path";
import { parseArgs } from "node:util";
import { execFileSync } from "child_process";
import { resolveVault, loadIndexes } from "../../scripts/lib/vault.js";
import { extractKeyTerms, seedCandidates } from "../../scripts/lib/seed.js";
import {
  seedRecall,
  aggregate,
  scoreAnswer,
  reciprocalRankOfFirstExpected,
  type GoldQuestion,
  type QuestionResult,
} from "./score.js";

const { values: args } = parseArgs({
  options: {
    vault: { type: "string" },
    gold: { type: "string" },
    "seed-mode": { type: "string", default: "flat" },
    "no-abstraction": { type: "boolean", default: false },
    "no-authority": { type: "boolean", default: false },
    answers: { type: "string" },
    history: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

if (args["seed-mode"] !== "flat" && args["seed-mode"] !== "tiered") {
  console.error(`error: unknown --seed-mode "${args["seed-mode"]}" (valid: flat, tiered)`);
  process.exit(1);
}
if (args["no-abstraction"] && args["seed-mode"] !== "tiered") {
  console.error("error: --no-abstraction only applies to --seed-mode tiered");
  process.exit(1);
}
if (args["no-authority"] && args["seed-mode"] !== "tiered") {
  console.error("error: --no-authority only applies to --seed-mode tiered");
  process.exit(1);
}

const config = resolveVault(args.vault);
const goldPath = args.gold ?? join(config.wikiPath, "evals", "gold.jsonl");
if (!existsSync(goldPath)) {
  console.error(`error: gold set not found at ${goldPath}`);
  console.error("Create one per-vault at .wiki/evals/gold.jsonl, or pass --gold <path>.");
  process.exit(1);
}

const gold: GoldQuestion[] = readFileSync(goldPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

const indexes = loadIndexes(config);

const results: QuestionResult[] = [];
const perQuestion: Array<QuestionResult & { candidates: string[] }> = [];
for (const q of gold) {
  const terms = extractKeyTerms(q.question);
  const hits = seedCandidates(terms, indexes, {
    mode: args["seed-mode"] as "flat" | "tiered",
    vaultPath: config.vaultPath,
    ...(args["no-abstraction"] ? { skipAbstractionTier: true } : {}),
    ...(args["no-authority"] ? { rankByAuthority: false } : {}),
  });
  const candidateRel = hits.map((h) => relative(config.vaultPath, h.path));
  const recall = seedRecall(q.expected_notes, candidateRel);
  const mrr = reciprocalRankOfFirstExpected(q.expected_notes, candidateRel);
  const candidateSet = new Set(candidateRel);
  const matchedExpected = q.expected_notes.filter((e) => candidateSet.has(e));
  const missedExpected = q.expected_notes.filter((e) => !candidateSet.has(e));
  const r: QuestionResult = {
    id: q.id,
    type: q.type,
    recall,
    mrr,
    nCandidates: hits.length,
    matchedExpected,
    missedExpected,
  };
  results.push(r);
  perQuestion.push({ ...r, candidates: candidateRel });
}

const agg = aggregate(results);

// Optional answer-transcript scoring
let answerScores: Record<string, ReturnType<typeof scoreAnswer>> | undefined;
if (args.answers) {
  answerScores = {};
  for (const q of gold) {
    const f = join(args.answers, `${q.id}.json`);
    if (!existsSync(f)) continue;
    const t = JSON.parse(readFileSync(f, "utf-8")) as { answer: string; cited: string[] };
    const noteTexts = q.expected_notes
      .map((rel) => join(config.vaultPath, rel))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf-8"));
    answerScores[q.id] = scoreAnswer(t.answer, t.cited, q.expected_notes, noteTexts);
  }
}

function pluginCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: join(import.meta.dirname!, "..", ".."),
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

const record = {
  timestamp: new Date().toISOString(),
  commit: pluginCommit(),
  seedMode: args["seed-mode"],
  ...(args["no-abstraction"] ? { noAbstraction: true } : {}),
  ...(args["no-authority"] ? { noAuthority: true } : {}),
  gold: goldPath,
  ...agg,
};

if (args.history) {
  const historyPath = join(config.wikiPath, "eval-history.jsonl");
  mkdirSync(dirname(historyPath), { recursive: true });
  appendFileSync(historyPath, JSON.stringify(record) + "\n");
}

if (args.json) {
  console.log(JSON.stringify({ ...record, perQuestion, answerScores }, null, 2));
} else {
  console.log(`Retrieval eval — seed mode: ${args["seed-mode"]}${args["no-abstraction"] ? " (no-abstraction)" : ""}, ${agg.n} questions`);
  console.log(`  overall seed recall: ${agg.overall.toFixed(3)}`);
  for (const [t, v] of Object.entries(agg.byType)) {
    console.log(`  ${t}: ${v.toFixed(3)}`);
  }
  console.log(`  median candidate-set size: ${agg.medianCandidates}`);
  console.log(`  mean reciprocal rank of first expected hit: ${agg.meanMrr.toFixed(3)}`);
  const misses = perQuestion.filter((r) => r.missedExpected.length > 0);
  if (misses.length > 0) {
    console.log(`  missed expected notes:`);
    for (const m of misses) {
      console.log(`    ${m.id}: ${m.missedExpected.join(", ")}`);
    }
  }
  if (answerScores) {
    for (const [id, s] of Object.entries(answerScores)) {
      console.log(
        `  answer ${id}: citation recall ${s.citationRecall.toFixed(2)}, precision ${s.citationPrecision.toFixed(2)}, ` +
        `ungrounded numbers ${s.ungroundedNumbers.length}, ungrounded quotes ${s.ungroundedQuotes.length}`,
      );
    }
  }
  if (args.history) console.log(`  recorded to .wiki/eval-history.jsonl`);
}
