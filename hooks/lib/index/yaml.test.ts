import { test } from "node:test";
import assert from "node:assert/strict";
import matter from "gray-matter";
import { parseYaml, parseFrontmatter, splitFrontmatter, resolvePlain } from "./yaml.ts";

/**
 * Invented frontmatter variants (never copied from a vault). Each is run
 * through gray-matter and yaml.ts; the outputs must agree, except that a
 * gray-matter Date is expected as the string the author wrote.
 */
const FIXTURES: Record<string, string> = {
  "simple scalars": `title: Alpha Report\ncreated: 2026-01-05\nrating: 4\nratio: 0.75\ndone: true\nskip: False\nnothing:\ntilde: ~`,
  "block sequence indented": `tags:\n  - paper\n  - alpha`,
  "block sequence compact": `tags:\n- paper\n- alpha\nscope: public`,
  "flow sequence": `tags: [paper, alpha, "quoted one", 'single']`,
  "flow sequence trailing comma": `tags: [paper, alpha,]`,
  "empty flow sequence": `tags: []\nmocs: {}`,
  "quoted wikilinks": `concepts:\n  - "[[Alpha Method]]"\n  - '[[Gamma Term|the gamma term]]'`,
  "unquoted wikilinks": `concepts:\n  - [[Alpha Method]]\nmocs: [[Gamma MOC]]`,
  "flow of quoted wikilinks": `concepts: ["[[Alpha Method]]", "[[Gamma Term]]"]`,
  "double-quoted escapes": `a: "tab\\there"\nb: "line\\nbreak"\nc: "quote \\" inside"\nd: "\\u00e9t\\x41"\ne: "back\\\\slash"`,
  "single-quoted escapes": `a: 'it''s here'\nb: 'no \\n escape'`,
  "comments everywhere": `# leading comment\ntitle: Alpha # trailing\ntags: # on key line\n  - one # item comment\n  # between items\n  - two\nurl: http://example.test/#anchor`,
  "literal block": `summary: |\n  Line one\n  Line two\n\n  Line four\nnext: x`,
  "folded block": `summary: >\n  Folded line one\n  folded line two\n\n  new paragraph\n    more indented\n  back\nnext: x`,
  "block chomping": `strip: |-\n  text\n\nkeep: |+\n  text\n\nclip: >\n  text\n\nlast: end`,
  "block explicit indent": `code: |2\n    indented two extra\n  base\nafter: y`,
  "multi-line plain": `abstraction: Alpha drift reduction\n  via staged calibration\n  of the gamma term\nnext: z`,
  "multi-line double-quoted": `abstraction: "Alpha drift reduction\n  via staged\n\n  calibration"\nnext: z`,
  "sequence of mappings": `compiledFrom:\n  - path: Alpha/Alpha Report.md\n    hash: abc123\n  - path: Gamma/Gamma Notes.md\n    hash: 0x1F`,
  "nested mapping": `meta:\n  author: Acme\n  count: 3\n  inner:\n    deep: yes\nflat: 1`,
  "numbers js-yaml style": `int: 42\nneg: -7\nplus: +3\nhex: 0x1A\noct: 017\nbin: 0b101\nunder: 1_000\nfloat: 1.5e3\ndot: .5\ninf: .inf\nnan: .NaN\nsexa: 1:30\nnotnum: 08\nversion: 1.2.3`,
  "string lookalikes": `a: yes\nb: no\nc: on\nd: "true"\ne: '42'\nf: 2026-13-45x\ng: null\nh: NULL`,
  "colons in values": `source: https://example.test/a:b\ntime: "10:30"\nratio: a:b`,
  "unicode and emoji": `title: Café Ünïcode — dash\nalias: "日本語"`,
  "aliases and typed relations": `aliases: [AR, Alpha R]\nbuilds_on:\n  - "[[Alpha Method]]"\ncompares_with: "[[Gamma Term]]"\nuses_method: []\nsupersedes: "[[Old Alpha]]"`,
  "datetime": `created: 2026-01-05T10:20:30Z\nupdated: 2026-02-01`,
  "quoted keys": `"quoted key": 1\n'single key': two`,
  "empty values in sequence": `items:\n  -\n  - two\n  - ""`,
  "nested sequences": `matrix:\n  - - a\n    - b\n  - [c, d]`,
  "multi-line flow": `tags: [\n  alpha,\n  gamma\n]\nnext: 1`,
  "only comments": `# just a comment\n# another`,
  "plain with hash no space": `tag: c#sharp\nissue: #12`,
  "indented top level": `  title: Indented\n  tags: [a]`,
  "flow mapping": `meta: {author: Acme, count: 2}`,
  "trailing whitespace": `title:   Alpha Report   \nkey with spaces: v\nkey-with-dash: w  `,
  "apostrophes and dashes in plain": `title: it's a - test, really\nnote: x - done`,
  "block scalar at end": `summary: |\n  last line`,
  "folded leading blank lines": `summary: >\n\n  after blank\n  joined`,
  "crlf line endings": `title: Alpha\r\ntags:\r\n  - a\r\n  - b`,
  "mapping in sequence with nested list": `entries:\n  - name: Alpha\n    tags:\n      - x\n      - y\n  - name: Gamma\n    tags: [z]`,
  "empty strings": `a: ""\nb: ''\nc: " padded "`,
  "single-quoted multi-line": `a: 'one\n  two'\nb: 1`,
  "escaped newline in double quotes": `a: "one \\\n  two"`,
  "deeply indented sequence under key": `tags:\n      - a\n      - b`,
  "key without space before flow": `tags:   [a]\nconcepts:\n  - "[[Alpha Method]]" # why`,
};

