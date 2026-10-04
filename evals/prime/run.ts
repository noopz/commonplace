#!/usr/bin/env tsx
/**
 * commonplace eval:prime — the gate prime must clear before `primeContext`
 * defaults on (plan §8.6, §11 Phase 6).
 *
 * Drives one fresh `claude -p` session per case with prime enabled through
 * `--settings` and scores the `prime:*` stages the module wrote to
 * `<vault>/.wiki/hook-log.jsonl`. Under `-p` the prompt's origin is `sdk`,
 * which the module accepts in place of `composer` for exactly this reason —
 * the report says so.
 *
 * The gold set lives at `$VAULT/.wiki/evals/prime-gold.jsonl` and is NEVER
 * committed: its cases name real notes. `--init` scaffolds one. Answers and
 * reports go under `$VAULT/.wiki/evals/prime/`, never into the repo.
 *
 * Usage: commonplace eval:prime [--gold <path>] [--repeat N] [--plugin-dir <repo>] [--limit N] [--only <id>] [--json] [--init]
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { spawnSync } from "child_process";
import { resolveVault } from "../../scripts/lib/vault.js";
import { logLinesSince } from "../hook-log.js";
import { commonplaceIds } from "../plugin-ids.js";
import { observePrime, scorePrimeCase, summarizePrime, formatPrimeSummary, type PrimeGold, type PrimeCaseResult, type LogLine } from "./score.js";

const { values: args } = parseArgs({
  options: {
    vault: { type: "string" },
    gold: { type: "string" },
    "plugin-dir": { type: "string" },
    repeat: { type: "string", default: "1" },
    limit: { type: "string" },
    only: { type: "string" },
    timeout: { type: "string" },
    json: { type: "boolean" },
    init: { type: "boolean" },
  },
});

const config = resolveVault(args.vault);
const goldPath = args.gold ?? join(config.wikiPath, "evals", "prime-gold.jsonl");
const logPath = join(config.wikiPath, "hook-log.jsonl");
const outDir = join(config.wikiPath, "evals", "prime");

const STARTER: PrimeGold[] = [
  {
    id: "example-prime",
    prompt: "Help me plan <a task your vault has a specific note about>, starting with the main decision.",
    expect: "prime",
    expected_notes: ["<vault-relative path of the note that should be primed>.md"],
  },
  { id: "example-none-adjacent", prompt: "<a task that shares vocabulary with your vault but no note is about it>", expect: "none" },
  { id: "example-none-short", prompt: "fix the typo", expect: "none" },
];

if (args.init) {
  if (existsSync(goldPath)) {
    console.error(`error: ${goldPath} already exists; edit it instead.`);
    process.exit(1);
  }
  mkdirSync(dirname(goldPath), { recursive: true });
  writeFileSync(goldPath, STARTER.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.log(`wrote starter gold set: ${goldPath}`);
  console.log("Add ≥40 `none` cases (vault-adjacent vocabulary, short prompts) before trusting a verdict.");
  process.exit(0);
}

if (!existsSync(goldPath)) {
  console.error(`error: gold set not found at ${goldPath}`);
  console.error("Run `commonplace eval:prime --init` to scaffold one.");
  process.exit(1);
}

let gold = readFileSync(goldPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as PrimeGold);
if (args.only) gold = gold.filter((c) => c.id === args.only);
if (args.limit) gold = gold.slice(0, Math.max(1, Number(args.limit)));
if (gold.length === 0) {
  console.error("error: no cases selected");
  process.exit(1);
}

const linesSince = (sinceIso: string): LogLine[] => logLinesSince(logPath, sinceIso);

// Prime is off by default; the eval turns it on for its own sessions only.
const override = { options: { primeContext: true, ambientConnections: false } };
const pluginDirArg = args["plugin-dir"];
// With --plugin-dir the working tree loads as `commonplace@inline`; the
// installed copy is switched off so its hooks do not fire beside it.
const settings = JSON.stringify({
  pluginConfigs: Object.fromEntries(commonplaceIds().map((id) => [id, override])),
  ...(pluginDirArg
    ? { enabledPlugins: Object.fromEntries(commonplaceIds().filter((id) => id.includes("@") && id !== "commonplace@inline").map((id) => [id, false])) }
    : {}),
});
const timeoutMs = Math.max(30, Number(args.timeout ?? 180)) * 1000;
const pluginDir = args["plugin-dir"] ? resolve(args["plugin-dir"]) : "";
const repeat = Math.max(1, Number(args.repeat) || 1);

const results: PrimeCaseResult[] = [];
let sawSync = false;
// Interleaved repeats: run 1 of every case, then run 2, so drift over time
// spreads across cases instead of landing on the last ones.
for (let r = 0; r < repeat; r++) {
  for (const [i, c] of gold.entries()) {
    if (!args.json) process.stderr.write(`[run ${r + 1}/${repeat} · ${i + 1}/${gold.length}] ${c.id} ... `);
    const before = new Date().toISOString();
    // The session runs inside the vault: reads stay (turns keep a realistic
    // length for the late-drop race), anything that can change files does not.
    const argv = ["-p", c.prompt, "--settings", settings, "--disallowedTools", "Write", "Edit", "NotebookEdit", "Bash"];
    if (pluginDir) argv.push("--plugin-dir", pluginDir);
    const proc = spawnSync("claude", argv, {
      timeout: timeoutMs,
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      cwd: config.vaultPath,
    });
    const answer = String(proc.stdout ?? "").trim();
    if (answer) {
      mkdirSync(join(outDir, "answers"), { recursive: true });
      writeFileSync(join(outDir, "answers", `${c.id}.${r + 1}.txt`), answer);
    }
    const observed = observePrime(linesSince(before));
    if (observed.sync !== "absent") sawSync = true;
    const res = scorePrimeCase(c, observed);
    results.push(res);
    if (!args.json) process.stderr.write(`${res.correct ? "ok" : "MISS"} ${observed.sync}/${observed.outcome}\n`);
  }
}

const summary = summarizePrime(results);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "last-report.json"), JSON.stringify({ gold: goldPath, repeat, origin: "sdk (stands in for composer)", summary, results }, null, 2));

if (args.json) {
  console.log(JSON.stringify({ gold: goldPath, repeat, origin: "sdk", summary, results }, null, 2));
} else {
  console.log("");
  console.log("origin: sdk (stands in for composer under -p)");
  if (!sawSync) console.log("WARNING: no prime:sync line was logged — primeContext did not reach the module (check --settings / --plugin-dir).");
  console.log(formatPrimeSummary(summary));
}
