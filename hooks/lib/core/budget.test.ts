import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { addSpend, budgetLine, canSpend, costOf, dayOf, parsePricing, priceFor, raise, today } from "./budget.ts";

const PAGE = [
  "| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |",
  "| :---- | :---- | :---- | :---- | :---- | :---- |",
  "| Claude Gamma 9.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |",
  "| Claude Opus 7.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |",
  "| Claude Opus 7 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
  "| Claude Sonnet 7.5 ([limited](https://example.com)) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |",
  "| Claude Haiku 7.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |",
  "| Claude Haiku 7.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |",
].join("\n");

test("parsePricing reads the model table, skipping long-context rows and notes", () => {
  const t = parsePricing(PAGE)!;
  assert.deepEqual(t.map(([n]) => n), ["claude gamma 9.1", "claude opus 7.5", "claude opus 7", "claude sonnet 7.5", "claude haiku 7.5"]);
  assert.deepEqual(priceFor("claude-haiku-7-5", t), { input: 0.1, output: 0.5, read: 0.01, write: 0.125 });
  assert.equal(priceFor("claude-opus-7", t).input, 5, "an exact id finds its own row");
  assert.equal(priceFor("opus", t).input, 4, "an alias takes the family's newest row");
  assert.equal(priceFor("mystery", t).input, 4, "unknown is priced as the newest Opus");
  assert.equal(parsePricing("no table here"), null);
});

test("costOf prices tokens, cache reads and cache writes apart", () => {
  const t = parsePricing(PAGE)!;
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 };
  assert.equal(costOf("sonnet", u, t), 2 + 10 + 0.1 + 2.5);
  assert.ok(costOf("opus", u) > 0, "the fallback table prices without a page");
});

test("the live pricing page snapshot parses, when one is on disk", (t) => {
  const p = process.env.COMMONPLACE_PRICING_MD;
  if (!p) return t.skip("set COMMONPLACE_PRICING_MD to a saved copy of the pricing page");
  const table = parsePricing(readFileSync(p, "utf-8"))!;
  assert.ok(table.length >= 4);
  assert.ok(priceFor("haiku", table).input < priceFor("opus", table).input);
});

test("the day rolls over at local midnight and spending starts again", () => {
  const d1 = new Date(2026, 9, 30, 23, 59);
  const d2 = new Date(2026, 9, 31, 0, 1);
  let s = addSpend(today(null, d1), 5.2);
  assert.equal(s.day, dayOf(d1));
  assert.equal(canSpend(s, 5), false);
  s = today(s, d2);
  assert.equal(s.spent, 0);
  assert.equal(canSpend(s, 5), true);
});

test("raise doubles today's limit and clears the stop", () => {
  const s = raise({ day: "2026-10-30", spent: 5.1, stopped: true, noticed: true }, 5);
  assert.equal(s.limit, 10);
  assert.equal(canSpend(s, 5), true);
  assert.equal(s.stopped, false);
  assert.equal(budgetLine(s, 5), "vault spend today: $5.10 of $10");
  assert.match(budgetLine({ day: "x", spent: 6 }, 5), /paused until midnight/);
});
