import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { isExcluded, findNotesArgv } from "./exclude.ts";
import { findAllNotes } from "../../../scripts/lib/vault.ts";

const CASES: Array<[string, boolean]> = [
  ["Alpha Report.md", false],
  ["02 - Research/Alpha/Alpha Report.md", false],
  ["Concepts/Gamma Term.md", false],
  ["_draft.md", false], // only DIRECTORY segments carry the _ rule
  ["alpha/_draft.md", false],
  ["./alpha/Alpha Report.md", false],
  ["alpha\\Alpha Report.md", false],
  [".trash/Alpha Report.md", true],
  [".obsidian/workspace.md", true],
  [".git/info.md", true],
  [".wiki/log.md", true],
  ["alpha/.hidden/Alpha Report.md", true],
  [".hidden.md", true],
  ["alpha/.hidden.md", true],
  ["_raw/dump.md", true],
  ["alpha/_templates/Template.md", true],
  ["alpha/Alpha Figure.png", true],
  ["alpha/Alpha Report.md.bak", true],
  ["alpha/Alpha Report.MD", true], // find -name '*.md' is case-sensitive
  ["", true],
  ["alpha/", true],
];

for (const [path, excluded] of CASES) {
  test(`isExcluded(${JSON.stringify(path)}) === ${excluded}`, () => {
    assert.equal(isExcluded(path), excluded);
  });
}

test("find argv, isExcluded and findAllNotes agree on a real tree under a dot-dir", async () => {
  // The vault root itself sits under a dot-directory: an unanchored
  // `-not -path '*/.*'` would exclude every file.
  const base = mkdtempSync(join(tmpdir(), "cp-exclude-"));
  const root = join(base, ".vaults", "_alpha vault [x]");
  try {
    const files = [
      ...CASES.map(([p]) => p).filter((p) => p && !p.endsWith("/") && !p.includes("\\") && !p.startsWith("./")),
      "gamma/deep/er/Gamma Notes.md",
      "gamma/deep/_scratch/x.md",
      "gamma/deep/.cache/y.md",
    ];
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "# x\n");
    }
    const expected = files.filter((f) => !isExcluded(f)).sort();
    assert.ok(expected.length >= 6);

    const [cmd, ...args] = findNotesArgv(root);
    const out = execFileSync(cmd, args, { encoding: "utf-8" });
    const viaFind = out.split("\n").filter(Boolean).map((p) => relative(root, p)).sort();
    assert.deepEqual(viaFind, expected);

    const viaCli = (await findAllNotes(root)).map((p) => relative(root, p)).sort();
    assert.deepEqual(viaCli, expected);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
