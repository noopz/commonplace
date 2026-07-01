import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeIngestedBody, splitFrontmatterRaw } from "./sanitize.ts";

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

test("splitFrontmatterRaw preserves the frontmatter block byte-for-byte, including original YAML style and date format", () => {
  const raw = [
    "---",
    "tags: [source]",
    "created: 2026-06-30",
    "concepts: []",
    "mocs: []",
    "---",
    "# Test",
    "",
    "Check this out: ![tracker](https://t.example.com/beacon.gif?x=1)",
    "",
  ].join("\n");
  const { frontmatterBlock, body } = splitFrontmatterRaw(raw);
  assert.equal(
    frontmatterBlock,
    "---\ntags: [source]\ncreated: 2026-06-30\nconcepts: []\nmocs: []\n---\n",
  );
  assert.equal(body, "# Test\n\nCheck this out: ![tracker](https://t.example.com/beacon.gif?x=1)\n");

  const { body: cleanBody, stripped } = sanitizeIngestedBody(body);
  assert.equal(stripped.length, 1);
  const reassembled = frontmatterBlock + cleanBody;
  // Frontmatter half must be an exact substring match of the original raw text —
  // no re-serialization, no reformatted arrays or dates.
  assert.equal(reassembled.startsWith(frontmatterBlock), true);
  assert.equal(raw.startsWith(frontmatterBlock), true);
  assert.equal(reassembled.includes("tracker.example.com"), false);
  assert.equal(reassembled.includes("t.example.com"), false);
});

test("splitFrontmatterRaw returns the whole text as body when there is no frontmatter block", () => {
  const raw = "# No frontmatter here\n\nJust prose.\n";
  const { frontmatterBlock, body } = splitFrontmatterRaw(raw);
  assert.equal(frontmatterBlock, "");
  assert.equal(body, raw);
});
