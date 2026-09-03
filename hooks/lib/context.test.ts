/**
 * Tests for the pure `prompt.context` helpers.
 *
 * FIXTURES ARE INVENTED. This repo is public: no vault path, note title,
 * concept name, domain slug, or genre name below comes from a real vault.
 * `/tmp/example-vault`, `Alpha Method`, domains `alpha`/`gamma` are placeholders.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VAULT_BLOCK_NAME,
  buildVaultBlock,
  mergeBlocks,
  vaultIntent,
  type ContextBlock,
  type VaultFacts,
} from "./context.ts";

const VAULT = "/tmp/example-vault";

function facts(over: Partial<VaultFacts> = {}): VaultFacts {
  return {
    vaultPath: VAULT,
    inVault: true,
    sources: 12,
    concepts: 34,
    mocs: 5,
    untunedGenres: [],
    ...over,
  };
}

const CORE: readonly ContextBlock[] = [
  { name: "claudeMd", text: "# project instructions" },
  { name: "userEmail", text: "user@example.com" },
  { name: "attachedProject", text: "/tmp/example-project" },
  { name: "currentDate", text: "2026-01-01" },
];

// --- buildVaultBlock: null cases -------------------------------------------

test("buildVaultBlock returns null when no vault is configured", () => {
  assert.equal(buildVaultBlock(facts({ vaultPath: null })), null);
  assert.equal(buildVaultBlock(facts({ vaultPath: null, inVault: false })), null);
});

test("buildVaultBlock returns null for an in-vault session on an empty vault", () => {
  assert.equal(buildVaultBlock(facts({ sources: 0 })), null);
});

test("buildVaultBlock still nudges outside the vault even when counts are zero", () => {
  // The outside-vault tier does not depend on index contents, matching the
  // old hook which emitted the nudge before counting anything.
  const b = buildVaultBlock(facts({ inVault: false, sources: 0, concepts: 0, mocs: 0 }));
  assert.ok(b);
  assert.equal(b.name, VAULT_BLOCK_NAME);
});

// --- buildVaultBlock: outside-vault tier -----------------------------------

test("outside the vault: one short paragraph naming the path and the two skills", () => {
  const b = buildVaultBlock(facts({ inVault: false }));
  assert.ok(b);
  assert.ok(b.text.includes(VAULT));
  assert.ok(b.text.includes("wiki-query"));
  assert.ok(b.text.includes("wiki-ingest"));
  // No snapshot content leaks into the nudge.
  assert.ok(!b.text.includes("source-index.jsonl"));
  assert.ok(!b.text.includes("12 sources"));
  assert.ok(b.text.split(/\s+/).length < 80);
});

// --- buildVaultBlock: in-vault tier ----------------------------------------

test("inside the vault: briefing carries path, counts, index shapes, and toolchain facts", () => {
  const b = buildVaultBlock(facts());
  assert.ok(b);
  assert.equal(b.name, VAULT_BLOCK_NAME);
  assert.ok(b.text.includes(`${VAULT}/.wiki/`));
  assert.ok(b.text.includes("12 sources, 34 concepts, 5 MOCs"));
  for (const idx of ["source-index.jsonl", "concept-index.jsonl", "moc-index.jsonl", "domain-index.jsonl"]) {
    assert.ok(b.text.includes(idx), `missing ${idx}`);
  }
  assert.ok(b.text.includes("paper:*"));
  assert.ok(b.text.includes("raw/"));
  assert.ok(b.text.includes("wiki-query"));
});

test("inside the vault: well under the old ~800 words", () => {
  const b = buildVaultBlock(facts({ untunedGenres: ["alpha-report", "gamma-memo"] }));
  assert.ok(b);
  const words = b.text.split(/\s+/).length;
  assert.ok(words < 300, `block is ${words} words`);
});

test("inside the vault: untuned genres appear only when present", () => {
  const without = buildVaultBlock(facts());
  const withG = buildVaultBlock(facts({ untunedGenres: ["alpha-report", "gamma-memo"] }));
  assert.ok(without && withG);
  assert.ok(!without.text.includes("conventions rules"));
  assert.ok(withG.text.includes("2 genre(s)"));
  assert.ok(withG.text.includes("alpha-report, gamma-memo"));
  assert.ok(withG.text.includes("wiki-conventions-tuner"));
});

// --- mergeBlocks -----------------------------------------------------------

test("mergeBlocks appends ours after every core block, preserving order", () => {
  const ours = { name: VAULT_BLOCK_NAME, text: "vault" };
  const out = mergeBlocks(CORE, ours);
  assert.deepEqual(out.map((b) => b.name), [...CORE.map((b) => b.name), VAULT_BLOCK_NAME]);
  assert.deepEqual(out.slice(0, CORE.length), CORE);
});

test("mergeBlocks is idempotent", () => {
  const ours = { name: VAULT_BLOCK_NAME, text: "vault" };
  const once = mergeBlocks(CORE, ours);
  const twice = mergeBlocks(once, ours);
  assert.deepEqual(twice, once);
  assert.equal(twice.filter((b) => b.name === VAULT_BLOCK_NAME).length, 1);
});

test("mergeBlocks replaces an existing copy in place rather than stacking", () => {
  const stale = { name: VAULT_BLOCK_NAME, text: "old" };
  const fresh = { name: VAULT_BLOCK_NAME, text: "new" };
  const list = [CORE[0], stale, CORE[1], CORE[2], CORE[3]];
  const out = mergeBlocks(list, fresh);
  assert.deepEqual(out.map((b) => b.name), list.map((b) => b.name));
  assert.equal(out[1].text, "new");
});

test("mergeBlocks collapses duplicate copies of ours but never drops a core block", () => {
  const dup = { name: VAULT_BLOCK_NAME, text: "dup" };
  const list = [dup, ...CORE, dup];
  const out = mergeBlocks(list, { name: VAULT_BLOCK_NAME, text: "new" });
  assert.equal(out.filter((b) => b.name === VAULT_BLOCK_NAME).length, 1);
  for (const c of CORE) assert.ok(out.some((b) => b.name === c.name && b.text === c.text));
});

test("mergeBlocks with null removes only ours and leaves core blocks intact", () => {
  const list = [...CORE, { name: VAULT_BLOCK_NAME, text: "vault" }];
  assert.deepEqual(mergeBlocks(list, null), CORE);
  assert.deepEqual(mergeBlocks(CORE, null), CORE);
});

test("mergeBlocks does not mutate its input", () => {
  const list = [...CORE];
  const snapshot = list.map((b) => ({ ...b }));
  mergeBlocks(list, { name: VAULT_BLOCK_NAME, text: "vault" });
  assert.deepEqual(list, snapshot);
});

// --- vaultIntent: positives ------------------------------------------------

test("vaultIntent: wiki-* skill names, CLI subcommands, obsidian vault, note kinds", () => {
  assert.ok(vaultIntent("run wiki-query on this", []));
  assert.ok(vaultIntent("please commonplace lint the vault", []));
  assert.ok(vaultIntent("commonplace paper:fetch 1234.5678", []));
  assert.ok(vaultIntent("open my obsidian vault", []));
  assert.ok(vaultIntent("write a concept note for Alpha Method", []));
  assert.ok(vaultIntent("what do my notes say about gamma?", []));
  assert.ok(vaultIntent("look in .wiki/concept-index.jsonl", []));
  assert.ok(vaultIntent("look in .wiki\\concept-index.jsonl", []));
  assert.ok(vaultIntent("see [[Alpha Method]]", []));
});

test("vaultIntent: a registered vault path matches, separator- and case-insensitively", () => {
  assert.ok(vaultIntent(`edit ${VAULT}/notes/alpha.md`, [VAULT]));
  assert.ok(vaultIntent("edit /TMP/Example-Vault/notes/alpha.md", [VAULT]));
  assert.ok(vaultIntent("edit \\tmp\\example-vault\\notes\\alpha.md", [VAULT]));
  assert.ok(!vaultIntent(`edit ${VAULT}/notes/alpha.md`, []));
  assert.ok(!vaultIntent(`edit ${VAULT}/notes/alpha.md`, [""]));
});

// --- vaultIntent: deliberate non-matches -----------------------------------

test("vaultIntent: bash [[ -f x ]] is not a wikilink", () => {
  assert.ok(!vaultIntent("if [[ -f config.json ]]; then echo ok; fi", []));
  assert.ok(!vaultIntent("[[ $x == y ]] && run", []));
});

test("vaultIntent: HashiCorp-style 'vault' is not the notes vault", () => {
  assert.ok(!vaultIntent("rotate the secret in vault", []));
  assert.ok(!vaultIntent("my vault token expired", []));
  assert.ok(!vaultIntent("the vault agent sidecar is failing", []));
});

test("vaultIntent: bare 'commonplace' without a known subcommand does not match", () => {
  assert.ok(!vaultIntent("refactor the commonplace plugin", []));
  assert.ok(!vaultIntent("commonplace is a nice word", []));
  assert.ok(!vaultIntent("commonplace build", []));
});

test("vaultIntent: bare 'MOC' and generic notes phrasing do not match", () => {
  assert.ok(!vaultIntent("update the MOC", []));
  assert.ok(!vaultIntent("take notes on this meeting", []));
  assert.ok(!vaultIntent("", []));
});
