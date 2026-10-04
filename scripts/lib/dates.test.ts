/**
 * `published:` derivation on invented note bodies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePublished, insertFrontmatterPublished } from "./dates.ts";

test("arXiv ids give year-month, prefixed anywhere on a labelled line or bare on an arXiv line", () => {
  assert.deepEqual(derivePublished("**Links**: [arXiv:2511.01234](https://arxiv.org/abs/2511.01234v1)"), { published: "2025-11", from: "arxiv" });
  assert.deepEqual(derivePublished("**arXiv:** 2605.04321"), { published: "2026-05", from: "arxiv" });
  assert.deepEqual(derivePublished("**Published:** Acme Workshop '25, arXiv:2503.01111"), { published: "2025-03", from: "arxiv" });
});

test("dates in their common spellings, most precise first", () => {
  assert.deepEqual(derivePublished("**Published:** 2026-07-30, updated 2026-08-03"), { published: "2026-07-30", from: "date" });
  assert.deepEqual(derivePublished("**Published:** June 3, 2026"), { published: "2026-06-03", from: "date" });
  assert.deepEqual(derivePublished("**Source:** Acme Gazette, December 2025"), { published: "2025-12", from: "month" });
  assert.deepEqual(derivePublished("**Published:** Journal of Gamma Studies 12(3):10–40, 2010"), { published: "2010", from: "year" });
});

test("only labelled lines count; body citations and URL paths never date a note", () => {
  assert.equal(derivePublished("We build on arXiv:2101.00001 and https://arxiv.org/abs/2102.00002."), null);
  assert.equal(derivePublished("**URL:** https://example.com/2019/archive"), null);
  assert.equal(derivePublished("# Alpha Method\n\nNo source line at all."), null);
});

test("a Published line wins over an earlier Source line", () => {
  const body = "**Source:** [thread, 2026-01-02](https://example.com)\n**Published:** March 2025";
  assert.deepEqual(derivePublished(body), { published: "2025-03", from: "month" });
});

test("insertFrontmatterPublished appends one line and touches nothing else", () => {
  const raw = "---\ntags: [paper]\n---\n# Alpha Method\n";
  assert.equal(insertFrontmatterPublished(raw, "2025-02"), "---\ntags: [paper]\npublished: '2025-02'\n---\n# Alpha Method\n");
  assert.equal(insertFrontmatterPublished("# No frontmatter\n", "2025"), null);
});
