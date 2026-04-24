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
import type { ScopeViolation, ConceptNote } from "./lib/types.js";

const { values, positionals } = parseArgs({
  options: {
    vault: { type: "string" },
  },
  allowPositionals: true,
});

const config = resolveVault(values.vault);
const registry = loadDomainRegistry(config.wikiPath);

// Load concept index for domain lookup
let conceptIndex: ConceptNote[] = [];
if (ensureIndex(config)) {
  try {
    conceptIndex = loadIndexes(config).concepts;
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

  // Public notes with no linkGroup restrictions — skip
  if (effectiveScope === "public" && !registry.domains[sourceDomain]?.linkGroup) return;

  // Check both frontmatter concept links and body wikilinks
  const conceptLinks = [
    ...extractFrontmatterWikilinks(parsed.frontmatter.concepts),
    ...extractWikilinks(parsed.body),
  ];

  for (const conceptName of conceptLinks) {
    const concept = conceptIndex.find((c) => c.name === conceptName);
    if (!concept) continue;

    for (const cDomain of concept.domains) {
      if (!canLink(sourceDomain, cDomain, registry)) {
        const cScope = lookupScope(cDomain, registry);
        violations.push({
          sourceFile: fp,
          targetFile: concept.path,
          sourceDomain,
          targetDomain: cDomain,
          sourceScope: effectiveScope,
          targetScope: cScope,
          reason: `Domain "${sourceDomain}" (${effectiveScope}) cannot link to domain "${cDomain}" (${cScope})`,
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
