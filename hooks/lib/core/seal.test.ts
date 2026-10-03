/**
 * Sealing guard — plan §4.5 tests 21-25 on an invented vault layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSealedAccess, normalizePath, shellWords, SEALED_DENY, PROTECTED_DENY } from "./seal.ts";

const V = "/vaults/acme";
const GAMMA = `${V}/04 - Explorations/Gamma`;
const roots = {
  sealed: [GAMMA, `${V}/.wiki/sealed`],
  protectedWrite: [`${V}/.wiki/skills`, `${V}/.wiki/agents`],
};
const check = (tool: string, input: Record<string, unknown>, cwd = "/repos/app") =>
  checkSealedAccess(tool, input, roots, cwd, "/home/u");

test("21: Read under a sealed folder is denied; once open (not in roots) allowed", () => {
  assert.deepEqual(check("Read", { file_path: `${GAMMA}/Gamma Term.md` }), { deny: SEALED_DENY });
  assert.equal(checkSealedAccess("Read", { file_path: `${GAMMA}/Gamma Term.md` }, { sealed: [], protectedWrite: [] }, "/"), null);
  assert.equal(check("Read", { file_path: `${V}/02 - Research/Alpha/Alpha Report.md` }), null);
  // .. tricks are normalised away
  assert.deepEqual(check("Read", { file_path: `${V}/02 - Research/../04 - Explorations/Gamma/x.md` }), { deny: SEALED_DENY });
  // prefix sibling is not inside
  assert.equal(check("Read", { file_path: `${V}/04 - Explorations/Gamma2/x.md` }), null);
});

test("22: Grep/Glob over an ancestor of a sealed root is denied; a public folder is fine", () => {
  assert.deepEqual(check("Grep", { pattern: "x", path: V }), { deny: SEALED_DENY });
  assert.deepEqual(check("Grep", { pattern: "x", path: `${V}/.wiki` }), { deny: SEALED_DENY });
  assert.equal(check("Grep", { pattern: "x", path: `${V}/02 - Research/Alpha` }), null);
  assert.deepEqual(check("Grep", { pattern: "x" }, V), { deny: SEALED_DENY }, "no path = cwd = vault root");
  assert.deepEqual(check("Glob", { pattern: `${V}/**/*.md` }), { deny: SEALED_DENY });
  assert.equal(check("Glob", { pattern: "**/*.ts" }), null, "unrelated repo");
  assert.deepEqual(check("Read", { file_path: `${V}/.wiki/sealed/names.json` }), { deny: SEALED_DENY });
  assert.equal(check("Read", { file_path: `${V}/.wiki/graph/manifest.json` }), null);
});

test("23: Bash recursive scans and direct reads of sealed paths are denied", () => {
  assert.deepEqual(check("Bash", { command: `grep -r term "${V}"` }), { deny: SEALED_DENY });
  assert.deepEqual(check("Bash", { command: `rg term ${V.replace("/acme", "/acme/")}` }), { deny: SEALED_DENY });
  assert.deepEqual(check("Bash", { command: `cat "${V}/.wiki/sealed/legacy/concept-index.private.jsonl"` }), { deny: SEALED_DENY });
  assert.deepEqual(check("Bash", { command: `ls '${GAMMA}'` }), { deny: SEALED_DENY });
  assert.deepEqual(check("Bash", { command: `cat ${V}/*/Gamma/*.md` }), { deny: SEALED_DENY }, "glob rooted above sealed");
  assert.deepEqual(check("Bash", { command: `find .` }, V), { deny: SEALED_DENY });
  assert.deepEqual(check("Bash", { command: `echo hi && grep -rn x` }, V), { deny: SEALED_DENY });
  // Non-recursive reads of public files and anything in an unrelated repo pass.
  assert.equal(check("Bash", { command: `cat "${V}/02 - Research/Alpha/Alpha Report.md"` }), null);
  assert.equal(check("Bash", { command: `ls ${V}` }), null, "a non-recursive ls of the root lists names only");
  assert.equal(check("Bash", { command: "grep -rn TODO src/ && npm test" }), null);
  assert.equal(check("Bash", { command: "git log --oneline | head -5" }), null);
});

test("24: model writes into vault skills/agents are denied; sealed edits too", () => {
  assert.deepEqual(check("Write", { file_path: `${V}/.wiki/skills/alpha/SKILL.md`, content: "x" }), { deny: PROTECTED_DENY });
  assert.deepEqual(check("Edit", { file_path: `${V}/.wiki/agents/beta.md` }), { deny: PROTECTED_DENY });
  assert.equal(check("Read", { file_path: `${V}/.wiki/skills/alpha/SKILL.md` }), null, "reading is fine");
  assert.deepEqual(check("Edit", { file_path: `${GAMMA}/Gamma Term.md` }), { deny: SEALED_DENY });
});

test("deny text never names the sealed domain", () => {
  const v = check("Read", { file_path: `${GAMMA}/Gamma Term.md` });
  assert.doesNotMatch(v!.deny, /gamma/i);
});

test("helpers: path normalisation and shell word split", () => {
  assert.equal(normalizePath("~/x/../y", "/c", "/home/u"), "/home/u/y");
  assert.equal(normalizePath("a/./b//", "/c"), "/c/a/b");
  assert.deepEqual(shellWords(`grep -r "a b" 'c d' e\\ f;ls`), ["grep", "-r", "a b", "c d", "e f", ";", "ls"]);
});
