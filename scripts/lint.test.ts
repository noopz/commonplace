import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dirname!, "lint.ts");

const MOC_FM = "---\ntags: [moc]\ncreated: '2026-01-01'\n---\n";

function mocRecord(name: string, sourceCount: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    name,
    path: `05 - MOCs/${name}.md`,
    domains: ["alpha"],
    sourceCount,
    sources: [],
    declaredCount: null,
    ...extra,
  });
}

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "lint-moc-size-vault-"));
  mkdirSync(join(root, ".wiki"), { recursive: true });
  mkdirSync(join(root, "05 - MOCs"), { recursive: true });
  writeFileSync(join(root, ".wiki", "config.json"), JSON.stringify({
    structure: { sources: "02 - Research", concepts: "03 - Concepts", mocs: "05 - MOCs" },
    stubPattern: "Definition pending",
    mocCountPattern: "**Papers:** N",
    moc: { softCap: 25, hardCap: 40, requireSubsectionsAt: 15 },
  }, null, 2) + "\n");
  writeFileSync(join(root, ".wiki", "domains.json"), JSON.stringify({
    domains: { alpha: { path: "02 - Research/Alpha", scope: "public" } },
  }, null, 2));
  writeFileSync(join(root, ".wiki", "source-index.jsonl"), "");
  writeFileSync(join(root, ".wiki", "concept-index.jsonl"), "");
  writeFileSync(join(root, ".wiki", "moc-index.jsonl"), [
    // Over hard cap, with the aggregator hub/authority profile.
    mocRecord("Sprawling Atlas MOC", 50, { hub: 0.8, authority: 0.01 }),
    // Over soft cap only.
    mocRecord("Growing Compendium MOC", 30),
    // Under both caps but over requireSubsectionsAt; file below has no ###.
    mocRecord("Flat Listing MOC", 18),
    // Comfortably small — must produce no finding.
    mocRecord("Tidy Corner MOC", 5),
  ].join("\n") + "\n");
  // Real files for the MOCs (the subsection branch reads the file).
  writeFileSync(join(root, "05 - MOCs", "Sprawling Atlas MOC.md"),
    `${MOC_FM}\n# Sprawling Atlas MOC\n\n## Papers (50)\n\n### Theme One\n- [[Invented Note]]\n`);
  writeFileSync(join(root, "05 - MOCs", "Growing Compendium MOC.md"),
    `${MOC_FM}\n# Growing Compendium MOC\n\n## Papers (30)\n\n### Theme One\n- [[Invented Note]]\n`);
  writeFileSync(join(root, "05 - MOCs", "Flat Listing MOC.md"),
    `${MOC_FM}\n# Flat Listing MOC\n\n## Papers (18)\n\n- [[Invented Note]]\n- [[Another Invented Note]]\n`);
  writeFileSync(join(root, "05 - MOCs", "Tidy Corner MOC.md"),
    `${MOC_FM}\n# Tidy Corner MOC\n\n## Papers (5)\n\n- [[Invented Note]]\n`);
  writeFileSync(join(root, ".wiki", ".last-index"), String(Date.now() + 3_600_000));
  return root;
}

interface Finding { check: string; severity: string; file: string; message: string }

function runMocSize(vault: string): Finding[] {
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", CLI, "--vault", vault, "--check", "moc-size", "--json"],
    { encoding: "utf-8" },
  );
  const out = JSON.parse(stdout);
  return [...out.critical, ...out.improvement, ...out.suggestion];
}

