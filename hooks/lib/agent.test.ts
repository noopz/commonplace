/**
 * Tests for Agent-dispatch steering.
 *
 * FIXTURES ARE INVENTED. Per CLAUDE.md: this repo is public, so no note title,
 * concept name, domain slug or body text may come from a real vault.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  looksVaultShaped,
  isSteerableSpawn,
  steerPrompt,
  STEER_PREFIX,
  SPAWN_LABELS,
  SPAWN_CLASSIFY_PROMPT,
} from "./agent.ts";

const VAULT = "/Users/someone/Notes";

test("looksVaultShaped catches unambiguous vault vocabulary", () => {
  for (const p of [
    "run wiki-query and report what it finds",
    "use commonplace seed --query alpha",
    "open the obsidian vault and check",
    "update the concept note for Gamma Term",
    "read my notes on the alpha method",
    "fix the links in .wiki/concept-index.jsonl",
    "the note links [[Gamma Term]] twice",
    "search the knowledge base for prior work",
  ]) {
    assert.equal(looksVaultShaped(p, VAULT), true, `should match: ${p}`);
  }
});

test("looksVaultShaped matches a prompt naming the vault directory", () => {
  assert.equal(looksVaultShaped(`audit ${VAULT}/02 - Research`, VAULT), true);
  // Case-insensitively, since a pasted path may not match the registry's case.
  assert.equal(looksVaultShaped(`audit ${VAULT.toLowerCase()}`, VAULT), true);
});

test("looksVaultShaped leaves ordinary dev work alone", () => {
  // These decide whether an unrelated repo's Agent dispatch pays for a model
  // call. A miss here costs nothing; a hit costs ~700ms on every dispatch.
  for (const p of [
    "refactor the auth middleware and add tests",
    "read the HashiCorp Vault config and rotate the token",
    "if [[ -f package.json ]]; then npm ci; fi",
    "summarise the release notes for v2",
    "find every TODO in src/ and group them",
    "",
  ]) {
    assert.equal(looksVaultShaped(p, VAULT), false, `should NOT match: ${p}`);
  }
});

test("looksVaultShaped works with no vault configured", () => {
  assert.equal(looksVaultShaped("check my notes on X", ""), true);
  assert.equal(looksVaultShaped("refactor the parser", ""), false);
});

test("isSteerableSpawn targets the generic worker only", () => {
  assert.equal(isSteerableSpawn("general-purpose", false), true);
  assert.equal(isSteerableSpawn("", false), true);

  // A named agent was chosen deliberately and already knows its job.
  assert.equal(isSteerableSpawn("commonplace:wiki-linter", false), false);
  assert.equal(isSteerableSpawn("code-reviewer", false), false);
  assert.equal(isSteerableSpawn("Explore", false), false);

  // A fork inherits the parent's context; it is not a research dispatch.
  assert.equal(isSteerableSpawn("general-purpose", true), false);
  assert.equal(isSteerableSpawn("fork", true), false);
});

test("steerPrompt prepends once and is idempotent on re-dispatch", () => {
  const task = "Find what the vault says about cohort drift.";
  const once = steerPrompt(task);
  assert.ok(once.startsWith(STEER_PREFIX));
  assert.ok(once.endsWith(task));
  assert.equal(steerPrompt(once), once, "a re-dispatch must not stack prefixes");
});

test("the steer carries the doctrine, not just the tool names", () => {
  // The whole point of steering rather than denying is that the dispatch
  // proceeds correctly equipped. If the prefix only named the tools it would
  // reproduce the RAG failure the vault tools are shaped to prevent.
  assert.match(STEER_PREFIX, /vault_search/);
  assert.match(STEER_PREFIX, /vault_note/);
  assert.match(STEER_PREFIX, /lexical match is not relevance/);
  assert.match(STEER_PREFIX, /wiki-query/);
});

test("the classify prompt offers exactly the labels the caller passes", () => {
  const text = SPAWN_CLASSIFY_PROMPT("do a thing");
  for (const label of SPAWN_LABELS) {
    assert.match(text, new RegExp(label));
  }
  assert.match(text, /do a thing/);
});

test("the classify prompt caps how much of the task it forwards", () => {
  const huge = "x".repeat(5000);
  assert.ok(SPAWN_CLASSIFY_PROMPT(huge).length < 2200);
});
