#!/usr/bin/env tsx
/**
 * commonplace connect — the "Connect" substrate. Given a query (or a starting
 * note), returns a small ranked POOL of notes that are graph-close to where you
 * start, focused by lexical relevance. This is the deterministic, zero-token
 * jumping-off set for wiki-query's agentic loop: the model triages the pool's
 * abstractions, reads the 1-3 that matter, and abstains when nothing truly
 * connects. "grep finds, reading connects" — connect finds where to read.
 *
 * Score (validated in the Connect eval, gentle-gate variant):
 *     score(n) = norm(PPR(n)) + lambda * norm(lexical(n))
 * PPR carries graph reach (so a note wired to your seed by a typed relation
 * survives even with zero word overlap); the additive lexical term focuses the
 * ranking on-topic without gating graph neighbors out. Pure PPR floods hubs;
 * multiplicative lexical buries wordless-but-connected notes — additive is the
 * sweet spot (pool target-recall 0.938 vs 0.896 multiplicative).
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "fs";
import { join, relative } from "path";
import { resolveVault, loadIndexes } from "./lib/vault.js";
import { connectPool } from "./lib/connect.js";
import type { BacklinkRecord } from "./lib/ppr.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    query: { type: "string" },
    note: { type: "string" }, // vault-relative path to seed from a specific note
    k: { type: "string", default: "20" },
    lambda: { type: "string", default: "0.25" },
    alpha: { type: "string", default: "0.85" },
    "seed-k": { type: "string", default: "5" },
    json: { type: "boolean", default: false },
  },
});

if (!values.query && !values.note) {
  console.error("error: --query <text> or --note <vault-relative-path> is required");
  process.exit(1);
}
const K = Number(values.k);
const lambda = Number(values.lambda);
const alpha = Number(values.alpha);
const seedK = Number(values["seed-k"]);
for (const [name, v] of [["k", K], ["lambda", lambda], ["alpha", alpha], ["seed-k", seedK]] as const) {
  if (!Number.isFinite(v)) {
    console.error(`error: --${name} must be a number`);
    process.exit(1);
  }
}

const config = resolveVault(values.vault);
const indexes = loadIndexes(config);
const rel = (p: string) => relative(config.vaultPath, p);
// Normalize everything to ONE path space (vault-relative) for graph + output.
for (const s of indexes.sources) s.path = rel(s.path);
for (const c of indexes.concepts) c.path = rel(c.path);
for (const m of indexes.mocs) m.path = rel(m.path);

const backlinkPath = join(config.wikiPath, "backlink-index.jsonl");
const backlinks: BacklinkRecord[] = existsSync(backlinkPath)
  ? readFileSync(backlinkPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as BacklinkRecord)
  : [];

const noteRel = values.note ? rel(join(config.vaultPath, values.note)) : undefined;
let result;
try {
  result = connectPool(
    { ...indexes, backlinks },
    { query: values.query, note: noteRel, k: K, lambda, alpha, seedK },
  );
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}

const candidates = result.candidates.map((c) => ({
  path: c.path,
  title: c.title,
  kind: c.kind,
  abstraction: c.abstraction,
  ppr: Number(c.ppr.toFixed(6)),
  lex: Number(c.lex.toFixed(3)),
  score: Number(c.score.toFixed(4)),
}));

if (values.json) {
  console.log(JSON.stringify({ query: values.query ?? null, note: values.note ?? null, k: K, lambda, alpha, candidates }, null, 2));
} else {
  const from = values.note ? `note ${values.note}` : `query: ${values.query}`;
  console.log(`Connect pool for ${from}  (top ${K}, lambda=${lambda})`);
  if (candidates.length === 0) console.log("  (empty — no graph neighbors; try a different seed)");
  for (const c of candidates) {
    console.log(`  [${c.kind}] ${c.title}${c.abstraction ? ` — ${c.abstraction}` : ""}`);
    console.log(`      ${c.path}  (score ${c.score}, ppr ${c.ppr}, lex ${c.lex})`);
  }
}
