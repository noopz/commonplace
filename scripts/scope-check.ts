#!/usr/bin/env tsx
/**
 * Check wikilinks against domain scoping rules.
 * Usage: npx tsx scripts/scope-check.ts --vault <path> [<file>]
 */

import { parseArgs } from "util";
import {
  resolveVault,
  loadDomainRegistry,
  classifyNote,
  isInVault,
  findAllNotes,
  loadIndexes,
  ensureIndex,
} from "./lib/vault.js";
import {
  parseNote,
  extractWikilinks,
  extractFrontmatterWikilinks,
} from "./lib/frontmatter.js";
import { inferSourceDomain, lookupScope, canLink } from "./lib/domain.js";
import type { ScopeViolation, ConceptNote, SourceNote } from "./lib/types.js";

const { values, positionals } = parseArgs({
  options: {
    vault: { type: "string" },
  },
  allowPositionals: true,
});

const config = resolveVault(values.vault);
const registry = loadDomainRegistry(config.wikiPath);

// Load indexes for domain lookup
let conceptIndex: ConceptNote[] = [];
let sourceIndex: SourceNote[] = [];
if (ensureIndex(config)) {
  try {
    const indexes = loadIndexes(config);
    conceptIndex = indexes.concepts;
    sourceIndex = indexes.sources;
  } catch {
    // Empty index
  }
}

const filePath = positionals[0];
const violations: ScopeViolation[] = [];

function checkFile(fp: string): void {
  if (!isInVault(fp, config.vaultPath)) return;

  const noteType = classifyNote(fp, config.vaultPath);
  if (noteType === "concept") return; // concepts themselves aren't scoped

  const sourceDomain = inferSourceDomain(fp, config.vaultPath, registry);
  const sourceScope = lookupScope(sourceDomain, registry);

  // Note-level scope takes precedence over domain scope
  let parsed;
  try {
    parsed = parseNote(fp, config.vaultPath);
  } catch {
    return;
  }
  // Note-level scope can override domain scope to private
  const noteScope = parsed.frontmatter.scope === "private" ? "private" : null;
  const effectiveScope = noteScope || sourceScope;

  // Check both frontmatter concept links and body wikilinks
  const conceptLinks = [
    ...extractFrontmatterWikilinks(parsed.frontmatter.concepts),
    ...extractWikilinks(parsed.body),
  ];

  for (const linkTarget of conceptLinks) {
    // Check against concept index
    const concept = conceptIndex.find((c) => c.name === linkTarget);
    if (concept) {
      for (const cDomain of concept.domains) {
        if (!canLink(sourceDomain, cDomain, registry)) {
          violations.push({
            sourceFile: fp,
            targetFile: concept.path,
            sourceDomain,
            targetDomain: cDomain,
            sourceScope: effectiveScope,
            targetScope: lookupScope(cDomain, registry),
            reason: `Domain "${sourceDomain}" (${effectiveScope}) cannot link to concept "${linkTarget}" in domain "${cDomain}" (${lookupScope(cDomain, registry)})`,
          });
        }
      }
      continue;
    }

    // Check against source index (e.g. People notes)
    const source = sourceIndex.find((s) => s.title === linkTarget);
    if (source) {
      if (!canLink(sourceDomain, source.domain, registry)) {
        violations.push({
          sourceFile: fp,
          targetFile: source.path,
          sourceDomain,
          targetDomain: source.domain,
          sourceScope: effectiveScope,
          targetScope: source.scope,
          reason: `Domain "${sourceDomain}" (${effectiveScope}) cannot link to source "${linkTarget}" in domain "${source.domain}" (${source.scope})`,
        });
      }
    }
  }
}

if (filePath) {
  checkFile(filePath);
} else {
  // Check all vault notes (not just indexed sources)
  const allVaultFiles = await findAllNotes(config.vaultPath);
  for (const fp of allVaultFiles) {
    checkFile(fp);
  }
}

console.log(JSON.stringify(violations));
