import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dirname!, "seed.ts");

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "seed-cli-vault-"));
  mkdirSync(join(root, ".wiki"), { recursive: true });
  writeFileSync(join(root, ".wiki", "source-index.jsonl"), [
    JSON.stringify({
      title: "Harmonic Retrieval Survey",
      path: "02 - Research/Alpha/Harmonic Retrieval Survey.md",
      domain: "alpha", scope: "public", tags: ["survey"],
      concepts: ["Query Seeding"], mocs: [], buildsOn: [], comparesWith: [], usesMethod: [],
      abstraction: "seeding and traversal strategies for finding related notes",
      anchors: ["Query Seeding"],
    }),
  ].join("\n") + "\n");
  writeFileSync(join(root, ".wiki", "concept-index.jsonl"), JSON.stringify({
    name: "Query Seeding", path: "03 - Concepts/Query Seeding.md",
    domains: ["alpha"], backlinkCount: 1, isStub: false,
  }) + "\n");
  writeFileSync(join(root, ".wiki", "moc-index.jsonl"), "");
  return root;
}

function run(vault: string, args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", CLI, "--vault", vault, ...args], {
    encoding: "utf-8",
  });
}

test("tiered seed surfaces an abstraction match at Tier A with vault-relative path", () => {
  const vault = makeVault();
  try {
    const out = JSON.parse(run(vault, ["--query", "traversal strategies for notes", "--json"]));
    assert.equal(out.mode, "tiered");
    const hit = out.hits.find((h: { label: string }) => h.label === "Harmonic Retrieval Survey");
    assert.ok(hit, "survey should seed");
    assert.equal(hit.tier, "A");
    assert.equal(hit.path, "02 - Research/Alpha/Harmonic Retrieval Survey.md");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("--no-abstraction ablates Tier A (falls through to anchors or nothing)", () => {
  const vault = makeVault();
  try {
    const out = JSON.parse(run(vault, ["--query", "traversal strategies", "--json", "--no-abstraction"]));
    assert.equal(out.hits.filter((h: { tier: string }) => h.tier === "A").length, 0);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("missing --query and bad --mode fail loudly", () => {
  const vault = makeVault();
  try {
    assert.throws(() => run(vault, ["--json"]));
    assert.throws(() => run(vault, ["--query", "x", "--mode", "vector"]));
    assert.throws(() => run(vault, ["--query", "x", "--mode", "flat", "--no-abstraction"]));
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
