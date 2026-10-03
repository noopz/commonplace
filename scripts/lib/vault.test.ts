import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findAllNotes } from "./vault.ts";

test("findAllNotes skips underscore-prefixed scaffolding dirs (e.g. _raw/)", async () => {
  const root = mkdtempSync(join(tmpdir(), "vault-discovery-"));
  try {
    mkdirSync(join(root, "02 - Research", "Alpha", "Sub"), { recursive: true });
    mkdirSync(join(root, "02 - Research", "Alpha", "_raw"), { recursive: true });
    mkdirSync(join(root, "_templates"), { recursive: true });
    // A real note and a nested note that must be discovered:
    writeFileSync(join(root, "02 - Research", "Alpha", "Real Note.md"), "---\ntags: [paper]\n---\n# Real Note\n");
    writeFileSync(join(root, "02 - Research", "Alpha", "Sub", "Nested Note.md"), "---\ntags: [note]\n---\n# Nested Note\n");
    // Scaffolding dumps that must NOT be discovered:
    writeFileSync(join(root, "02 - Research", "Alpha", "_raw", "scrape.md"), "raw dump, no frontmatter\n");
    writeFileSync(join(root, "_templates", "template.md"), "a template\n");

    const notes = (await findAllNotes(root)).map((f) => f.slice(root.length + 1));
    assert.ok(notes.includes("02 - Research/Alpha/Real Note.md"), "real note must be found");
    assert.ok(notes.includes("02 - Research/Alpha/Sub/Nested Note.md"), "note in a normal subdir must be found");
    assert.ok(!notes.some((f) => f.includes("/_raw/")), "nothing under _raw/ may be discovered");
    assert.ok(!notes.some((f) => f.includes("_templates/")), "nothing under a top-level _dir may be discovered");
    assert.equal(notes.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
