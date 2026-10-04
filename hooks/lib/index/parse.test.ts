import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote, classify } from "./parse.ts";

const OPTS = {
  structure: { sources: "02 - Research", concepts: "Concepts", mocs: "MOCs" },
  domainPaths: ["04 - Explorations/Gamma"],
};

const SOURCE = `---
title: Alpha Report
aliases: [AR, "Alpha R", ""]
tags:
  - paper
  - alpha
concepts:
  - "[[Alpha Method]]"
  - [[Gamma Term]]
mocs: ["[[Alpha MOC]]"]
builds_on: "[[Beta Study]]"
compares_with:
  - "[[Delta Survey|the survey]]"
uses_method: []
supersedes: "[[Old Alpha Report]]"
abstraction: Alpha drift reduction via staged calibration
created: 2026-01-05
---
# Alpha Report

Intro paragraph with no links. Second sentence.

## Findings

The Alpha method reduces drift, per [[alpha method|the Alpha method]]. A later sentence cites [[Gamma Term#Definition]]!
- List item linking [[Beta Study]] and again [[Beta Study]].
> Quoted claim about [[Delta Survey]].

| Col | Link |
| --- | --- |
| a | [[Gamma Term\\|gamma]] |

\`\`\`python
# not a heading
x = "[[Fenced Link]]"
\`\`\`

Inline \`[[Code Link]]\` is ignored but [[Real Link]] is not.

![[Alpha Figure.png]]
![[Embedded Note]]
See [[#Findings]] above.

### Deeper
`;

test("golden: source note facts", () => {
  const n = parseNote("02 - Research/Alpha/Alpha Report.md", SOURCE, OPTS);
  assert.equal(n.parseError, undefined);
  assert.equal(n.title, "Alpha Report");
  assert.equal(n.kind, "source");
  assert.deepEqual(n.aliases, ["AR", "Alpha R"]);
  assert.deepEqual(n.tags, ["paper", "alpha"]);
  assert.equal(n.abstraction, "Alpha drift reduction via staged calibration");
  assert.equal(n.abstractionFallback, undefined);
  assert.deepEqual(n.headings, ["Alpha Report", "Findings", "Deeper"]);
  assert.equal(n.fm.created, "2026-01-05");
});

test("frontmatter relations become typed links", () => {
  const n = parseNote("02 - Research/Alpha/Alpha Report.md", SOURCE, OPTS);
  const fm = n.links.filter((l) => l.kind !== "body").map((l) => [l.kind, l.target, l.display ?? null]);
  assert.deepEqual(fm, [
    ["concept", "alpha method", null],
    ["concept", "gamma term", null],
    ["moc", "alpha moc", null],
    ["buildsOn", "beta study", null],
    ["comparesWith", "delta survey", "the survey"],
    ["supersedes", "old alpha report", null],
  ]);
  const c = n.links.find((l) => l.kind === "concept")!;
  assert.equal(c.heading, "");
  assert.equal(c.sentence, "concepts: [[Alpha Method]]");
});

test("body links: targets, display, embeds, code and anchors", () => {
  const n = parseNote("02 - Research/Alpha/Alpha Report.md", SOURCE, OPTS);
  const body = n.links.filter((l) => l.kind === "body");
  assert.deepEqual(
    body.map((l) => l.target),
    ["alpha method", "gamma term", "beta study", "beta study", "delta survey", "gamma term", "real link", "embedded note"],
  );
  const first = body[0];
  assert.equal(first.raw, "alpha method|the Alpha method");
  assert.equal(first.display, "the Alpha method");
  assert.equal(first.heading, "## Findings");
  assert.equal(first.sentence, "The Alpha method reduces drift, per [[alpha method|the Alpha method]].");
  assert.equal(body[1].raw, "Gamma Term#Definition");
  assert.equal(body[1].sentence, "A later sentence cites [[Gamma Term#Definition]]!");
  // Table-escaped alias pipe.
  assert.equal(body[5].raw, "Gamma Term|gamma");
  assert.equal(body[5].display, "gamma");
  assert.equal(body[5].sentence, "| a | [[Gamma Term\\|gamma]] |");
});

test("n counts occurrences per kind+target", () => {
  const n = parseNote("02 - Research/Alpha/Alpha Report.md", SOURCE, OPTS);
  const beta = n.links.filter((l) => l.target === "beta study");
  assert.deepEqual(beta.map((l) => [l.kind, l.n]), [["buildsOn", 1], ["body", 1], ["body", 2]]);
});

test("sentences strip list and quote markers", () => {
  const n = parseNote("02 - Research/Alpha/Alpha Report.md", SOURCE, OPTS);
  const body = n.links.filter((l) => l.kind === "body");
  assert.equal(body[2].sentence, "List item linking [[Beta Study]] and again [[Beta Study]].");
  assert.equal(body[4].sentence, "Quoted claim about [[Delta Survey]].");
});

