import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeIngestedBody } from "./sanitize.ts";

test("strips a remote markdown image embed and reports it", () => {
  const body = "See this chart: ![sales chart](https://tracker.example.com/beacon.png?id=abc123)\n";
  const { body: clean, stripped } = sanitizeIngestedBody(body);
  assert.equal(clean.includes("tracker.example.com"), false);
  assert.equal(clean.includes("[image removed: sales chart]"), true);
  assert.equal(stripped.length, 1);
  assert.match(stripped[0], /remote image embed removed/);
});

test("does NOT touch a local Obsidian embed (double-bracket wikilink image)", () => {
  const body = "See the figure: ![[raw/assets/sales-chart.png]]\n";
  const { body: clean, stripped } = sanitizeIngestedBody(body);
  assert.equal(clean, body);
  assert.equal(stripped.length, 0);
});

test("strips an over-length bare URL and reports it", () => {
  const longUrl = "https://example.com/" + "a".repeat(320);
  const body = `Source: ${longUrl}\n`;
  const { body: clean, stripped } = sanitizeIngestedBody(body);
  assert.equal(clean.includes(longUrl), false);
  assert.equal(clean.includes("URL removed"), true);
  assert.equal(stripped.length, 1);
  assert.match(stripped[0], /over-length URL removed/);
});

test("leaves a normal short URL untouched", () => {
  const body = "Source: https://arxiv.org/abs/2401.01234\n";
  const { body: clean, stripped } = sanitizeIngestedBody(body);
  assert.equal(clean, body);
  assert.equal(stripped.length, 0);
});

test("leaves plain prose with no links untouched", () => {
  const body = "# Title\n\nJust some regular text with no links at all.\n";
  const { body: clean, stripped } = sanitizeIngestedBody(body);
  assert.equal(clean, body);
  assert.equal(stripped.length, 0);
});

test("handles multiple violations in one body", () => {
  const longUrl = "https://example.com/" + "b".repeat(320);
  const body = `![tracker](https://t.example.com/beacon.gif) and ${longUrl}\n`;
  const { stripped } = sanitizeIngestedBody(body);
  assert.equal(stripped.length, 2);
});
