#!/usr/bin/env tsx
/**
 * Vault pruning — dream-inspired consolidation for the knowledge base.
 * Identifies low-value concept stubs and removes them (or reports candidates).
 *
 * Phases (orient → gather → consolidate → prune):
 *   Orient:      Load indexes, classify all concepts
 *   Gather:      Find all references to auto-delete candidates
 *   Consolidate: Check for broader concepts that can absorb references
 *   Prune:       Delete files (with --execute), output cleanup instructions
 *
 * Usage: npx tsx scripts/prune.ts --vault <path> [--execute] [--verbose]
 */

import { readFileSync, unlinkSync, existsSync } from "fs";
import { basename } from "path";
import { parseArgs } from "util";
import { resolveVault, ensureIndex, loadIndexes, findAllNotes } from "./lib/vault.js";
import { parseNote, extractWikilinks, extractAllFrontmatterLinks } from "./lib/frontmatter.js";
import { isMalformedConceptName } from "./lib/domain.js";
import type { ConceptNote, PruneResult } from "./lib/types.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    execute: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
});

const config = resolveVault(values.vault);

if (!ensureIndex(config)) {
  console.error("Indexes not found. Run index.ts first.");
  process.exit(1);
}

const { concepts: conceptIndex } = loadIndexes(config);

// === Value heuristic ===

function isLowValueStub(concept: ConceptNote): boolean {
  if (!concept.isStub) return false;
  if (isMalformedConceptName(concept.name)) return true;
  if (concept.name.split(/\s+/).length >= 5) return true;
  return false;
}

// === Orient: classify concepts into tiers ===

type Tier = "auto" | "review" | "keep";

function classifyTier(concept: ConceptNote): { tier: Tier; reason: string } {
  if (!concept.isStub) return { tier: "keep", reason: "compiled" };
  if (concept.backlinkCount >= 2) return { tier: "keep", reason: "connected (2+ backlinks)" };

  if (concept.backlinkCount === 0) {
    return { tier: "auto", reason: "orphan stub (0 backlinks)" };
  }

  // backlinkCount === 1
  if (isLowValueStub(concept)) {
    const nameWords = concept.name.split(/\s+/).length;
    if (isMalformedConceptName(concept.name)) {
      return { tier: "auto", reason: "malformed name (sentence fragment)" };
    }
    return { tier: "auto", reason: `overly specific (${nameWords} words)` };
  }

  return { tier: "review", reason: "1-backlink stub with legitimate name" };
}

const autoCandidates: Array<ConceptNote & { reason: string }> = [];
const reviewCandidates: ConceptNote[] = [];

for (const concept of conceptIndex) {
  const { tier, reason } = classifyTier(concept);
  if (tier === "auto") autoCandidates.push({ ...concept, reason });
  else if (tier === "review") reviewCandidates.push(concept);
}

if (values.verbose) {
  console.error(`Orient: ${conceptIndex.length} concepts, ${autoCandidates.length} auto-delete, ${reviewCandidates.length} review`);
}

// === Gather: find all references to auto candidates ===

interface Reference {
  file: string;
  concept: string;
  location: "frontmatter" | "body";
}

const allFiles = await findAllNotes(config.vaultPath);
const autoNames = new Set(autoCandidates.map((c) => c.name));
const references: Reference[] = [];

for (const filePath of allFiles) {
  // Skip the concept files themselves
  if (autoCandidates.some((c) => c.path === filePath)) continue;

  try {
    const parsed = parseNote(filePath, config.vaultPath);
    const fmLinks = extractAllFrontmatterLinks(parsed.frontmatter);
    const bodyLinks = extractWikilinks(parsed.body);

    for (const link of fmLinks) {
      if (autoNames.has(link)) {
        references.push({ file: filePath, concept: link, location: "frontmatter" });
      }
    }
    for (const link of bodyLinks) {
      if (autoNames.has(link)) {
        references.push({ file: filePath, concept: link, location: "body" });
      }
    }
  } catch {
    // Skip unparseable
  }
}

// === Consolidate: find broader concepts for redirects ===

const allConceptNames = conceptIndex.map((c) => c.name);

function findBroaderConcept(name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const other of allConceptNames) {
    if (other === name) continue;
    // The candidate name contains the broader concept as a substring
    if (lower.includes(other.toLowerCase()) && other.length < name.length) {
      return other;
    }
  }
  return undefined;
}

// === Build cleanup instructions ===

const cleanup: PruneResult["cleanup"] = [];

for (const ref of references) {
  const broader = findBroaderConcept(ref.concept);
  if (ref.location === "frontmatter") {
    cleanup.push({
      file: ref.file,
      concept: ref.concept,
      location: "frontmatter",
      instruction: `remove '  - '[[${ref.concept}]]'' from frontmatter array`,
      replacement: broader ? `[[${broader}]]` : undefined,
    });
  } else {
    cleanup.push({
      file: ref.file,
      concept: ref.concept,
      location: "body",
      instruction: `replace [[${ref.concept}]] with ${broader ? `[[${broader}]]` : ref.concept}`,
      replacement: broader ? `[[${broader}]]` : undefined,
    });
  }
}

// === Find references for review candidates ===

const reviewItems: PruneResult["review"] = [];

for (const concept of reviewCandidates) {
  const referencedBy: string[] = [];
  for (const filePath of allFiles) {
    if (filePath === concept.path) continue;
    try {
      const raw = readFileSync(filePath, "utf-8");
      if (raw.includes(`[[${concept.name}]]`)) {
        referencedBy.push(basename(filePath, ".md"));
      }
    } catch {
      // Skip
    }
  }
  reviewItems.push({
    concept: concept.name,
    path: concept.path,
    backlinkCount: concept.backlinkCount,
    referencedBy,
  });
}

// === Prune (or dry run) ===

const deleted: PruneResult["deleted"] = [];
const wouldDelete: PruneResult["deleted"] = [];

for (const candidate of autoCandidates) {
  if (values.execute) {
    if (existsSync(candidate.path)) {
      unlinkSync(candidate.path);
      deleted.push({ concept: candidate.name, path: candidate.path, reason: candidate.reason });
      if (values.verbose) {
        console.error(`Deleted: ${candidate.name} (${candidate.reason})`);
      }
    }
  } else {
    wouldDelete.push({ concept: candidate.name, path: candidate.path, reason: candidate.reason });
  }
}

// === Output ===

const result: PruneResult = {
  deleted,
  ...(values.execute ? {} : { wouldDelete }),
  cleanup,
  review: reviewItems,
  summary: {
    deleted: values.execute ? deleted.length : wouldDelete.length,
    cleanupNeeded: cleanup.length,
    reviewCount: reviewItems.length,
  },
};

console.log(JSON.stringify(result));