test("a period inside a link does not split the sentence", () => {
  const n = parseNote("x/Note.md", "Version notes. See [[Alpha v1.2. Notes]] for details. Done.", OPTS);
  assert.equal(n.links[0].sentence, "See [[Alpha v1.2. Notes]] for details.");
});

test("long sentences are windowed to ≤200 chars and keep the link", () => {
  const filler = "word ".repeat(80);
  const text = `${filler}then [[Gamma Term]] appears ${filler}end.`;
  const n = parseNote("x/Note.md", text, OPTS);
  const s = n.links[0].sentence;
  assert.ok(s.length <= 200, String(s.length));
  assert.ok(s.includes("[[Gamma Term]]"));
});

test("abstraction fallback: first sentence after the H1, links stripped, ≤120 chars", () => {
  const n = parseNote(
    "Concepts/Gamma Term.md",
    "---\ntags: [concept]\n---\n# Gamma Term\n\n> [!note]\n> The [[Gamma Term|gamma term]] is the [[Alpha Method]]'s **drift** bound. More text.\n",
    OPTS,
  );
  assert.equal(n.kind, "concept");
  assert.equal(n.abstraction, "The gamma term is the Alpha Method's drift bound.");
  assert.equal(n.abstractionFallback, true);

  const long = parseNote("Concepts/Alpha Method.md", `# Alpha Method\n\n${"alpha ".repeat(40)}end.`, OPTS);
  assert.ok(long.abstraction.length <= 120);
  assert.ok(!long.abstraction.endsWith(" "));

  const stub = parseNote("Concepts/Beta.md", "# Beta\n\nDefinition pending - please update.\n", OPTS);
  assert.equal(stub.abstraction, "");
  assert.equal(stub.abstractionFallback, undefined);
});

test("classification mirrors classifyNote + index auto-discovery", () => {
  assert.equal(classify("02 - Research/Alpha/A.md", {}, OPTS), "source");
  assert.equal(classify("Concepts/A.md", {}, OPTS), "concept");
  assert.equal(classify("MOCs/A.md", {}, OPTS), "moc");
  assert.equal(classify("04 - Explorations/Gamma/A.md", {}, OPTS), "source");
  assert.equal(classify("Inbox/A.md", {}, OPTS), "other");
  assert.equal(classify("Inbox/A.md", { concepts: ["[[X]]"] }, OPTS), "source");
  assert.equal(classify("A.md", { concepts: ["[[X]]"] }, OPTS), "other");
  assert.equal(classify("Concepts-old/A.md", {}, OPTS), "other");
  assert.equal(classify("Concepts/A.md", {}, {}), "other");
});

test("a rejected frontmatter reports parseError and still parses the body", () => {
  const n = parseNote("x/Bad.md", "---\ntitle: A: B\n---\n# Bad\n\nLinks to [[Alpha Method]].\n", OPTS);
  assert.ok(n.parseError);
  assert.deepEqual(n.fm, {});
  assert.equal(n.links[0].target, "alpha method");
  assert.equal(n.abstraction, "Links to Alpha Method.");
});

test("malformed P-date lines and CRLF are tolerated", () => {
  const n = parseNote("x/N.md", "---\r\ntags: [a]\r\nP25-11-07\r\n---\r\n# N\r\nBody [[Gamma Term]].\r\n", OPTS);
  assert.equal(n.parseError, undefined);
  assert.deepEqual(n.tags, ["a"]);
  assert.equal(n.links[0].sentence, "Body [[Gamma Term]].");
});

test("no frontmatter at all", () => {
  const n = parseNote("x/Plain.md", "Just text with [[Alpha Method]].", OPTS);
  assert.deepEqual(n.fm, {});
  assert.equal(n.parseError, undefined);
  assert.equal(n.links.length, 1);
  assert.equal(n.links[0].heading, "");
});

test("cues: a list of strings, trimmed, capped at 8 × 80 chars; absent when empty", () => {
  const long = "x".repeat(120);
  const text = `---\ncues:\n  - "  ledger drift fixes "\n  - ""\n  - ${long}\n---\n# Kappa Note\n`;
  const p = parseNote("Concepts/Kappa Note.md", text, OPTS);
  assert.deepEqual(p.cues, ["ledger drift fixes", "x".repeat(80)]);
  const many = `---\ncues: [${Array.from({ length: 12 }, (_, i) => `c${i}`).join(", ")}]\n---\n# Kappa\n`;
  assert.equal(parseNote("Concepts/Kappa.md", many, OPTS).cues?.length, 8);
  assert.equal(parseNote("Concepts/Kappa.md", "# Kappa\n", OPTS).cues, undefined);
});
