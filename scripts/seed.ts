#!/usr/bin/env tsx
/**
 * Tiered lexical seed helper — the deterministic seed step for wiki-query.
 * Matches query terms against explicit key spaces in order (A abstraction,
 * B cue anchors, C names, D gated whole-record grep) and prints candidates
 * with their tier and matched terms. Zero LLM tokens; the relevance
 * judgment still comes from READING the notes ("grep finds, reading
 * connects") — this only picks better jumping-off points.
 */

import { parseArgs } from "node:util";
import { relative } from "path";
import { resolveVault, loadIndexes } from "./lib/vault.js";
import { extractKeyTerms, seedCandidates, type SeedOptions } from "./lib/seed.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    query: { type: "string" },
    mode: { type: "string", default: "tiered" },
    "no-abstraction": { type: "boolean", default: false },
    "no-authority": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

if (!values.query || values.query.trim().length === 0) {
  console.error("error: --query <text> is required");
  process.exit(1);
}
if (values.mode !== "flat" && values.mode !== "tiered") {
  console.error(`error: unknown --mode "${values.mode}" (valid: flat, tiered)`);
  process.exit(1);
}
if (values["no-abstraction"] && values.mode !== "tiered") {
  console.error("error: --no-abstraction only applies to --mode tiered");
  process.exit(1);
}
if (values["no-authority"] && values.mode !== "tiered") {
  console.error("error: --no-authority only applies to --mode tiered");
  process.exit(1);
}

const config = resolveVault(values.vault);
const indexes = loadIndexes(config);
const terms = extractKeyTerms(values.query);
const opts: SeedOptions = {
  mode: values.mode,
  ...(values["no-abstraction"] ? { skipAbstractionTier: true } : {}),
  ...(values["no-authority"] ? { rankByAuthority: false } : {}),
};
const hits = seedCandidates(terms, indexes, opts).map((h) => ({
  ...h,
  path: relative(config.vaultPath, h.path),
}));

if (values.json) {
  console.log(JSON.stringify({ query: values.query, terms, mode: values.mode, hits }, null, 2));
} else {
  console.log(`Seeds for: ${values.query}`);
  console.log(`  terms: ${terms.join(", ")}`);
  if (hits.length === 0) {
    console.log("  (no seeds — rephrase the query or Grep the indexes directly)");
  }
  for (const h of hits) {
    console.log(`  [${h.tier ?? "flat"}] ${h.kind}: ${h.label} (${h.path})${h.authority !== undefined ? ` auth=${h.authority}` : ""} <- ${h.matchedTerms.join(", ")}`);
  }
}
