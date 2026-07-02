import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { join } from "path";
import { makeFixtureVault, removeFixtureVault } from "./lib/test-fixtures.ts";

const SCRIPT = join(import.meta.dirname!, "impact.ts");

function runImpact(vaultRoot: string, sourceAbs: string): {
  newSource: string;
  affected: Array<{ path: string; title: string; domain: string; sharedConcepts: string[] }>;
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
