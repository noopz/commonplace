import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dirname!, "abstract.ts");

const SOURCE_NOTE = `---
tags: [paper]
created: '2026-01-01'
---

# Alpha Source Note

## Summary

This paper introduces a harmonic memory representation that decouples storage from retrieval across layers.

## Notes
Some notes.
`;

const SOURCE_WITH_ABSTRACTION = `---
tags: [paper]
created: '2026-01-01'
abstraction: 'an existing hand-written retrieval key'
---

# Beta Source Note

## Summary

Something derivable but already covered.
`;

const CONCEPT_COMPILED = `---
tags: [concept]
created: '2026-01-01'
---

# Shared Bridge Concept

A memory architecture with separate working and episodic layers.

## Papers Using This Concept
- [[Alpha Source Note]]
`;

const CONCEPT_STUB = `---
tags: [concept]
created: '2026-01-01'
---

# Stub Concept

A concept related to wikilinks. *Definition pending - please update.*
`;

// Non-stub source whose Summary paragraph derives to fewer than 3 content
// words ("too-thin") — a non-stub note that CANNOT be backfilled, distinct
// from a stub (which is intentionally skipped).
const SOURCE_TOO_THIN = `---
tags: [paper]
created: '2026-01-01'
---

# Gamma Source Note

## Summary

Ok so.
`;

const SOURCE_TOO_THIN_FIXED = `---
tags: [paper]
created: '2026-01-01'
---

# Gamma Source Note

## Summary

This paper introduces a lightweight ranking heuristic for sparse retrieval sets.
`;

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "abstract-cli-vault-"));
  mkdirSync(join(root, ".wiki"), { recursive: true });
  writeFileSync(join(root, ".wiki", "config.json"), JSON.stringify({
    structure: { sources: "02 - Research", concepts: "03 - Concepts", mocs: "05 - MOCs" },
    stubPattern: "Definition pending",
    mocCountPattern: "**Papers:** N",
  }, null, 2) + "\n");
  writeFileSync(join(root, ".wiki", "domains.json"), JSON.stringify({
    domains: { alpha: { path: "02 - Research/Alpha", scope: "public" } },
  }, null, 2));
  mkdirSync(join(root, "02 - Research", "Alpha"), { recursive: true });
  mkdirSync(join(root, "03 - Concepts"), { recursive: true });
  writeFileSync(join(root, "02 - Research", "Alpha", "Alpha Source Note.md"), SOURCE_NOTE);
  writeFileSync(join(root, "02 - Research", "Alpha", "Beta Source Note.md"), SOURCE_WITH_ABSTRACTION);
  writeFileSync(join(root, "03 - Concepts", "Shared Bridge Concept.md"), CONCEPT_COMPILED);
  writeFileSync(join(root, "03 - Concepts", "Stub Concept.md"), CONCEPT_STUB);
  return root;
}

function runCli(vault: string, args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", CLI, "--vault", vault, "--json", ...args], {
    encoding: "utf-8",
  });
}

test("dry-run plans writes but touches nothing", () => {
  const vault = makeVault();
  try {
    const out = JSON.parse(runCli(vault, ["--dry-run"]));
    assert.equal(out.dryRun, true);
    assert.equal(out.written, 2); // Alpha source + compiled concept
    assert.equal(out.alreadyPresent, 1);
    assert.deepEqual(out.skipped.map((s: { reason: string }) => s.reason), ["stub"]);
    // Nothing on disk changed:
    assert.equal(readFileSync(join(vault, "02 - Research", "Alpha", "Alpha Source Note.md"), "utf-8"), SOURCE_NOTE);
    const cfg = JSON.parse(readFileSync(join(vault, ".wiki", "config.json"), "utf-8"));
    assert.equal(cfg.abstractions, undefined);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("backfill inserts one line, preserves bytes, sets the vault flag, and is idempotent", () => {
  const vault = makeVault();
  try {
    const out = JSON.parse(runCli(vault, []));
    assert.equal(out.written, 2);

    const alpha = readFileSync(join(vault, "02 - Research", "Alpha", "Alpha Source Note.md"), "utf-8");
    assert.equal(
      alpha,
      SOURCE_NOTE.replace(
        "created: '2026-01-01'\n---",
        "created: '2026-01-01'\nabstraction: 'a harmonic memory representation that decouples storage from retrieval across layers'\n---",
      ),
    );

    // Pre-existing abstraction untouched, stub untouched:
    assert.equal(readFileSync(join(vault, "02 - Research", "Alpha", "Beta Source Note.md"), "utf-8"), SOURCE_WITH_ABSTRACTION);
    assert.equal(readFileSync(join(vault, "03 - Concepts", "Stub Concept.md"), "utf-8"), CONCEPT_STUB);

    const cfg = JSON.parse(readFileSync(join(vault, ".wiki", "config.json"), "utf-8"));
    assert.equal(cfg.abstractions, true);
    assert.equal(cfg.stubPattern, "Definition pending", "existing config keys must survive");

    // Second run: everything already present, nothing written.
    const again = JSON.parse(runCli(vault, []));
    assert.equal(again.written, 0);
    assert.equal(again.alreadyPresent, 3);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("a non-stub note that can't be backfilled withholds the abstractions flag; fixing it and rerunning sets the flag", () => {
  const vault = makeVault();
  const thinPath = join(vault, "02 - Research", "Alpha", "Gamma Source Note.md");
  try {
    writeFileSync(thinPath, SOURCE_TOO_THIN);

    const out = JSON.parse(runCli(vault, []));
    const reasons = out.skipped.map((s: { reason: string }) => s.reason);
    assert.ok(reasons.includes("too-thin"), "Gamma Source Note should be skipped as too-thin");
    assert.ok(out.warning, "a warning should be reported when a non-stub note can't be backfilled");

    const cfg = JSON.parse(readFileSync(join(vault, ".wiki", "config.json"), "utf-8"));
    assert.equal(cfg.abstractions, undefined, "flag must NOT be set while a non-stub note is unbackfillable");

    // Fix the note's content and rerun: the flag should now be set.
    writeFileSync(thinPath, SOURCE_TOO_THIN_FIXED);
    const again = JSON.parse(runCli(vault, []));
    assert.ok(!again.skipped.some((s: { reason: string }) => s.reason === "too-thin"));
    assert.ok(!again.warning);

    const cfg2 = JSON.parse(readFileSync(join(vault, ".wiki", "config.json"), "utf-8"));
    assert.equal(cfg2.abstractions, true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