test("moc-size: hard cap, soft cap, missing subsections, and clean MOC", () => {
  const vault = makeVault();
  try {
    const findings = runMocSize(vault);
    const byName = (needle: string) => findings.filter((f) => f.message.includes(needle));

    const hard = byName("Sprawling Atlas MOC");
    assert.equal(hard.length, 1);
    assert.equal(hard[0].severity, "critical");
    assert.match(hard[0].message, /over the hard cap of 40/);
    assert.match(hard[0].message, /administrative aggregator/);

    const soft = byName("Growing Compendium MOC");
    assert.equal(soft.length, 1);
    assert.equal(soft[0].severity, "improvement");
    assert.match(soft[0].message, /over the soft cap of 25/);
    assert.doesNotMatch(soft[0].message, /aggregator/);

    const flat = byName("Flat Listing MOC");
    assert.equal(flat.length, 1);
    assert.match(flat[0].message, /no ### subsections/);

    assert.equal(byName("Tidy Corner MOC").length, 0);
    assert.equal(findings.length, 3);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("moc-size: caps are configurable per vault", () => {
  const vault = makeVault();
  try {
    // Raise the caps so only the 50-source MOC trips, and only at soft level.
    writeFileSync(join(vault, ".wiki", "config.json"), JSON.stringify({
      structure: { sources: "02 - Research", concepts: "03 - Concepts", mocs: "05 - MOCs" },
      stubPattern: "Definition pending",
      mocCountPattern: "**Papers:** N",
      moc: { softCap: 45, hardCap: 100, requireSubsectionsAt: 45 },
    }, null, 2) + "\n");
    const findings = runMocSize(vault);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "improvement");
    assert.match(findings[0].message, /Sprawling Atlas MOC.*over the soft cap of 45/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

function dupSourceRecord(
  title: string,
  abstraction: string | null,
  buildsOn: string[] = [],
) {
  return JSON.stringify({
    title,
    path: `02 - Research/Alpha/${title}.md`,
    domain: "alpha",
    scope: "public",
    tags: ["paper"],
    concepts: [],
    mocs: [],
    buildsOn,
    comparesWith: [],
    usesMethod: [],
    ...(abstraction ? { abstraction } : {}),
  });
}

function makeDupVault(): string {
  const root = mkdtempSync(join(tmpdir(), "lint-near-dup-content-vault-"));
  mkdirSync(join(root, ".wiki"), { recursive: true });
  writeFileSync(join(root, ".wiki", "config.json"), JSON.stringify({
    structure: { sources: "02 - Research", concepts: "03 - Concepts", mocs: "05 - MOCs" },
    stubPattern: "Definition pending",
    mocCountPattern: "**Papers:** N",
  }, null, 2) + "\n");
  writeFileSync(join(root, ".wiki", "domains.json"), JSON.stringify({
    domains: { alpha: { path: "02 - Research/Alpha", scope: "public" } },
  }, null, 2));
  writeFileSync(join(root, ".wiki", "source-index.jsonl"), [
    dupSourceRecord("Fresh Consolidation Study", "consolidating overlapping memories into single canonical entry"),
    dupSourceRecord("Near Twin Report", "consolidating overlapping memories into one canonical entry"),
    dupSourceRecord("Distant Ranking Study", "ranking exploration frontiers by authority signals"),
    // Near-dup pair that is ALREADY linked via builds_on — must be suppressed.
    dupSourceRecord("Anchor Methods Primer", "latent anchor construction methods for memory indexing"),
    dupSourceRecord("Anchor Methods Sequel", "latent anchor construction methods for memory indexes", ["[[Anchor Methods Primer]]"]),
  ].join("\n") + "\n");
  writeFileSync(join(root, ".wiki", "concept-index.jsonl"), "");
  writeFileSync(join(root, ".wiki", "moc-index.jsonl"), "");
  writeFileSync(join(root, ".wiki", ".last-index"), String(Date.now() + 3_600_000));
  return root;
}

test("moc-size: default caps are 20 soft / 25 hard / 10 subsections when no moc config block", () => {
  const root = mkdtempSync(join(tmpdir(), "lint-moc-defaults-vault-"));
  try {
    mkdirSync(join(root, ".wiki"), { recursive: true });
    mkdirSync(join(root, "05 - MOCs"), { recursive: true });
    // No `moc` block — the check must fall back to the shipped defaults.
    writeFileSync(join(root, ".wiki", "config.json"), JSON.stringify({
      structure: { sources: "02 - Research", concepts: "03 - Concepts", mocs: "05 - MOCs" },
      stubPattern: "Definition pending",
      mocCountPattern: "**Papers:** N",
    }, null, 2) + "\n");
    writeFileSync(join(root, ".wiki", "domains.json"), JSON.stringify({
      domains: { alpha: { path: "02 - Research/Alpha", scope: "public" } },
    }, null, 2));
    writeFileSync(join(root, ".wiki", "source-index.jsonl"), "");
    writeFileSync(join(root, ".wiki", "concept-index.jsonl"), "");
    writeFileSync(join(root, ".wiki", "moc-index.jsonl"), [
      mocRecord("Over Soft MOC", 22),   // 20 < 22 <= 25 → soft only
      mocRecord("Over Hard MOC", 26),   // 26 > 25 → hard
      mocRecord("Needs Sections MOC", 12), // 10 < 12 < 20, no ### → subsections
      mocRecord("Small MOC", 8),        // < 10 → clean
    ].join("\n") + "\n");
    writeFileSync(join(root, "05 - MOCs", "Over Soft MOC.md"),
      `${MOC_FM}\n# Over Soft MOC\n\n## Papers (22)\n\n### Theme\n- [[Invented Note]]\n`);
    writeFileSync(join(root, "05 - MOCs", "Over Hard MOC.md"),
      `${MOC_FM}\n# Over Hard MOC\n\n## Papers (26)\n\n### Theme\n- [[Invented Note]]\n`);
    writeFileSync(join(root, "05 - MOCs", "Needs Sections MOC.md"),
      `${MOC_FM}\n# Needs Sections MOC\n\n## Papers (12)\n\n- [[Invented Note]]\n`);
    writeFileSync(join(root, "05 - MOCs", "Small MOC.md"),
      `${MOC_FM}\n# Small MOC\n\n## Papers (8)\n\n- [[Invented Note]]\n`);
    writeFileSync(join(root, ".wiki", ".last-index"), String(Date.now() + 3_600_000));

    const findings = runMocSize(root);
    const byName = (needle: string) => findings.filter((f) => f.message.includes(needle));

    const soft = byName("Over Soft MOC");
    assert.equal(soft.length, 1);
    assert.equal(soft[0].severity, "improvement");
    assert.match(soft[0].message, /over the soft cap of 20/);

    const hard = byName("Over Hard MOC");
    assert.equal(hard.length, 1);
    assert.equal(hard[0].severity, "critical");
    assert.match(hard[0].message, /over the hard cap of 25/);

    const sections = byName("Needs Sections MOC");
    assert.equal(sections.length, 1);
    assert.match(sections[0].message, /no ### subsections/);

    assert.equal(byName("Small MOC").length, 0);
    assert.equal(findings.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("near-duplicate-content: flags abstraction twins, skips linked pairs and distant pairs", () => {
  const vault = makeDupVault();
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", CLI, "--vault", vault, "--check", "near-duplicate-content", "--json"],
      { encoding: "utf-8" },
    );
    const out = JSON.parse(stdout);
    const findings = [...out.critical, ...out.improvement, ...out.suggestion];
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "suggestion");
    assert.match(findings[0].message, /"Fresh Consolidation Study" and "Near Twin Report"/);
    assert.match(findings[0].message, /similarity 0\.71/);
    assert.match(findings[0].suggestion ?? "", /never merge/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
