import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sourceRefs } from "./artifact.ts";

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "cp-art-"));
  for (const f of ["raw/Alpha Report.pdf", "Meta Shelf/raw/Gamma Memo.pdf", "Meta Shelf/raw/Kestrel Brief.md"]) {
    mkdirSync(join(v, f, ".."), { recursive: true });
    writeFileSync(join(v, f), "x");
  }
  return v;
}

test("sourceRefs finds captured files in any raw/ folder, by link or by Original PDF line", () => {
  const v = vault();
  const note = [
    "# Gamma Memo",
    "Archive: ![[raw/Alpha Report.pdf]] and [[Meta Shelf/raw/Gamma Memo.pdf|the memo]].",
    "**Original PDF:** [[Kestrel Brief.md]]",
    "**URL:** https://example.com/gamma",
  ].join("\n");
  const refs = sourceRefs(v, note);
  assert.deepEqual(
    refs.map((r) => (r.kind === "file" ? r.ref.slice(v.length + 1) : r.ref)),
    ["raw/Alpha Report.pdf", "Meta Shelf/raw/Gamma Memo.pdf", "Meta Shelf/raw/Kestrel Brief.md", "https://example.com/gamma"],
  );
});

test("sourceRefs ignores raw links that leave the vault or do not exist", () => {
  const v = vault();
  assert.deepEqual(sourceRefs(v, "[[../raw/Alpha Report.pdf]] [[raw/Missing.pdf]] **Original PDF:** Nowhere.pdf"), []);
});

test("sourceRefs resolves a raw/ link from the note's own folder, however deep", () => {
  const v = vault();
  mkdirSync(join(v, "Shelf/Inner/raw"), { recursive: true });
  writeFileSync(join(v, "Shelf/Inner/raw/Delta Notes.md"), "delta");
  const refs = sourceRefs(v, "**Original:** ![[raw/Delta Notes.md]]", "Shelf/Inner/Delta.md");
  assert.deepEqual(refs.map((r) => r.ref.slice(v.length + 1)), ["Shelf/Inner/raw/Delta Notes.md"]);
  assert.deepEqual(sourceRefs(v, "**Original:** ![[raw/Delta Notes.md]]"), [], "without the note's folder it is not found");
});
