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
import { normalizeWikilinkTarget } from "./lib/resolve.js";
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

// Case-insensitive lookup tables: lowercase name/alias → record. Wikilinks
// in Obsidian resolve case-insensitively and through aliases — scope-check
// must too, otherwise a private note linked via `[[alias]]` slips past.
const conceptByLower = new Map<string, ConceptNote>();
for (const c of conceptIndex) {
  conceptByLower.set(c.name.toLowerCase(), c);
}
const sourceByLower = new Map<string, SourceNote>();
for (const s of sourceIndex) {
  sourceByLower.set(s.title.toLowerCase(), s);
}
// Pull aliases from each indexed file's frontmatter
for (const c of conceptIndex) {
  try {
    const parsed = parseNote(c.path, config.vaultPath);
    const aliases = parsed.frontmatter.aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string" && alias.length > 0) {
          const key = alias.toLowerCase();
          if (!conceptByLower.has(key)) conceptByLower.set(key, c);
        }
      }
    }
  } catch {}
}
for (const s of sourceIndex) {
  try {
    const parsed = parseNote(s.path, config.vaultPath);
    const aliases = parsed.frontmatter.aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string" && alias.length > 0) {
          const key = alias.toLowerCase();
          if (!sourceByLower.has(key)) sourceByLower.set(key, s);
        }
      }
    }
  } catch {}
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
    // Strip section anchors and skip attachments before lookup.
    const key = normalizeWikilinkTarget(linkTarget);
    if (!key) continue;

    // Check against concept index (case-insensitive, alias-aware)
    const concept = conceptByLower.get(key);
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
            reason: `Domain "${sourceDomain}" (${effectiveScope}) cannot link to concept "${concept.name}" in domain "${cDomain}" (${lookupScope(cDomain, registry)})`,
          });
        }
      }
      continue;
    }

    // Check against source index (e.g. People notes)
    const source = sourceByLower.get(key);
    if (source) {
      if (!canLink(sourceDomain, source.domain, registry)) {
        violations.push({
          sourceFile: fp,
          targetFile: source.path,
          sourceDomain,
          targetDomain: source.domain,
          sourceScope: effectiveScope,
          targetScope: source.scope,
          reason: `Domain "${sourceDomain}" (${effectiveScope}) cannot link to source "${source.title}" in domain "${source.domain}" (${source.scope})`,
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
