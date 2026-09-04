#!/usr/bin/env tsx
/**
 * Ambient-connection eval runner.
 *
 * Drives real `claude -p` sessions and scores what the in-process hook module
 * wrote to `<vault>/.wiki/hook-log.jsonl`. See ./score.ts for why this cannot
 * be an offline eval like `eval:retrieval`.
 *
 * Gold set: --gold <path>, default $VAULT/.wiki/evals/connection-gold.jsonl.
 * NEVER committed — the cases name real notes in a real vault. Run --init once
 * to write a starter file there.
 *
 * TWO THINGS THAT MAKE THIS WORK, both verified live:
 *   - `turn.complete` DOES fire under `claude -p`. (`ui.render` does not; the
 *     docs claimed both did not, which is why this eval was thought impossible.)
 *   - Every `-p` run is a fresh session, so the pass's per-session state
 *     rebinds and the rate limit cannot starve a case. Cases do not contend.
 *
 * Runs SERIALLY on purpose: every session appends to one log, and the runner
 * attributes lines by byte offset. Concurrency would interleave them.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "fs";
import { join, dirname, resolve } from "path";
import { parseArgs } from "node:util";
import { spawnSync } from "child_process";
import { resolveVault } from "../../scripts/lib/vault.js";
import {
  observePass,
  scoreCase,
  summarize,
  formatSummary,
  type GoldCase,
  type CaseResult,
  type LogLine,
} from "./score.js";

const { values: args } = parseArgs({
  options: {
    vault: { type: "string" },
    gold: { type: "string" },
    /** Repo dir passed to `claude --plugin-dir`, for iterating on a branch. */
    "plugin-dir": { type: "string" },
    /** Run only the first N cases. */
    limit: { type: "string" },
    /** Run only the case with this id. */
    only: { type: "string" },
    /** Seconds to allow each session. */
    timeout: { type: "string" },
    json: { type: "boolean" },
    init: { type: "boolean" },
  },
});

const config = resolveVault(args.vault);
const goldPath = args.gold ?? join(config.wikiPath, "evals", "connection-gold.jsonl");
const logPath = join(config.wikiPath, "hook-log.jsonl");

const STARTER: GoldCase[] = [
  {
    id: "example-positive",
    prompt:
      "Explain in about 400 words how <a topic your vault genuinely covers> " +
      "works, and what the main design tradeoff is.",
    expect: "surface",
    notes: ["03 - Concepts/<The Note That Should Surface>.md"],
  },
  {
    id: "example-negative",
    prompt:
      "Explain in about 400 words how <a technical topic your vault has " +
      "nothing about> works.",
    expect: "silent",
  },
];

if (args.init) {
  if (existsSync(goldPath)) {
    console.error(`error: ${goldPath} already exists; edit it instead.`);
    process.exit(1);
  }
  mkdirSync(dirname(goldPath), { recursive: true });
  writeFileSync(goldPath, STARTER.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.log(`wrote starter gold set: ${goldPath}`);
  console.log("Edit it to name real notes, then run `commonplace eval:connection`.");
  process.exit(0);
}

if (!existsSync(goldPath)) {
  console.error(`error: gold set not found at ${goldPath}`);
  console.error("Run `commonplace eval:connection --init` to scaffold one.");
  process.exit(1);
}

let gold: GoldCase[] = readFileSync(goldPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as GoldCase);

if (args.only) gold = gold.filter((c) => c.id === args.only);
if (args.limit) gold = gold.slice(0, Math.max(1, Number(args.limit)));
if (gold.length === 0) {
  console.error("error: no cases selected");
  process.exit(1);
}

/** Byte length of the log right now; new lines are everything past it. */
function logSize(): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

/** Lines appended to the log since `from` bytes. */
function linesSince(from: number): LogLine[] {
  try {
    const buf = readFileSync(logPath);
    return buf
      .subarray(from)
      .toString("utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as LogLine;
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
}

const timeoutMs = Math.max(30, Number(args.timeout ?? 240)) * 1000;
const pluginDir = args["plugin-dir"] ? resolve(args["plugin-dir"]) : "";

const results: CaseResult[] = [];

for (const [i, c] of gold.entries()) {
  if (!args.json) {
    process.stderr.write(`[${i + 1}/${gold.length}] ${c.id} ... `);
  }
  const before = logSize();

  const argv = ["-p", c.prompt];
  if (pluginDir) argv.push("--plugin-dir", pluginDir);

  const started = Date.now();
  const proc = spawnSync("claude", argv, {
    timeout: timeoutMs,
    stdio: ["ignore", "ignore", "ignore"],
    // The pass resolves the vault from the session cwd; run each case there so
    // a multi-vault registry cannot answer for the wrong one.
    cwd: config.vaultPath,
  });

  const observed = observePass(linesSince(before));
  const result = scoreCase(c, observed);
  results.push(result);

  if (!args.json) {
    const why = proc.error ? ` (${proc.error.message})` : "";
    process.stderr.write(
      `${result.correct ? "ok" : "MISS"} ${observed.stage} ` +
        `${Math.round((Date.now() - started) / 1000)}s${why}\n`,
    );
  }
}

const summary = summarize(results);

if (args.json) {
  console.log(JSON.stringify({ gold: goldPath, summary, results }, null, 2));
} else {
  console.log("");
  console.log(formatSummary(summary, results));
}
