import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNames, resolve, claimants, normalizeKey, stemOf, type NameNode } from "./resolver.ts";

const node = (id: number, path: string, title = "", aliases: string[] = []): NameNode => ({ id, path, title, aliases });

const fixture: NameNode[] = [
  node(0, "alpha/Alpha Method.md", "Alpha Method", ["AM", "alpha technique"]),
  node(1, "gamma/Gamma Term.md", "The Gamma Term", ["gt"]),
  // claims "am" as its STEM — must outrank node 0's alias
  node(2, "beta/AM.md", "Acme Memo"),
  // two notes claim the same alias: lexicographic path decides
  node(3, "zeta/Zeta Report.md", "", ["shared"]),
  node(4, "delta/Delta Report.md", "", ["shared"]),
  // same stem in two folders: path decides
  node(5, "omega/Duplicate.md"),
  node(6, "kappa/Duplicate.md"),
  // a title that collides with another note's alias: alias outranks title
  node(7, "misc/Other.md", "alpha technique"),
];

function shuffled<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test("claimant order is total: stem > alias > title, then path", () => {
  const names = buildNames(fixture);
  assert.deepEqual(names.get("am"), [2, 0]);
  assert.deepEqual(names.get("shared"), [4, 3]); // delta/ < zeta/
  assert.deepEqual(names.get("duplicate"), [6, 5]); // kappa/ < omega/
  assert.deepEqual(names.get("alpha technique"), [0, 7]);
  assert.deepEqual(names.get("the gamma term"), [1]);
});

test("the same nodes in any order build an identical map", () => {
  const want = [...buildNames(fixture).entries()];
  for (let seed = 1; seed <= 25; seed++) {
    assert.deepEqual([...buildNames(shuffled(fixture, seed)).entries()], want, `seed ${seed}`);
  }
});

test("a node claiming one key twice is listed once, at its best rank", () => {
  const names = buildNames([node(0, "Alpha.md", "Alpha", ["alpha"]), node(1, "a/Beta.md", "", ["Alpha"])]);
  assert.deepEqual(names.get("alpha"), [0, 1]);
});

test("resolve is case-insensitive and follows aliases", () => {
  const names = buildNames(fixture);
  assert.equal(resolve(names, "alpha method"), 0);
  assert.equal(resolve(names, "ALPHA METHOD"), 0);
  assert.equal(resolve(names, "Alpha Technique"), 0);
  assert.equal(resolve(names, "GT"), 1);
  assert.equal(resolve(names, "AM"), 2);
  assert.equal(resolve(names, "Nonexistent Note"), null);
});

test("resolve strips anchors, block refs, display text, .md and whitespace", () => {
  const names = buildNames(fixture);
  assert.equal(resolve(names, "Alpha Method#Results"), 0);
  assert.equal(resolve(names, "Alpha Method#^block-1"), 0);
  assert.equal(resolve(names, "Alpha Method^block-1"), 0);
  assert.equal(resolve(names, "Alpha Method|the method"), 0);
  assert.equal(resolve(names, "Alpha Method#Results|see results"), 0);
  assert.equal(resolve(names, " Alpha Method.md "), 0);
});

test("attachments and bare anchors never resolve", () => {
  const names = buildNames([...fixture, node(9, "files/diagram.md")]);
  assert.equal(resolve(names, "diagram.png"), null);
  assert.equal(resolve(names, "Report.PDF"), null);
  assert.equal(resolve(names, "#Heading"), null);
  assert.equal(resolve(names, "|display"), null);
  assert.equal(resolve(names, ""), null);
  assert.equal(normalizeKey("diagram.png"), null);
  // a dot that is not an attachment extension is part of the name
  assert.equal(normalizeKey("Version 2.5 Notes"), "version 2.5 notes");
});

test("claimants exposes the next claimant for delete handling", () => {
  const names = buildNames(fixture);
  assert.deepEqual(claimants(names, "Shared#x"), [4, 3]);
  assert.deepEqual(claimants(names, "missing"), []);
});

test("empty titles and blank aliases claim nothing", () => {
  const names = buildNames([node(0, "Alpha.md", "", ["", "  "])]);
  assert.deepEqual([...names.keys()], ["alpha"]);
});

test("stemOf drops directories (either separator) and .md", () => {
  assert.equal(stemOf("/v/alpha/Alpha Method.md"), "Alpha Method");
  assert.equal(stemOf("v\\gamma\\Gamma Term.MD"), "Gamma Term");
});
