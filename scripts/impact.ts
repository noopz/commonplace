#!/usr/bin/env tsx
/**
 * Find source notes potentially impacted by a newly ingested source.
 * Impact = shares 2+ concepts with the new source.
 * Usage: npx tsx scripts/impact.ts --vault <path> --source <note-path>
 */

import { parseArgs } from "util";
import { resolveVault, ensureIndex, loadIndexes } from "./lib/vault.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    source: { type: "string" },
  },
});

if (!values.source) {
  console.error("Error: --source <note-path> is required");
  process.exit(1);
}

const config = resolveVault(values.vault);

if (!ensureIndex(config)) {
  console.log(JSON.stringify({ affected: [] }));
  process.exit(0);
}

const { sources } = loadIndexes(config);

// Normalize wikilink strings like [[Concept]] → concept (lowercase)
function normalizeConcept(c: string): string {
  return c.replace(/^\[\[/, "").replace(/\]\]$/, "").toLowerCase().trim();
}

// Find the new source note in the index by path suffix match
const sourcePath = values.source;
const newSource = sources.find(
  (s) =>
    s.path === sourcePath ||
    s.path.endsWith(sourcePath) ||
    sourcePath.endsWith(s.path)
);

if (!newSource) {
  console.log(
    JSON.stringify({ affected: [], note: "source not found in index — run index --incremental first" })
  );
  process.exit(0);
}

const newConcepts = new Set(newSource.concepts.map(normalizeConcept));

// Find other sources that share 2+ concepts, sorted by overlap count descending
const affected = sources
  .filter((s) => s.path !== newSource.path)
  .flatMap((s) => {
    const overlap = s.concepts
      .map(normalizeConcept)
      .filter((c) => newConcepts.has(c));
    if (overlap.length >= 2) {
      return [
        {
          path: s.path,
          title: s.title,
          domain: s.domain,
          sharedConcepts: overlap,
        },
      ];
    }
    return [];
  })
  .sort((a, b) => b.sharedConcepts.length - a.sharedConcepts.length);

console.log(JSON.stringify({ newSource: newSource.path, affected }));
