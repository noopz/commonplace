#!/usr/bin/env tsx
/**
 * Find cross-domain bridge concepts and recent sources that activate them.
 * Bridge concept = a concept that appears in 2+ domains.
 * Usage: npx tsx scripts/cross-domain.ts --vault <path> [--since <ISO-date>]
 */

import { parseArgs } from "util";
import { resolveVault, ensureIndex, loadIndexes } from "./lib/vault.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    since: { type: "string" },
    source: { type: "string" }, // limit results to a single source path (for hook use)
  },
});

const config = resolveVault(values.vault);

if (!ensureIndex(config)) {
  console.log(JSON.stringify({ results: [], sinceFilter: values.since ?? null }));
  process.exit(0);
}

const { sources, concepts } = loadIndexes(config);

// Normalize wikilink strings like [[Concept]] → concept (lowercase)
function normalizeConcept(c: string): string {
  return c.replace(/^\[\[/, "").replace(/\]\]$/, "").toLowerCase().trim();
}

// Build a map of bridge concepts: name → domains[]
const bridgeConceptMap = new Map<string, string[]>();
for (const concept of concepts) {
  if (concept.domains.length > 1) {
    bridgeConceptMap.set(concept.name.toLowerCase(), concept.domains);
  }
}

// If --source is given, only check that one source (hook use case)
const sourcesToCheck = values.source
  ? sources.filter((s) => s.path === values.source || s.path.endsWith(values.source!))
  : sources;

// For each source, find which of its concepts are cross-domain bridges
const results = sourcesToCheck.flatMap((source) => {
  const sourceConcepts = source.concepts.map(normalizeConcept);
  const bridges = sourceConcepts.filter((c) => bridgeConceptMap.has(c));
  if (bridges.length === 0) return [];

  const bridgeDetails = bridges.map((bridgeName) => {
    const affectedDomains = bridgeConceptMap.get(bridgeName) ?? [];
    // Find other sources in different domains that share this concept
    const affectedSources = sources
      .filter(
        (s) =>
          s.path !== source.path &&
          s.domain !== source.domain &&
          s.concepts.some((c) => normalizeConcept(c) === bridgeName)
      )
      .map((s) => ({ path: s.path, title: s.title, domain: s.domain }));
    return { concept: bridgeName, affectedDomains, affectedSources };
  });

  // Only include sources that have at least one bridge with cross-domain hits
  const activeBridges = bridgeDetails.filter((b) => b.affectedSources.length > 0);
  if (activeBridges.length === 0) return [];

  return [
    {
      source: source.path,
      title: source.title,
      domain: source.domain,
      bridgeConcepts: activeBridges,
    },
  ];
});

console.log(JSON.stringify({ sinceFilter: values.since ?? null, results }));
