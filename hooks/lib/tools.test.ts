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
  openPrivateDomains,
  visibleRecords,
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

  assert.match(byTitle["Private Calibration Log"].caution ?? "", /private/);
  assert.match(byTitle["Retired Calibration Rig"].caution ?? "", /retired/);
  assert.match(byTitle["Stub Calibration Idea"].caution ?? "", /stub/);
  // A plain note carries no caution at all.
  assert.equal(byTitle["Alpha Calibration Drift"].caution, undefined);
});

test("the private caution warns against copying into public artefacts", () => {
  const hits = searchVault(RECORDS, "calibration");
  const priv = hits.find((h) => h.title === "Private Calibration Log");
  assert.match(priv?.caution ?? "", /never copy into a public repo/i);
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

test("formatSearchResult answers with a STRING, not an object", () => {
  // Core validates a registered tool's answer against the MCP content shape
  // (string | array | undefined). Returning an object made every vault_search
  // call fail with "a result that does not match its output shape" — which is
  // why these tools never worked once between being registered and v1.58.0.
  const out = formatSearchResult(searchVault(RECORDS, "calibration drift"), "calibration drift");
  assert.equal(typeof out, "string");
  assert.equal(typeof formatSearchResult([], "nothing"), "string");
});

test("formatSearchResult tells the caller pointers are not findings", () => {
  const hits = searchVault(RECORDS, "calibration drift");
  const out = formatSearchResult(hits, "calibration drift");
  assert.match(out, /not relevance/i);
  assert.match(out, /vault_note/);
  // The pointers themselves survive the formatting.
  assert.match(out, /Alpha Calibration Drift/);
  assert.match(out, /02 - Research\/alpha\/Alpha Calibration Drift\.md/);
});

test("an empty result says a lexical miss is not evidence of absence", () => {
  const out = formatSearchResult([], "nothing matches this");
  assert.match(out, /not evidence/i);
  assert.match(out, /wiki-query/);
});

test("a private hit carries its caution into the rendered text", () => {
  // The caution is only load-bearing if it survives into what the model reads.
  const out = formatSearchResult(searchVault(RECORDS, "calibration"), "calibration");
  assert.match(out, /CAUTION: private/);
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

// ---------------------------------------------------------------------------
// Private domains are explicit-entry
// ---------------------------------------------------------------------------

const DOMAINS = {
  alpha: { path: "02 - Research/alpha", scope: "public" },
  delta: { path: "04 - Explorations/private", scope: "private" },
  epsilon: { path: "04 - Explorations/epsilon", scope: "private" },
};

test("a private domain opens only when the session STARTED inside its folder", () => {
  const v = "/vaults/acme";
  assert.deepEqual([...openPrivateDomains(DOMAINS, v, `${v}/04 - Explorations/private`)], ["delta"]);
  assert.deepEqual([...openPrivateDomains(DOMAINS, v, `${v}/04 - Explorations/private/sub`)], ["delta"]);
  assert.equal(openPrivateDomains(DOMAINS, v, v).size, 0, "vault root opens nothing");
  assert.equal(openPrivateDomains(DOMAINS, v, "/repos/app").size, 0);
  // A sibling folder sharing a prefix is not inside the domain.
  assert.equal(openPrivateDomains(DOMAINS, v, `${v}/04 - Explorations/private-other`).size, 0);
  // Public domains are never "opened" — they are simply visible.
  assert.equal(openPrivateDomains(DOMAINS, v, `${v}/02 - Research/alpha`).size, 0);
});

test("sealed private records vanish before ranking, leaving no trace", () => {
  const sealed = visibleRecords(RECORDS, new Set());
  assert.ok(!sealed.some((r) => r.scope === "private"));
  const hits = searchVault(sealed, "calibration", 25);
  assert.ok(!hits.some((h) => h.title === "Private Calibration Log"));
  assert.doesNotMatch(formatSearchResult(hits, "calibration"), /private|hidden/i);
  // A sealed note cannot be resolved by vault_note either.
  assert.equal(resolveNotePath(sealed, "Private Calibration Log"), null);
});

test("an open private domain behaves like the rest of the vault", () => {
  const open = visibleRecords(RECORDS, new Set(["delta"]));
  const hits = searchVault(open, "calibration", 25);
  const priv = hits.find((h) => h.title === "Private Calibration Log");
  assert.ok(priv, "visible once its domain is open");
  assert.match(priv!.caution ?? "", /private/);
  // Opening one private domain does not open another.
  const other = visibleRecords(
    [...RECORDS, { title: "Epsilon Note", path: "x.md", domain: "epsilon", scope: "private" }],
    new Set(["delta"]),
  );
  assert.ok(!other.some((r) => r.title === "Epsilon Note"));
});
