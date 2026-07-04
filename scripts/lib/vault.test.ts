import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isCwdInCommonplaceRepo, findAllNotes } from "./vault.ts";

function makeCommonplaceRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "commonplace-repo-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "commonplace" }));
  return root;
}

test("isCwdInCommonplaceRepo is true at the repo root", () => {
  const root = makeCommonplaceRepo();
  try {
    assert.equal(isCwdInCommonplaceRepo(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isCwdInCommonplaceRepo walks up from a subdirectory", () => {
  const root = makeCommonplaceRepo();
  try {
    const sub = join(root, "scripts", "lib");
    mkdirSync(sub, { recursive: true });
    assert.equal(isCwdInCommonplaceRepo(sub), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isCwdInCommonplaceRepo is false for an unrelated directory", () => {
  const root = mkdtempSync(join(tmpdir(), "unrelated-repo-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "some-other-project" }));
    assert.equal(isCwdInCommonplaceRepo(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isCwdInCommonplaceRepo is false with no package.json at all", () => {
  const root = mkdtempSync(join(tmpdir(), "no-pkg-"));
  try {
    assert.equal(isCwdInCommonplaceRepo(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
