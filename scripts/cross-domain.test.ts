import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { join } from "path";
import { makeFixtureVault, removeFixtureVault } from "./lib/test-fixtures.ts";

const SCRIPT = join(import.meta.dirname!, "cross-domain.ts");

function runCrossDomain(vaultRoot: string, sourceAbs: string): {
  results: Array<{
    source: string;
    domain: string;
    bridgeConcepts: Array<{
      concept: string;
      affectedDomains: string[];
      affectedSources: Array<{ path: string; title: string; domain: string }>;
    }>;
  }>;
} {
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, "--vault", vaultRoot, "--source", sourceAbs],
    { encoding: "utf-8" },
  );
  return JSON.parse(stdout);
}

test("absolute --source matches and finds the cross-domain bridge (baseline: locks in loadIndexes path normalization)", () => {
  const { vaultRoot, paths } = makeFixtureVault();
  try {
    const out = runCrossDomain(vaultRoot, paths.alphaNote);
    assert.equal(out.results.length, 1);
    const affected = out.results[0].bridgeConcepts[0].affectedSources;
    assert.ok(affected.some((s) => s.title === "Beta Bridge Target"));
  } finally {
    removeFixtureVault(vaultRoot);
  }
});

test("private-domain sources are excluded from a public source's results", () => {
  const { vaultRoot, paths } = makeFixtureVault();
  try {
    const out = runCrossDomain(vaultRoot, paths.alphaNote);
    const bridge = out.results[0].bridgeConcepts[0];
    const titles = bridge.affectedSources.map((s) => s.title);
    assert.ok(!titles.includes("Gamma Private Note"), "ungrouped private note leaked");
    assert.ok(!titles.includes("Delta Private Note"), "grouped private note leaked");
    assert.ok(!titles.includes("Epsilon Private Note"), "grouped private note leaked");
    assert.ok(titles.includes("Beta Bridge Target"), "public target wrongly dropped");
  } finally {
    removeFixtureVault(vaultRoot);
  }
});

test("private-domain slugs are excluded from affectedDomains for a public source", () => {
  const { vaultRoot, paths } = makeFixtureVault();
  try {
    const out = runCrossDomain(vaultRoot, paths.alphaNote);
    const domains = out.results[0].bridgeConcepts[0].affectedDomains;
    assert.ok(!domains.includes("gamma"), "private domain slug leaked");
    assert.ok(domains.includes("beta"));
  } finally {
    removeFixtureVault(vaultRoot);
  }
});

test("private source still sees same-linkGroup private notes and public notes, but not other private domains", () => {
  const { vaultRoot, paths } = makeFixtureVault();
  try {
    const out = runCrossDomain(vaultRoot, paths.deltaNote);
    const titles = out.results[0].bridgeConcepts[0].affectedSources.map((s) => s.title);
    assert.ok(titles.includes("Epsilon Private Note"), "same-linkGroup private note wrongly dropped");
    assert.ok(titles.includes("Beta Bridge Target"), "public note wrongly dropped");
    assert.ok(!titles.includes("Gamma Private Note"), "different-group private note leaked");
  } finally {
    removeFixtureVault(vaultRoot);
  }
});
