#!/usr/bin/env node
/**
 * `eval:capture`: read capture's precision gate. Each case is an older note's
 * claim and something read (the owner's words, a page, a connector result);
 * the case runs through the SAME detect and review prompts the job runs,
 * imported from `hooks/lib/revision/review.ts`, then the reducer's own
 * `edgeFor`, which applies the relation limit. No vault, no session: bare
 * model calls. Not measured here: the gate, the proposer's exact quote,
 * verify and wording (each can only drop a change, never add one).
 *
 * Gold: the invented built-in set (./gold.ts), plus
 * `$VAULT/.wiki/evals/capture-gold.jsonl` when it exists (never committed).
 * Below the gate (./score.ts GATE), `readCapture` stays off by default.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "node:util";
import { spawn } from "child_process";
import { PLUGIN_OFF_SETTINGS } from "../plugin-ids.ts";
import { resolveVault } from "../../scripts/lib/vault.ts";
import { DETECT_SYSTEM, MODELS, REVIEW_SYSTEM, claimExcerpt, detectPrompt, parseDetect, parseReview, reviewPrompt } from "../../hooks/lib/revision/review.ts";
import { captureFraming } from "../../hooks/lib/revision/capture-gate.ts";
import { allowedRelations } from "../../scripts/lib/revision/capture.ts";
import { edgeFor, type ProposalState } from "../../scripts/lib/revision/reducer.ts";
import { BUILTIN } from "./gold.ts";
import { formatSummary, scoreCase, summarize, type CaptureCase, type CaptureTrial } from "./score.ts";

const { values: args } = parseArgs({
  options: { vault: { type: "string" }, repeat: { type: "string" }, only: { type: "string" }, json: { type: "boolean" }, concurrency: { type: "string" } },
});

const cases: CaptureCase[] = [...BUILTIN];
try {
  const gold = join(resolveVault(args.vault).vaultPath, ".wiki", "evals", "capture-gold.jsonl");
  if (existsSync(gold)) for (const l of readFileSync(gold, "utf-8").split("\n")) if (l.trim()) cases.push(JSON.parse(l));
} catch {
  /* no vault: the built-in set alone */
}
const picked = args.only ? cases.filter((c) => c.id.includes(args.only!)) : cases;
const repeat = Math.max(1, Number(args.repeat ?? 1));

const ask = (model: string, system: string, prompt: string): Promise<string> =>
  new Promise((done) => {
    const p = spawn("claude", ["-p", prompt, "--model", model, "--system-prompt", system, "--tools", "", "--settings", PLUGIN_OFF_SETTINGS()], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill(), 180_000);
    p.on("close", () => (clearTimeout(t), done(out)));
  });

async function trial(c: CaptureCase): Promise<CaptureTrial> {
  const newer = { title: c.capture.title, text: captureFraming({ class: c.class, source: c.source, text: c.capture.text }) };
  const cand = [{ title: c.older.title, abstraction: "", excerpt: claimExcerpt(c.older.text, c.capture.text) }];
  const det = parseDetect(await ask(MODELS.detect, DETECT_SYSTEM, detectPrompt(newer, cand)), 1);
  if (!det?.some((d) => d.n === 1)) return { detected: false, verdict: null, final: null };
  const rv = parseReview(await ask(MODELS.review, REVIEW_SYSTEM, reviewPrompt({ claim: c.older.claim, older: c.older, newer, oldFirst: Math.random() < 0.5 })));
  const verdict = rv?.verdict ?? null;
  // The edge the reducer would write for that decision, limit included.
  const allowed = allowedRelations({ class: c.class, source: c.source }, c.older.sources ?? []);
  const decided = verdict && verdict !== "none" && verdict !== "insufficient";
  const p = { decision: { relation: verdict, because: "" }, propose: { old: { claim: c.older.claim, title: c.older.title }, new: { rel: "capture:eval" }, capture: { hash: "eval", class: c.class, source: c.source, allowed } } };
  const final = decided ? (edgeFor(p as unknown as ProposalState)?.relation ?? null) : null;
  return { detected: true, verdict, final };
}

const jobs = picked.flatMap((c) => Array.from({ length: repeat }, () => c));
const trials = new Map<string, CaptureTrial[]>(picked.map((c) => [c.id, []]));
let i = 0;
await Promise.all(
  Array.from({ length: Math.max(1, Number(args.concurrency ?? 4)) }, async () => {
    while (i < jobs.length) {
      const c = jobs[i++];
      const t = await trial(c);
      trials.get(c.id)!.push(t);
      if (!args.json) process.stderr.write(`${c.id}: ${t.detected ? `detected → ${t.verdict ?? "?"}` : "not detected"}\n`);
    }
  }),
);

const results = picked.map((c) => scoreCase(c, trials.get(c.id)!));
const summary = summarize(results);
console.log(args.json ? JSON.stringify({ summary, results }, null, 2) : `\n${formatSummary(summary, results)}`);
