import { test } from "node:test";
import assert from "node:assert/strict";
import { findFrontmatterEnd, linkNoteContent, type LinkTarget } from "./linker.ts";
import type { DomainRegistry } from "./types.ts";

const REGISTRY: DomainRegistry = {
  domains: {
    alpha: { path: "02 - Research/Alpha", scope: "public" },
    gamma: { path: "04 - Explorations/Gamma", scope: "private" },
    delta: { path: "04 - Explorations/Delta", scope: "private", linkGroup: "grouped" },
    epsilon: { path: "04 - Explorations/Epsilon", scope: "private", linkGroup: "grouped" },
  },
};

function concept(name: string): LinkTarget {
  return { name, type: "concept" };
}

test("wraps only the first safe occurrence", () => {
  const raw = "Alpha Method appears here. Later Alpha Method appears again.\n";
  const res = linkNoteContent(raw, [concept("Alpha Method")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, "[[Alpha Method]] appears here. Later Alpha Method appears again.\n");
  assert.equal(res.edits.length, 1);
});

test("never wraps a match inside a longer word", () => {
  const raw = "Methodology and Method-driven are not matches.\n";
  const res = linkNoteContent(raw, [concept("Method")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, null);
  assert.deepEqual(res.skipped, [{ name: "Method", reason: "no-match" }]);
});

test("skips matches inside existing wikilinks", () => {
  const raw = "See [[Alpha Method]] for details.\n";
  const res = linkNoteContent(raw, [concept("Alpha Method")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, null);
  assert.deepEqual(res.skipped, [{ name: "Alpha Method", reason: "no-match" }]);
});

test("skips the wikilinked mention but wraps a later bare mention", () => {
  const raw = "See [[Alpha Method]] and also Alpha Method in prose.\n";
  const res = linkNoteContent(raw, [concept("Alpha Method")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, "See [[Alpha Method]] and also [[Alpha Method]] in prose.\n");
});

test("skips matches inside fenced code blocks and inline code", () => {
  const raw = "```\nAlpha Method in a fence\n```\nAnd `Alpha Method` inline.\n";
  const res = linkNoteContent(raw, [concept("Alpha Method")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, null);
});

test("never touches frontmatter; body mention still wrapped", () => {
  const raw = "---\nsummary: Alpha Method matters\n---\nAlpha Method matters.\n";
  const res = linkNoteContent(raw, [concept("Alpha Method")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, "---\nsummary: Alpha Method matters\n---\n[[Alpha Method]] matters.\n");
});

test("skips matches on heading lines", () => {
  const raw = "# Alpha Method\n\nAlpha Method in prose.\n";
  const res = linkNoteContent(raw, [concept("Alpha Method")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, "# Alpha Method\n\n[[Alpha Method]] in prose.\n");
});

test("skips matches inside markdown link spans", () => {
  const raw = "[Alpha Method](https://example.com) then Alpha Method in prose.\n";
  const res = linkNoteContent(raw, [concept("Alpha Method")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, "[Alpha Method](https://example.com) then [[Alpha Method]] in prose.\n");
});

test("longer target claims its span before a shorter substring target", () => {
  const raw = "The Alpha Method matters.\n";
  const res = linkNoteContent(raw, [concept("Method"), concept("Alpha Method")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, "The [[Alpha Method]] matters.\n");
  assert.deepEqual(res.skipped, [{ name: "Method", reason: "no-match" }]);
});

test("longer and shorter targets both wrap when occurrences are disjoint", () => {
  const raw = "The Alpha Method and a plain Method.\n";
  const res = linkNoteContent(raw, [concept("Method"), concept("Alpha Method")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, "The [[Alpha Method]] and a plain [[Method]].\n");
});

test("case-insensitive match pipes the original text as alias", () => {
  const raw = "the alpha method appears in lowercase.\n";
  const res = linkNoteContent(raw, [concept("Alpha Method")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, "the [[Alpha Method|alpha method]] appears in lowercase.\n");
});

test("skips self-links", () => {
  const raw = "Alpha Method refers to itself.\n";
  const res = linkNoteContent(raw, [concept("Alpha Method")], "Alpha Method", null, REGISTRY);
  assert.equal(res.newContent, null);
  assert.deepEqual(res.skipped, [{ name: "Alpha Method", reason: "self-link" }]);
});

test("public note cannot link to a private-domain source target", () => {
  const raw = "Gamma Private Note is mentioned here.\n";
  const targets: LinkTarget[] = [{ name: "Gamma Private Note", type: "source", domain: "gamma" }];
  const res = linkNoteContent(raw, targets, "Some Note", "alpha", REGISTRY);
  assert.equal(res.newContent, null);
  assert.deepEqual(res.skipped, [{ name: "Gamma Private Note", reason: "scope" }]);
});

test("private notes sharing a linkGroup can link to each other", () => {
  const raw = "Epsilon Grouped Note is mentioned here.\n";
  const targets: LinkTarget[] = [{ name: "Epsilon Grouped Note", type: "source", domain: "epsilon" }];
  const res = linkNoteContent(raw, targets, "Some Note", "delta", REGISTRY);
  assert.equal(res.newContent, "[[Epsilon Grouped Note]] is mentioned here.\n");
});

test("a concept with no domain signal stays linkable (can't scope it)", () => {
  const raw = "Shared Bridge Concept is mentioned here.\n";
  const targets: LinkTarget[] = [{ name: "Shared Bridge Concept", type: "concept" }];
  const res = linkNoteContent(raw, targets, "Some Note", "alpha", REGISTRY);
  assert.equal(res.newContent, "[[Shared Bridge Concept]] is mentioned here.\n");
});

test("a concept living in a reachable domain is linkable", () => {
  const raw = "Shared Bridge Concept is mentioned here.\n";
  // Referenced by both a public (alpha) and a private (gamma) domain.
  const targets: LinkTarget[] = [
    { name: "Shared Bridge Concept", type: "concept", domains: ["alpha", "gamma"] },
  ];
  const res = linkNoteContent(raw, targets, "Some Note", "alpha", REGISTRY);
  assert.equal(res.newContent, "[[Shared Bridge Concept]] is mentioned here.\n");
});

test("public note cannot link to a private-domain concept homonym", () => {
  // A concept name that also exists as a private-domain note: a public note
  // must not be wired to the private homonym just because the string matched.
  const raw = "Gamma Term is mentioned here.\n";
  const targets: LinkTarget[] = [{ name: "Gamma Term", type: "concept", domains: ["gamma"] }];
  const res = linkNoteContent(raw, targets, "Some Note", "alpha", REGISTRY);
  assert.equal(res.newContent, null);
  assert.deepEqual(res.skipped, [{ name: "Gamma Term", reason: "scope" }]);
});

test("a note in the concept's own private domain can still link it", () => {
  const raw = "Gamma Term is mentioned here.\n";
  const targets: LinkTarget[] = [{ name: "Gamma Term", type: "concept", domains: ["gamma"] }];
  const res = linkNoteContent(raw, targets, "Some Note", "gamma", REGISTRY);
  assert.equal(res.newContent, "[[Gamma Term]] is mentioned here.\n");
});

test("findFrontmatterEnd: no frontmatter returns 0", () => {
  assert.equal(findFrontmatterEnd("Just a body.\n"), 0);
});

test("findFrontmatterEnd: unclosed frontmatter returns 0", () => {
  assert.equal(findFrontmatterEnd("---\ntitle: x\nno closing fence\n"), 0);
});

test("findFrontmatterEnd: returns offset past the closing fence", () => {
  const raw = "---\ntitle: x\n---\nBody.\n";
  assert.equal(findFrontmatterEnd(raw), raw.indexOf("Body."));
});

test("regex metacharacters in target names are escaped", () => {
  const raw = "Alpha Method (v2.1) appears here.\n";
  const res = linkNoteContent(raw, [concept("Alpha Method (v2.1)")], "Some Note", null, REGISTRY);
  assert.equal(res.newContent, "[[Alpha Method (v2.1)]] appears here.\n");
});
