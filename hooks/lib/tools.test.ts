/**
 * Tests for the registered vault tools.
 *
 * FIXTURES ARE INVENTED. Per CLAUDE.md: this repo is public, so no note title,
 * concept name, domain slug or body text may come from a real vault.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VAULT_SEARCH_SPEC,
  VAULT_NOTE_SPEC,
  searchVault,
  formatSearchResult,
  resolveNotePath,
  isSafeVaultPath,
} from "./tools.ts";

const RECORDS: Record<string, unknown>[] = [
  {
    title: "Alpha Calibration Drift",
    path: "02 - Research/alpha/Alpha Calibration Drift.md",
    domain: "alpha",
    scope: "public",
    abstraction: "how calibration drifts across gamma cohorts over time",
    anchors: ["cohort drift"],
    authority: 0.4,
  },
  {
    name: "Gamma Term",
    path: "03 - Concepts/Gamma Term.md",
    domains: ["gamma"],
    abstraction: "a gamma cohort weighting term",
    anchors: [],
    authority: 0.9,
  },
  {
    title: "Private Calibration Log",
    path: "04 - Explorations/private/Private Calibration Log.md",
    domain: "delta",
    scope: "private",
    abstraction: "personal calibration measurements",
    anchors: [],
    authority: 0.2,
  },
  {
    title: "Retired Calibration Rig",
    path: "02 - Research/alpha/Retired Calibration Rig.md",
    domain: "alpha",
    scope: "public",
    tags: ["retired"],
    abstraction: "a superseded calibration rig",
    anchors: [],
    authority: 0.1,
  },
  {
    name: "Stub Calibration Idea",
    path: "03 - Concepts/Stub Calibration Idea.md",
    domains: ["alpha"],
    isStub: true,
    abstraction: "calibration placeholder",
    anchors: [],
    authority: 0.0,
  },
];

test("tool specs declare required inputs the model must supply", () => {
  assert.equal(VAULT_SEARCH_SPEC.name, "vault_search");
  assert.deepEqual(VAULT_SEARCH_SPEC.inputSchema.required, ["query"]);
  assert.equal(VAULT_NOTE_SPEC.name, "vault_note");
  assert.deepEqual(VAULT_NOTE_SPEC.inputSchema.required, ["note"]);
});

test("vault_search's description forbids answering from pointers alone", () => {
  // The doctrine has to survive in the text the model actually reads.
  assert.match(VAULT_SEARCH_SPEC.description, /POINTERS ONLY/);
  assert.match(VAULT_SEARCH_SPEC.description, /never note bodies/i);
  assert.match(VAULT_NOTE_SPEC.description, /do not answer from vault_search results/i);
});

test("searchVault returns pointers and never a note body", () => {
  const hits = searchVault(RECORDS, "calibration drift in gamma cohorts");
  assert.ok(hits.length > 0);
  for (const hit of hits) {
    assert.ok(hit.title && hit.path);
    // The structural guarantee: no field carries note content.
    assert.ok(!("content" in hit), "a search hit must never carry a body");
    assert.ok(!("body" in hit));
  }
});

test("searchVault flags private, retired, and stub notes rather than hiding them", () => {
  const hits = searchVault(RECORDS, "calibration");
  const byTitle = Object.fromEntries(hits.map((h) => [h.title, h]));

  assert.match(byTitle["Private Calibration Log"].caution, /private/);
  assert.match(byTitle["Retired Calibration Rig"].caution, /retired/);
  assert.match(byTitle["Stub Calibration Idea"].caution, /stub/);
  // A plain note carries no caution at all.
  assert.equal(byTitle["Alpha Calibration Drift"].caution, undefined);
});

test("the private caution warns against copying into public artefacts", () => {
  const hits = searchVault(RECORDS, "calibration");
  const priv = hits.find((h) => h.title === "Private Calibration Log");
  assert.match(priv.caution, /never copy into a public repo/i);
});

test("searchVault returns nothing for a query of only generic vocabulary", () => {
  assert.deepEqual(searchVault(RECORDS, "the system model agent code tool"), []);
});

test("searchVault returns nothing for an empty query", () => {
  assert.deepEqual(searchVault(RECORDS, ""), []);
  assert.deepEqual(searchVault(RECORDS, "   "), []);
});

test("searchVault caps the limit between 1 and 25", () => {
  assert.equal(searchVault(RECORDS, "calibration", 1).length, 1);
  assert.ok(searchVault(RECORDS, "calibration", 999).length <= 25);
  // a nonsense limit falls back to the default rather than returning nothing
  assert.ok(searchVault(RECORDS, "calibration", NaN).length > 0);
});

test("formatSearchResult tells the caller pointers are not findings", () => {
  const hits = searchVault(RECORDS, "calibration drift");
  const out = formatSearchResult(hits, "calibration drift");
  assert.match(String(out.note), /not relevance/i);
  assert.match(String(out.note), /vault_note/);
});

test("an empty result says a lexical miss is not evidence of absence", () => {
  const out = formatSearchResult([], "nothing matches this");
  assert.deepEqual(out.hits, []);
  assert.match(String(out.note), /not evidence/i);
  assert.match(String(out.note), /wiki-query/);
});

test("resolveNotePath accepts a path, a title, and a .md-less path", () => {
  assert.equal(
    resolveNotePath(RECORDS, "03 - Concepts/Gamma Term.md"),
    "03 - Concepts/Gamma Term.md",
  );
  assert.equal(resolveNotePath(RECORDS, "Gamma Term"), "03 - Concepts/Gamma Term.md");
  assert.equal(resolveNotePath(RECORDS, "gamma term"), "03 - Concepts/Gamma Term.md");
  assert.equal(
    resolveNotePath(RECORDS, "03 - Concepts/Gamma Term"),
    "03 - Concepts/Gamma Term.md",
  );
});

test("resolveNotePath returns null rather than guessing", () => {
  assert.equal(resolveNotePath(RECORDS, "No Such Note"), null);
  assert.equal(resolveNotePath(RECORDS, ""), null);
  assert.equal(resolveNotePath(RECORDS, "   "), null);
});

test("isSafeVaultPath refuses traversal and absolute paths", () => {
  // The `note` argument is model-supplied, so this is the boundary between a
  // vault reader and an arbitrary-file reader.
  assert.equal(isSafeVaultPath("03 - Concepts/Gamma Term.md"), true);
  assert.equal(isSafeVaultPath("../../../etc/passwd"), false);
  assert.equal(isSafeVaultPath("notes/../../secret.md"), false);
  assert.equal(isSafeVaultPath("/etc/passwd"), false);
  assert.equal(isSafeVaultPath("~/.ssh/id_rsa"), false);
  assert.equal(isSafeVaultPath(""), false);
});
