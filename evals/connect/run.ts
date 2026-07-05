#!/usr/bin/env tsx
/**
 * Connect eval runner — measures the "Connect" layer (note→note relational
 * retrieval) the way eval:retrieval measures the "Find" layer.
 *
 * Substrate pass (always, zero-token): builds the PPR pool for each gold
 * question and reports pool target-recall, first-target MRR, and a top-k
 * baseline — all with bootstrap CIs. This is the deterministic ceiling the
 * agentic loop works under.
 *
 * Agentic pass (--triage <dir>): scores model triage transcripts
 * (<id>.json = {"picks":[...],"abstain":bool,"reframe_query":string|null})
 * against the gold — positive recall/precision/F1 and, crucially, the
 * abstain-rate on near-miss NEGATIVES that no score threshold can separate.
 * Producing those transcripts is an agent task (wiki-query per question), not
 * this script's job.
 *
 * Gold: --gold, default $VAULT/.wiki/evals/connect-gold.jsonl (per-vault, NEVER
 * committed). Negatives: --negatives, default connect-negatives.jsonl.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join, relative, dirname } from "path";
import { parseArgs } from "node:util";
import { execFileSync } from "child_process";
import { resolveVault, loadIndexes } from "../../scripts/lib/vault.js";
import { connectPool } from "../../scripts/lib/connect.js";
import type { BacklinkRecord } from "../../scripts/lib/ppr.js";
import {
  targetsOf,
  poolMetrics,
  triageMetrics,
  bootstrapCI,
  type ConnectGold,
  type TriageResult,
  type CI,
} from "./score.js";

const { values: args } = parseArgs({
  options: {
    vault: { type: "string" },
    gold: { type: "string" },
    negatives: { type: "string" },
    triage: { type: "string" },
    k: { type: "string", default: "20" },
    "baseline-k": { type: "string", default: "3" },
    lambda: { type: "string", default: "0.25" },
    history: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});
const K = Number(args.k);
const baselineK = Number(args["baseline-k"]); // fair no-abstain baseline: return top-N, never abstain
const lambda = Number(args.lambda);

const config = resolveVault(args.vault);
const readJsonl = <T,>(p: string): T[] =>
  readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

const goldPath = args.gold ?? join(config.wikiPath, "evals", "connect-gold.jsonl");
if (!existsSync(goldPath)) {
  console.error(`error: connect gold set not found at ${goldPath}`);
  console.error("Create one per-vault at .wiki/evals/connect-gold.jsonl, or pass --gold <path>.");
  process.exit(1);
}
const negPath = args.negatives ?? join(config.wikiPath, "evals", "connect-negatives.jsonl");
const gold: ConnectGold[] = readJsonl<ConnectGold>(goldPath);
const negatives: ConnectGold[] = existsSync(negPath) ? readJsonl<ConnectGold>(negPath) : [];
const positives = gold.filter((g) => g.type !== "negative");
const allNeg = [...gold.filter((g) => g.type === "negative"), ...negatives];

// Load + normalize indexes to vault-relative (one path space for the graph).
const indexes = loadIndexes(config);
const rel = (p: string) => relative(config.vaultPath, p);
for (const s of indexes.sources) s.path = rel(s.path);
for (const c of indexes.concepts) c.path = rel(c.path);
for (const m of indexes.mocs) m.path = rel(m.path);
const backlinkPath = join(config.wikiPath, "backlink-index.jsonl");
const backlinks: BacklinkRecord[] = existsSync(backlinkPath) ? readJsonl<BacklinkRecord>(backlinkPath) : [];
const input = { ...indexes, backlinks };

const poolOf = (q: string): string[] =>
  connectPool(input, { query: q, k: K, lambda }).candidates.map((c) => c.path);

// --- Substrate pass ---
const poolRecall: number[] = [];
const poolMrr: number[] = [];
const baseF1: number[] = [];
const baseRecall: number[] = [];
const perQuestion: Array<Record<string, unknown>> = [];
for (const g of positives) {
  const targets = targetsOf(g);
  const pool = poolOf(g.question);
  const m = poolMetrics(targets, pool, baselineK);
  poolRecall.push(m.recall);
  poolMrr.push(m.mrr);
  baseF1.push(m.baseF1);
  baseRecall.push(m.baseRecall);
  perQuestion.push({ id: g.id, type: g.type, targets: targets.length, ...m });
}

// --- Agentic pass (optional) ---
let triageOut:
  | {
      posRecall: CI;
      posPrecision: CI;
      posF1: CI;
      falseAbstain: number;
      negAbstain: CI;
      baselineNegAbstain: number;
    }
  | undefined;
if (args.triage) {
  const load = (id: string): TriageResult | null => {
    const f = join(args.triage!, `${id}.json`);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf-8")) as TriageResult) : null;
  };
  const pRec: number[] = [], pPrec: number[] = [], pF1: number[] = [];
  let falseAbstain = 0;
  for (const g of positives) {
    const t = load(g.id);
    if (!t) continue;
    const m = triageMetrics(targetsOf(g), t.picks, t.abstain);
    pRec.push(m.recall);
    pPrec.push(m.precision);
    pF1.push(m.f1);
    if (m.abstained) falseAbstain++;
  }
  const negAbs: number[] = [];
  for (const g of allNeg) {
    const t = load(g.id);
    if (!t) continue;
    negAbs.push(t.abstain || t.picks.length === 0 ? 1 : 0);
  }
  triageOut = {
    posRecall: bootstrapCI(pRec),
    posPrecision: bootstrapCI(pPrec),
    posF1: bootstrapCI(pF1),
    falseAbstain,
    negAbstain: bootstrapCI(negAbs),
    baselineNegAbstain: 0, // top-k baseline never abstains, by construction
  };
}

const ci = (c: CI) => `${c.mean.toFixed(3)} [${c.lo.toFixed(3)}, ${c.hi.toFixed(3)}]`;
const substrate = {
  poolRecall: bootstrapCI(poolRecall),
  poolMrr: bootstrapCI(poolMrr),
  baselineF1: bootstrapCI(baseF1),
  baselineRecall: bootstrapCI(baseRecall),
};

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
  k: K,
  lambda,
  nPositives: positives.length,
  nNegatives: allNeg.length,
  substrate,
  ...(triageOut ? { triage: triageOut } : {}),
};

if (args.history) {
  const historyPath = join(config.wikiPath, "connect-eval-history.jsonl");
  mkdirSync(dirname(historyPath), { recursive: true });
  appendFileSync(historyPath, JSON.stringify(record) + "\n");
}

if (args.json) {
  console.log(JSON.stringify({ ...record, perQuestion }, null, 2));
} else {
  console.log(`Connect eval — ${positives.length} positives, ${allNeg.length} negatives, k=${K}, lambda=${lambda}`);
  console.log(`\n  SUBSTRATE (deterministic pool, mean [95% CI]):`);
  console.log(`    pool target-recall:   ${ci(substrate.poolRecall)}   <- triage ceiling`);
  console.log(`    first-target MRR:     ${ci(substrate.poolMrr)}`);
  console.log(`    baseline top-${baselineK} recall: ${ci(substrate.baselineRecall)}`);
  console.log(`    baseline top-${baselineK} F1:     ${ci(substrate.baselineF1)}`);
  if (triageOut) {
    console.log(`\n  AGENTIC (triage transcripts, mean [95% CI]):`);
    console.log(`    positive recall:      ${ci(triageOut.posRecall)}`);
    console.log(`    positive precision:   ${ci(triageOut.posPrecision)}`);
    console.log(`    positive F1:          ${ci(triageOut.posF1)}   (baseline F1 ${ci(substrate.baselineF1)})`);
    console.log(`    false abstentions:    ${triageOut.falseAbstain}/${positives.length} positives`);
    console.log(`    negative abstain:     ${ci(triageOut.negAbstain)}   (baseline ${triageOut.baselineNegAbstain.toFixed(3)} — never abstains)`);
  } else {
    console.log(`\n  (pass --triage <dir> of <id>.json transcripts to score the agentic loop + abstention)`);
  }
}
