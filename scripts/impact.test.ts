import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { join } from "path";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { makeFixtureVault, removeFixtureVault } from "./lib/test-fixtures.ts";

const SCRIPT = join(import.meta.dirname!, "impact.ts");

function runImpact(vaultRoot: string, sourceAbs: string): {
  newSource: string;
  affected: Array<{ path: string; title: string; domain: string; sharedConcepts: string[] }>;
  consolidation: Array<{ path: string; title: string; similarity: number }>;
} {
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, "--vault", vaultRoot, "--source", sourceAbs],
    { encoding: "utf-8" },
  );
  return JSON.parse(stdout);
}

test("public source sees public affected notes sharing 2+ concepts", () => {
  const { vaultRoot, paths } = makeFixtureVault();
  try {
    const out = runImpact(vaultRoot, paths.alphaNote);
    const titles = out.affected.map((a) => a.title);
    assert.ok(titles.includes("Beta Bridge Target"), "public note with 2+ shared concepts wrongly dropped");
  } finally {
    removeFixtureVault(vaultRoot);
  }
});

test("private-domain note is excluded from a public source's affected list even with 2+ shared concepts", () => {
  const { vaultRoot, paths } = makeFixtureVault();
  try {
    const out = runImpact(vaultRoot, paths.alphaNote);
    const titles = out.affected.map((a) => a.title);
    assert.ok(
      !titles.includes("Gamma Private Note"),
      "private note leaked into public source's affected list despite sharing 2+ concepts",
    );
  } finally {
    removeFixtureVault(vaultRoot);
  }
});

test("private source sees only same-linkGroup private notes; public notes excluded because write-back would leak a private title", () => {
  const { vaultRoot, paths } = makeFixtureVault();
  try {
    const out = runImpact(vaultRoot, paths.gammaNote);
    const titles = out.affected.map((a) => a.title);
    assert.ok(
      !titles.includes("Alpha Source Note"),
      "public note wrongly included — writing [[Gamma Private Note]] into it would leak a private title",
    );
  } finally {
    removeFixtureVault(vaultRoot);
  }
});

function srcRecord(title: string, abstraction: string | null, domain = "alpha") {
  return JSON.stringify({
    title,
    path: `02 - Research/Alpha/${title}.md`,
    domain,
    scope: "public",
    tags: ["paper"],
    concepts: ["[[Shared Bridge Concept]]"],
    mocs: [],
    buildsOn: [],
    comparesWith: [],
    usesMethod: [],
    ...(abstraction ? { abstraction } : {}),
  });
}

function makeConsolidationVault(): string {
  const root = mkdtempSync(join(tmpdir(), "impact-consolidation-vault-"));
  mkdirSync(join(root, ".wiki"), { recursive: true });
  writeFileSync(join(root, ".wiki", "domains.json"), JSON.stringify({
    domains: { alpha: { path: "02 - Research/Alpha", scope: "public" } },
  }, null, 2));
  writeFileSync(join(root, ".wiki", "source-index.jsonl"), [
    srcRecord("Fresh Consolidation Study", "consolidating overlapping memories into single canonical entry"),
    srcRecord("Near Twin Report", "consolidating overlapping memories into one canonical entry"),
    srcRecord("Distant Ranking Study", "ranking exploration frontiers by authority signals"),
    srcRecord("No Abstraction Note", null),
  ].join("\n") + "\n");
  writeFileSync(join(root, ".wiki", "concept-index.jsonl"), "");
  writeFileSync(join(root, ".wiki", "moc-index.jsonl"), "");
  writeFileSync(join(root, ".wiki", ".last-index"), String(Date.now() + 3_600_000));
  return root;
}

test("consolidation candidates: abstraction near-twin flagged, distant and abstraction-less sources not", () => {
  const root = makeConsolidationVault();
  try {
    const out = runImpact(root, join(root, "02 - Research/Alpha/Fresh Consolidation Study.md"));
    assert.deepEqual(out.consolidation.map((c) => c.title), ["Near Twin Report"]);
    assert.ok(out.consolidation[0].similarity >= 0.5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing impact output still carries consolidation key (empty without abstractions)", () => {
  const { vaultRoot, paths } = makeFixtureVault();
  try {
    const out = runImpact(vaultRoot, paths.alphaNote);
    assert.deepEqual(out.consolidation, []);
  } finally {
    removeFixtureVault(vaultRoot);
  }
});
