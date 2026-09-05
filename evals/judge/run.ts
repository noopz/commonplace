#!/usr/bin/env tsx
/**
 * Judge-only eval runner — component isolation for the connection pass.
 *
 * Feeds stored (answer, note) pairs to the SAME judge prompt the hook uses and
 * scores the verdicts. See ./score.ts for why this exists alongside
 * `eval:connection`.
 *
 * THE PROMPT IS IMPORTED, NOT COPIED. `JUDGE_SYSTEM` and `parseVerdict` come
 * from `hooks/lib/` directly — the hooks sandbox forbids importing OUT of the
 * module, but nothing stops a normal Node script importing IN. So the eval and
 * the hook cannot drift, which a copied prompt guarantees they eventually
 * would, silently, and in the direction that makes the eval look better.
 *
 * Gold set: --gold <path>, default $VAULT/.wiki/evals/judge-gold.jsonl.
 * NEVER committed — cases name real notes. Answers live beside it in
 * $VAULT/.wiki/evals/answers/, written by `eval:connection`.
 *
 * The judge runs on haiku in the hook (`$.model.complete({model:"haiku"})`),
 * so --model defaults to haiku here. Point it elsewhere to ablate the model
 * rather than the prompt.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { parseArgs } from "node:util";
import { spawnSync } from "child_process";
import { resolveVault } from "../../scripts/lib/vault.js";
import { JUDGE_SYSTEM, ANSWER_EXCERPT, NOTE_EXCERPT } from "../../hooks/lib/pipeline.js";
import { stripFrontmatter, parseVerdict } from "../../hooks/lib/seed.js";
import {
  scoreJudgeCase,
  summarizeJudge,
  formatJudgeSummary,
  type JudgeCase,
  type JudgeResult,
  type JudgeTrial,
} from "./score.js";

const { values: args } = parseArgs({
  options: {
    vault: { type: "string" },
    gold: { type: "string" },
    model: { type: "string" },
    /** Trials per case, for self-agreement. Odd numbers avoid ties. */
    repeat: { type: "string" },
    only: { type: "string" },
    json: { type: "boolean" },
    init: { type: "boolean" },
  },
});

const config = resolveVault(args.vault);
const goldPath = args.gold ?? join(config.wikiPath, "evals", "judge-gold.jsonl");
const answersDir = join(config.wikiPath, "evals", "answers");
const model = args.model ?? "haiku";
const repeat = Math.max(1, Number(args.repeat ?? 1));

if (args.init) {
  // Scaffold from whatever `eval:connection` has already produced, so the
  // starter file names real answers that exist rather than placeholders.
  const answers = existsSync(answersDir)
    ? readdirSync(answersDir).filter((f) => f.endsWith(".txt"))
    : [];
  if (answers.length === 0) {
    console.error(`error: no answers in ${answersDir}`);
    console.error("Run `commonplace eval:connection` first — it writes them.");
    process.exit(1);
  }
  mkdirSync(dirname(goldPath), { recursive: true });
  const stub = answers.map((f) =>
    JSON.stringify({
      id: f.replace(/\.txt$/, ""),
      answerFile: f,
      note: "<vault-relative path of the note to show the judge>",
      expect: "surface",
      why: "<what this case is testing>",
    }),
  );
  writeFileSync(goldPath, stub.join("\n") + "\n");
  console.log(`wrote ${stub.length} stub case(s): ${goldPath}`);
  console.log("Fill in `note` and `expect` for each, then run `commonplace eval:judge`.");
  process.exit(0);
}

if (!existsSync(goldPath)) {
  console.error(`error: gold set not found at ${goldPath}`);
  console.error("Run `commonplace eval:judge --init` to scaffold one from stored answers.");
  process.exit(1);
}

let gold: JudgeCase[] = readFileSync(goldPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as JudgeCase);
if (args.only) gold = gold.filter((c) => c.id === args.only);
if (gold.length === 0) {
  console.error("error: no cases selected");
  process.exit(1);
}

/** Exactly the prompt hooks/lib/pipeline.ts builds for its judge call. */
function judgePrompt(answer: string, label: string, noteText: string): string {
  return (
    `JUST DISCUSSED:\n${answer.slice(0, ANSWER_EXCERPT)}\n\n` +
    `VAULT NOTE "${label}":\n${noteText}`
  );
}

const results: JudgeResult[] = [];

for (const [i, c] of gold.entries()) {
  const answer = c.answer
    ? c.answer
    : c.answerFile
      ? readFileSync(join(answersDir, c.answerFile), "utf-8")
      : "";
  if (!answer.trim()) {
    console.error(`error: case ${c.id} has no answer text`);
    process.exit(1);
  }

  const notePath = join(config.vaultPath, c.note);
  if (!existsSync(notePath)) {
    console.error(`error: case ${c.id} names a note that does not exist: ${c.note}`);
    process.exit(1);
  }
  const label = c.note.replace(/^.*\//, "").replace(/\.md$/, "");
  const noteText = stripFrontmatter(readFileSync(notePath, "utf-8")).slice(0, NOTE_EXCERPT);

  const trials: JudgeTrial[] = [];
  for (let t = 0; t < repeat; t++) {
    if (!args.json) {
      process.stderr.write(`[${i + 1}/${gold.length}] ${c.id} trial ${t + 1}/${repeat} ... `);
    }
    const started = Date.now();
    const proc = spawnSync(
      "claude",
      ["-p", judgePrompt(answer, label, noteText), "--model", model, "--system-prompt", JUDGE_SYSTEM],
      { timeout: 120_000, encoding: "utf-8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    const verdict = parseVerdict(String(proc.stdout ?? "")) ?? "";
    trials.push({ verdict, ms: Date.now() - started });
    if (!args.json) process.stderr.write(`${verdict ? "surface" : "skip"}\n`);
  }

  results.push(scoreJudgeCase(c, trials));
}

const summary = summarizeJudge(results);
if (args.json) {
  console.log(JSON.stringify({ gold: goldPath, model, repeat, summary, results }, null, 2));
} else {
  console.log("");
  console.log(formatJudgeSummary(summary, results));
}
