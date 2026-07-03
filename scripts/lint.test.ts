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
