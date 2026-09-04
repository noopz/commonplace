import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeFixtureVault, removeFixtureVault } from "./lib/test-fixtures.ts";

const HOOK = join(import.meta.dirname!, "post-write-research.ts");

function runHook(filePath: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", HOOK], {
    input: JSON.stringify({ tool_input: { file_path: filePath } }),
    encoding: "utf-8",
  });
}

test("non-vault file: hook exits silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "not-a-vault-"));
  try {
    assert.equal(runHook(join(dir, "note.md")).trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vault file outside any registered domain: hook exits silently", () => {
  const { vaultRoot } = makeFixtureVault();
  try {
    assert.equal(runHook(join(vaultRoot, "03 - Concepts", "Some Concept.md")).trim(), "");
  } finally {
    removeFixtureVault(vaultRoot);
  }
});

// Gate regression. Under a numbered-folder convention ("02 - Research/...",
// which does NOT contain the substring "/Research/") the old gate exits
// silently and this test FAILS. After the fix, the hook runs the full
// pipeline against the prebuilt indexes and reports the cross-domain
// bridge — with private-domain notes already filtered out (Task 1).
test("registered-domain write surfaces the cross-domain bridge, excluding private notes", () => {
  const { vaultRoot, paths } = makeFixtureVault();
  try {
    const stdout = runHook(paths.alphaNote).trim();
    assert.notEqual(stdout, "", "hook produced no output — gate still blocking?");
    const out = JSON.parse(stdout);
    const ctx: string = out.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("Cross-domain"), "no cross-domain section in additionalContext");
    assert.ok(ctx.includes("Beta Bridge Target"), "bridge target missing");
    assert.ok(!ctx.includes("Gamma Private Note"), "private note leaked into additionalContext");
    assert.ok(
      ctx.includes("mention this to the user directly"),
      "conversational-surfacing instruction missing from additionalContext"
    );
  } finally {
    removeFixtureVault(vaultRoot);
  }
});

test("post-write accepts a PostToolUse payload, not only a flat file_path", () => {
  // As a PostToolUse hook this script received `{tool_input: {file_path}}` and
  // read `data.file_path` only, so it found no path and exited silently on
  // every vault write — validate, index, scope-check and the impact chain
  // never ran. The nested shape is the one the hook actually delivers.
  const root = mkdtempSync(join(tmpdir(), "pw-shape-"));
  try {
    mkdirSync(join(root, "02 - Research", "alpha"), { recursive: true });
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    const note = join(root, "02 - Research", "alpha", "Acme Report.md");
    writeFileSync(note,
      "---\ntitle: Acme Report\ntype: source\ntags: [alpha]\ncreated: 2026-01-01\n---\n" +
      "# Acme Report\n\n## Summary\nA study of the Gamma Term.\n");
    execFileSync(process.execPath,
      ["--import", "tsx", join(import.meta.dirname!, "init.ts"), "--vault", root],
      { encoding: "utf-8" });

    const run = (payload: object) =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", join(import.meta.dirname!, "post-write.ts"), "--vault", root],
        { encoding: "utf-8", input: JSON.stringify(payload),
          env: { ...process.env, COMMONPLACE_HOOK_CHILD: "1" } },
      );

    const nested = run({ tool_input: { file_path: note } });
    assert.match(nested, /sourceWritten/, "the nested hook payload must be understood");
    const flat = run({ file_path: note });
    assert.match(flat, /sourceWritten/, "the flat shape must keep working");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
