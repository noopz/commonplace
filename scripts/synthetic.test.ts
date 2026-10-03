import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateSynthetic, BASE, EXCLUDED_DIRS, LEXICON } from "./lib/synthetic.js";

function treeHash(root: string): string {
  const files: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else files.push(r);
    }
  };
  walk(root, "");
  files.sort();
  const h = createHash("sha256");
  for (const f of files) { h.update(f); h.update("\0"); h.update(readFileSync(join(root, f))); h.update("\0"); }
  return h.digest("hex");
}

const within = (n: number, target: number, tol: number) => Math.abs(n - target) <= target * tol;

test("same seed → identical tree and hash; different seed → different", () => {
  const a = mkdtempSync(join(tmpdir(), "syn-a-"));
  const b = mkdtempSync(join(tmpdir(), "syn-b-"));
  try {
    const ra = generateSynthetic({ scale: 1, out: a, seed: 7 });
    const rb = generateSynthetic({ scale: 1, out: b, seed: 7 });
    assert.equal(ra.hash, rb.hash);
    assert.equal(treeHash(a), treeHash(b));
    const rc = generateSynthetic({ scale: 1, out: "", seed: 8, dryRun: true });
    assert.notEqual(rc.hash, ra.hash);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("scale 1: counts, structure, Zipf hub, exclusions, private domains", () => {
  const out = mkdtempSync(join(tmpdir(), "syn-1-"));
  try {
    const r = generateSynthetic({ scale: 1, out, seed: 1 });
    const c = r.counts;
    assert.equal(c.sources, BASE.sources);
    assert.equal(c.concepts, BASE.concepts);
    assert.equal(c.mocs, BASE.mocs);
    const notes = c.sources + c.concepts + c.mocs;
    assert.ok(within(notes, 840, 0.02), `notes ${notes}`);

    const avg = c.bodyLinks / (notes + c.journal);
    assert.ok(avg >= 6 && avg <= 10, `avg links/note ${avg}`);
    assert.ok(within(c.aliasedConcepts, c.concepts * 0.1, 0.4), `aliased ${c.aliasedConcepts}`);
    assert.ok(within(c.typedSources, c.sources * 0.2, 0.4), `typed ${c.typedSources}`);

    // Zipf: one hub with hundreds of in-links, far above the mean.
    const meanIn = c.bodyLinks / c.concepts;
    assert.ok(r.maxConceptInDegree >= 200, `hub in-degree ${r.maxConceptInDegree}`);
    assert.ok(r.maxConceptInDegree > 20 * meanIn);
    assert.ok(existsSync(join(out, "03 - Concepts", `${r.hubName}.md`)));

    for (const d of EXCLUDED_DIRS) {
      const dir = join(out, d);
      assert.ok(existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".md")), `excluded dir ${d}`);
    }

    const domains = JSON.parse(readFileSync(join(out, ".wiki", "domains.json"), "utf-8")).domains as Record<string, { path: string; scope: string; linkGroup?: string }>;
    const priv = Object.values(domains).filter((d) => d.scope === "private");
    assert.ok(priv.length >= 2);
    assert.ok(priv.some((d) => d.linkGroup));
    for (const d of Object.values(domains)) {
      assert.ok(readdirSync(join(out, d.path)).length > 0, `domain ${d.path} has notes`);
    }

    // Frontmatter shape on a source, typed relation on some source, aliases on some concept.
    const alphaDir = join(out, "02 - Research", "Alpha");
    const src = readFileSync(join(alphaDir, readdirSync(alphaDir).find((f) => f.endsWith(".md"))!), "utf-8");
    for (const key of ["type: source", "title:", "tags:", "created:", "abstraction:", "concepts:", "mocs:"]) {
      assert.ok(src.includes(key), `source frontmatter has ${key}`);
    }
    const config = JSON.parse(readFileSync(join(out, ".wiki", "config.json"), "utf-8"));
    assert.equal(config.structure.concepts, "03 - Concepts");

    // Text is lexicon word-salad only: every lowercase word of a concept body is known.
    const vocab = new Set<string>([...LEXICON, "of", "and", "with", "under", "across", "for", "via", "in"]);
    const concept = readFileSync(join(out, "03 - Concepts", `${r.hubName}.md`), "utf-8");
    const defn = concept.split("## Definition")[1]?.split("##")[0] ?? "";
    for (const w of defn.toLowerCase().match(/[a-z]+/g) ?? []) assert.ok(vocab.has(w), `unexpected word ${w}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
