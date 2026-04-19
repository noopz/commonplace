#!/usr/bin/env tsx
/**
 * Build .wiki/*.json indexes for the vault.
 * Usage: npx tsx scripts/index.ts --vault <path> [--incremental]
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, basename } from "path";
import { parseArgs } from "util";
import {
  resolveVault,
  loadDomainRegistry,
  findAllNotes,
  classifyNote,
  getLastIndexTime,
  getFileMtime,
} from "./lib/vault.js";
import {
  parseNote,
  extractFrontmatterWikilinks,
  extractWikilinks,
  isStub,
} from "./lib/frontmatter.js";
import {
  inferSourceDomain,
  inferConceptDomains,
  lookupScope,
} from "./lib/domain.js";
import type {
  SourceNote,
  ConceptNote,
  MocNote,
  DomainSummary,
  IndexData,
} from "./lib/types.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    incremental: { type: "boolean", default: false },
  },
});

const config = resolveVault(values.vault);
const registry = loadDomainRegistry(config.claudeMdPath);

// Ensure .wiki/ directory exists
if (!existsSync(config.wikiPath)) {
  mkdirSync(config.wikiPath, { recursive: true });
}

const incremental = values.incremental ?? false;
const lastIndexTime = incremental ? getLastIndexTime(config) : 0;

// Find all notes
const allFiles = await findAllNotes(config.vaultPath);

// Filter to only changed files if incremental
const filesToProcess = incremental
  ? allFiles.filter((f) => getFileMtime(f) > lastIndexTime)
  : allFiles;

// If incremental and nothing changed, exit early
if (incremental && filesToProcess.length === 0) {
  const result = { status: "up-to-date", filesProcessed: 0 };
  console.log(JSON.stringify(result));
  process.exit(0);
}

// For incremental, load existing indexes as base
let existingSources: SourceNote[] = [];
let existingConcepts: ConceptNote[] = [];
let existingMocs: MocNote[] = [];

if (incremental) {
  try {
    const parseJsonl = <T>(f: string): T[] =>
      readFileSync(f, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    existingSources = parseJsonl(join(config.wikiPath, "source-index.jsonl"));
    existingConcepts = parseJsonl(join(config.wikiPath, "concept-index.jsonl"));
    existingMocs = parseJsonl(join(config.wikiPath, "moc-index.jsonl"));
  } catch {
    // If indexes don't exist, do full rebuild
  }
}

// Process all files (full rebuild) or just changed ones (incremental merge later)
const processFiles = incremental ? allFiles : allFiles; // Always read all for backlink counting
const sources: SourceNote[] = [];
const concepts: ConceptNote[] = [];
const mocs: MocNote[] = [];

// Track which concepts are referenced by which domain
const domainConceptRefs = new Map<string, Set<string>>();

for (const filePath of processFiles) {
  const noteType = classifyNote(filePath, config.vaultPath);
  if (noteType === "other") continue;

  let parsed;
  try {
    parsed = parseNote(filePath, config.vaultPath);
  } catch {
    continue; // Skip files that can't be parsed
  }

  const fm = parsed.frontmatter;

  if (noteType === "source") {
    const domain = inferSourceDomain(filePath, config.vaultPath, registry);
    const scope = lookupScope(domain, registry);
    const conceptLinks = extractFrontmatterWikilinks(fm.concepts);
    const mocLinks = extractFrontmatterWikilinks(fm.mocs);

    sources.push({
      title: parsed.title,
      path: filePath,
      domain,
      scope,
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      concepts: conceptLinks,
      mocs: mocLinks,
      buildsOn: extractFrontmatterWikilinks(fm.builds_on),
      comparesWith: extractFrontmatterWikilinks(fm.compares_with),
      usesMethod: extractFrontmatterWikilinks(fm.uses_method),
    });

    // Track concept references per domain
    if (!domainConceptRefs.has(domain)) {
      domainConceptRefs.set(domain, new Set());
    }
    for (const c of conceptLinks) {
      domainConceptRefs.get(domain)!.add(c);
    }
  } else if (noteType === "concept") {
    const name = basename(filePath, ".md");
    concepts.push({
      name,
      path: filePath,
      domains: [], // Filled in below
      backlinkCount: 0, // Filled in below
      isStub: isStub(parsed.body),
    });
  } else if (noteType === "moc") {
    const name = basename(filePath, ".md");
    // Extract declared count from ## Papers (N) heading
    const countMatch = parsed.body.match(/##\s+Papers\s*\((\d+)\)/);
    const declaredCount = countMatch ? parseInt(countMatch[1], 10) : null;

    mocs.push({
      name,
      path: filePath,
      domains: [], // Filled in below
      sourceCount: 0, // Filled in below
      declaredCount,
    });
  }
}

// Compute backlink counts: scan ALL vault files for wikilinks to concepts,
// not just source frontmatter — so person notes, Google Docs notes, etc. count too
const conceptNames = new Set(concepts.map((c) => c.name));
const backlinkCounts = new Map<string, number>();

for (const filePath of allFiles) {
  const noteType = classifyNote(filePath, config.vaultPath);
  if (noteType === "concept") continue; // don't count self-links

  try {
    const parsed = parseNote(filePath, config.vaultPath);
    // Count from frontmatter concepts array (source notes) AND body wikilinks (all notes)
    const frontmatterLinks = extractFrontmatterWikilinks(parsed.frontmatter.concepts);
    const bodyLinks = extractWikilinks(parsed.body);
    const allLinks = new Set([...frontmatterLinks, ...bodyLinks]);

    for (const name of allLinks) {
      if (conceptNames.has(name)) {
        backlinkCounts.set(name, (backlinkCounts.get(name) ?? 0) + 1);
      }
    }

    // Track concept-domain associations from non-source notes too
    if (noteType !== "source") {
      const domain = inferSourceDomain(filePath, config.vaultPath, registry);
      if (domain && !domainConceptRefs.has(domain)) {
        domainConceptRefs.set(domain, new Set());
      }
      if (domain) {
        for (const name of allLinks) {
          if (conceptNames.has(name)) domainConceptRefs.get(domain)!.add(name);
        }
      }
    }
  } catch {
    // Skip unreadable files
  }
}

for (const concept of concepts) {
  concept.backlinkCount = backlinkCounts.get(concept.name) ?? 0;
  concept.domains = inferConceptDomains(concept.name, domainConceptRefs);
}

// Compute source counts and domains for MOCs
for (const moc of mocs) {
  const referencingSources = sources.filter((s) =>
    s.mocs.includes(moc.name)
  );
  moc.sourceCount = referencingSources.length;
  moc.domains = [
    ...new Set(referencingSources.map((s) => s.domain)),
  ];
}

// Build domain summaries
const domainSummaries: DomainSummary[] = Object.entries(registry.domains).map(
  ([slug, entry]) => ({
    slug,
    path: entry.path,
    scope: entry.scope,
    sourceCount: sources.filter((s) => s.domain === slug).length,
    conceptCount: concepts.filter((c) => c.domains.includes(slug)).length,
  })
);

// Write indexes as JSONL (one record per line) — grep returns complete records
function toJsonl(arr: unknown[]): string {
  return arr.map(item => JSON.stringify(item)).join("\n") + "\n";
}

writeFileSync(join(config.wikiPath, "source-index.jsonl"), toJsonl(sources));
writeFileSync(join(config.wikiPath, "concept-index.jsonl"), toJsonl(concepts));
writeFileSync(join(config.wikiPath, "moc-index.jsonl"), toJsonl(mocs));
writeFileSync(join(config.wikiPath, "domain-index.jsonl"), toJsonl(domainSummaries));

// Write last-index timestamp
writeFileSync(
  join(config.wikiPath, ".last-index"),
  String(Date.now())
);

const result: { status: string; filesProcessed: number; index: IndexData } = {
  status: "ok",
  filesProcessed: processFiles.length,
  index: {
    sources,
    concepts,
    mocs,
    domains: domainSummaries,
    timestamp: new Date().toISOString(),
  },
};

console.log(JSON.stringify(result));