/** Cases js-yaml rejects; yaml.ts must reject them too (error, empty data). */
const REJECTED: Record<string, string> = {
  "duplicate key": `title: A\ntitle: B`,
  "nested colon": `title: Alpha: Beta`,
  "unterminated quote": `title: "never closed`,
  "unterminated flow": `tags: [a, b`,
  "bad indentation": `a: 1\n   b: 2`,
};

/**
 * Valid YAML outside the subset: gray-matter accepts these, yaml.ts reports
 * `error` so the file is recorded parseError and the CLI stays authoritative.
 */
const OUT_OF_SUBSET: Record<string, string> = {
  "tab indentation": `tags:\n\t- a`,
  "anchor and alias": `a: &x 1\nb: *x`,
  "explicit tag": `a: !!str 12`,
  "complex key": `? a\n: 1`,
};

function normaliseDates(v: unknown): unknown {
  if (v instanceof Date) return { __date: v.toISOString() };
  if (Array.isArray(v)) return v.map(normaliseDates);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normaliseDates(x)]));
  }
  return v;
}

function oursWithDates(v: unknown, gm: unknown): unknown {
  // Where gray-matter produced a Date, we produce the written string.
  if (gm instanceof Date && typeof v === "string") {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00:00Z" : v);
    return { __date: d.toISOString() };
  }
  if (Array.isArray(v) && Array.isArray(gm)) return v.map((x, k) => oursWithDates(x, gm[k]));
  if (v && typeof v === "object" && gm && typeof gm === "object" && !Array.isArray(v)) {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, oursWithDates(x, (gm as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

function grayMatter(fm: string): { data: unknown; error?: string } {
  try {
    // A fresh options object bypasses gray-matter's content cache.
    return { data: matter(`---\n${fm}\n---\nbody\n`, {}).data };
  } catch (e) {
    return { data: undefined, error: String(e) };
  }
}

test("fixture set is large enough", () => {
  assert.ok(Object.keys(FIXTURES).length + Object.keys(REJECTED).length >= 25);
});

for (const [name, fm] of Object.entries(FIXTURES)) {
  test(`differential vs gray-matter: ${name}`, () => {
    const gm = grayMatter(fm);
    assert.equal(gm.error, undefined, `gray-matter rejected fixture: ${gm.error}`);
    const ours = parseYaml(fm);
    assert.equal(ours.error, undefined, `yaml.ts rejected: ${ours.error}`);
    assert.deepEqual(oursWithDates(ours.data, gm.data), normaliseDates(gm.data));
  });
}

for (const [name, fm] of Object.entries(REJECTED)) {
  test(`both reject: ${name}`, () => {
    assert.ok(grayMatter(fm).error, "gray-matter accepted it");
    const ours = parseYaml(fm);
    assert.ok(ours.error, "yaml.ts accepted it");
    assert.deepEqual(ours.data, {});
  });
}

for (const [name, fm] of Object.entries(OUT_OF_SUBSET)) {
  test(`out of subset, fallback to CLI: ${name}`, () => {
    assert.equal(grayMatter(fm).error, undefined);
    const ours = parseYaml(fm);
    assert.ok(ours.error);
    assert.deepEqual(ours.data, {});
  });
}

test("dates stay as written strings (deliberate divergence)", () => {
  const { data } = parseYaml("created: 2026-01-05\nat: 2026-01-05T10:20:30Z");
  assert.equal(data.created, "2026-01-05");
  assert.equal(data.at, "2026-01-05T10:20:30Z");
});

test("golden: a typical source note frontmatter", () => {
  const { data, error } = parseYaml(
    [
      "title: Alpha Report",
      "tags: [paper, alpha]",
      "concepts:",
      '  - "[[Alpha Method]]"',
      '  - "[[Gamma Term]]"',
      "abstraction: Alpha drift reduction via staged calibration",
      "created: 2026-01-05",
    ].join("\n"),
  );
  assert.equal(error, undefined);
  assert.deepEqual(data, {
    title: "Alpha Report",
    tags: ["paper", "alpha"],
    concepts: ["[[Alpha Method]]", "[[Gamma Term]]"],
    abstraction: "Alpha drift reduction via staged calibration",
    created: "2026-01-05",
  });
});

test("never throws on garbage", () => {
  for (const junk of ["{", "]", ":", "- - -", "a: [", '"', "a: |x", "? k", "a:\n  - b\n c: d"]) {
    const r = parseYaml(junk);
    assert.equal(typeof r, "object");
  }
});

test("__proto__ key is stored as data, not a prototype", () => {
  const { data } = parseYaml("__proto__: x\nok: 1");
  assert.equal(Object.getPrototypeOf(data), Object.prototype);
  assert.equal(data["__proto__"], "x");
});

test("resolvePlain matches js-yaml typing", () => {
  assert.equal(resolvePlain("0o17"), "0o17");
  assert.equal(resolvePlain("017"), 15);
  assert.equal(resolvePlain("1_"), "1_");
  assert.equal(resolvePlain("-.inf"), -Infinity);
  assert.equal(resolvePlain("1."), 1);
});

test("splitFrontmatter follows gray-matter delimiters", () => {
  const cases = [
    "---\na: 1\n---\nbody",
    "---\na: 1\n---\r\nbody",
    "no frontmatter\n---\na: 1",
    "----\na: 1\n----\nbody",
    "---\na: 1\nno close",
    "---yaml\na: 1\n---\nbody",
    "\ufeff---\na: 1\n---\n\nbody",
  ];
  for (const text of cases) {
    let gm: ReturnType<typeof matter> | null = null;
    try {
      gm = matter(text, {});
    } catch {
      gm = null;
    }
    const parsed = parseFrontmatter(text);
    if (!gm) {
      assert.ok(parsed.error, JSON.stringify(text));
      continue;
    }
    assert.equal(splitFrontmatter(text).body, gm.content, JSON.stringify(text));
    assert.deepEqual(parsed.data, gm.data, JSON.stringify(text));
  }
});
