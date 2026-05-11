#!/usr/bin/env tsx
/**
 * Build .wiki/*.jsonl indexes for the vault:
 *   - source-index.jsonl, concept-index.jsonl, moc-index.jsonl, domain-index.jsonl
 *   - backlink-index.jsonl — inverted index of body wikilinks (target path → sources).
 *     Frontmatter edges (concepts/mocs arrays) are intentionally excluded; they're
 *     already in source-index.jsonl and conflating prose links with structural tags
 *     loses a semantic distinction.
 * Usage: npx tsx scripts/index.ts --vault <path> [--incremental]
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, basename } from "path";
import { parseArgs } from "util";
import {
  resolveVault,
  loadDomainRegistry,
  autoRegisterDomain,
  saveDomainRegistry,
  findAllNotes,
  classifyNote,
  getLastIndexTime,
  getFileMtime,
  loadWikiConfig,
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
import { normalizeWikilinkTarget } from "./lib/resolve.js";
import { discoverGenres, loadGenreSamples } from "./lib/genre-discovery.js";
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
const registry = loadDomainRegistry(config.wikiPath);

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
  console.log("Indexes up to date, 0 files changed");
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
  let noteType = classifyNote(filePath, config.vaultPath, null, registry);

  // Auto-discover: "other" notes with source-shaped frontmatter (concepts: array)
  if (noteType === "other") {
    try {
      const probe = parseNote(filePath, config.vaultPath);
      if (Array.isArray(probe.frontmatter.concepts) && probe.frontmatter.concepts.length > 0) {
        const slug = autoRegisterDomain(filePath, config.vaultPath, config.wikiPath, registry);
        if (slug) noteType = "source";
      }
    } catch { /* skip */ }
    if (noteType === "other") continue;
  }

  let parsed;
  try {
    parsed = parseNote(filePath, config.vaultPath);
  } catch {
    continue; // Skip files that can't be parsed
  }

  const fm = parsed.frontmatter;

  if (noteType === "source") {
    const domain = inferSourceDomain(filePath, config.vaultPath, registry);
    // Note-level scope overrides domain scope (only "public" or "private" are valid)
    const noteScope = fm.scope === "private" ? "private" : fm.scope === "public" ? "public" : null;
    const scope = noteScope || lookupScope(domain, registry);
    const fmConcepts = extractFrontmatterWikilinks(fm.concepts);
    const mocLinks = extractFrontmatterWikilinks(fm.mocs);

    // Union frontmatter concepts with body wikilinks that resolve to concept notes.
    // Body wikilinks are authoritative — frontmatter is a curation hint.
    // We collect body links here; after the concept index is built, we filter to
    // only those that match actual concept notes (deferred to post-processing below).
    const bodyLinks = extractWikilinks(parsed.body);
    const allConceptRefs = [...new Set([...fmConcepts, ...bodyLinks])];

    sources.push({
      title: parsed.title,
      path: filePath,
      domain,
      scope,
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      concepts: allConceptRefs, // Refined to actual concepts in post-processing
      mocs: mocLinks,
      buildsOn: extractFrontmatterWikilinks(fm.builds_on),
      comparesWith: extractFrontmatterWikilinks(fm.compares_with),
      usesMethod: extractFrontmatterWikilinks(fm.uses_method),
    });

    // Source-domain refs are populated after the concept index is built,
    // so we can resolve user-typed names to canonical concept names.
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
    // Extract declared count from a count-bearing section heading.
    // Many MOCs use "Papers", but other vault domains may use "Sources",
    // "Notes", "Items", "Entries"; treat them all as MOC list headings.
    const countMatch = parsed.body.match(
      /##\s+(?:Papers|Sources|Notes|Items|Entries)\s*\((\d+)\)/i
    );
    const declaredCount = countMatch ? parseInt(countMatch[1], 10) : null;

    mocs.push({
      name,
      path: filePath,
      domains: [], // Filled in below
      sourceCount: 0, // Filled in below
      sources: [], // Filled in below
      declaredCount,
    });
  }
}

// Build case-insensitive, alias-aware concept lookup. Wikilinks resolve
// case-insensitively in Obsidian and through `aliases:` frontmatter, so the
// indexer treats `[[layered memory]]`, `[[Layered Memory]]`, and an aliased
// short form as references to the same concept's canonical name.
const conceptByLower = new Map<string, string>(); // lower(name|alias) → canonical
for (const c of concepts) {
  conceptByLower.set(c.name.toLowerCase(), c.name);
  try {
    const parsed = parseNote(c.path, config.vaultPath);
    const aliases = parsed.frontmatter.aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string" && alias.length > 0) {
          const key = alias.toLowerCase();
          if (!conceptByLower.has(key)) conceptByLower.set(key, c.name);
        }
      }
    }
  } catch {}
}

function resolveConceptRef(target: string): string | null {
  const key = normalizeWikilinkTarget(target);
  if (!key) return null;
  return conceptByLower.get(key) ?? null;
}

// Resolve each source's collected concept refs to canonical names. This
// merges duplicates (alias + canonical, different cases) and drops refs
// that don't resolve to a concept note (e.g. links to source notes or MOCs).
for (const source of sources) {
  const resolved = new Set<string>();
  for (const ref of source.concepts) {
    const canonical = resolveConceptRef(ref);
    if (canonical) resolved.add(canonical);
  }
  source.concepts = [...resolved];

  if (!domainConceptRefs.has(source.domain)) {
    domainConceptRefs.set(source.domain, new Set());
  }
  for (const c of source.concepts) {
    domainConceptRefs.get(source.domain)!.add(c);
  }
}

// Build name → absolute path index for backlink resolution. Wikilink targets
// resolve case-insensitively and through `aliases:` frontmatter, so we need
// the same lookup behavior as concept resolution but keyed by path (since the
// backlink index records target paths, not names).
const nameToPath = new Map<string, string>();
for (const filePath of allFiles) {
  const canonical = basename(filePath, ".md").toLowerCase();
  if (!nameToPath.has(canonical)) nameToPath.set(canonical, filePath);
  try {
    const parsed = parseNote(filePath, config.vaultPath);
    const aliases = parsed.frontmatter.aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string" && alias.length > 0) {
          const key = alias.toLowerCase();
          if (!nameToPath.has(key)) nameToPath.set(key, filePath);
        }
      }
    }
  } catch {}
}

// Inverted backlink index: target path → Map<source path, count>.
// Body wikilinks only — frontmatter edges are already captured in
// source-index.jsonl (concepts/mocs arrays) and conflating structural tags
// with prose links would lose a real semantic distinction.
const backlinkIndex = new Map<string, Map<string, number>>();
const wikilinkPattern = /\[\[([^\[\]|]+)(?:\|[^\[\]]+)?\]\]/g;

// Compute backlink counts: scan ALL vault files for wikilinks to concepts,
// not just source frontmatter — so person notes, Google Docs notes, etc. count too
const backlinkCounts = new Map<string, number>();

for (const filePath of allFiles) {
  const noteType = classifyNote(filePath, config.vaultPath);

  try {
    const parsed = parseNote(filePath, config.vaultPath);

    // Backlink index: count duplicate mentions of the same target as repeated
    // edges from one source, rather than emitting duplicate records.
    const bodyLinkCounts = new Map<string, number>();
    let m: RegExpExecArray | null;
    wikilinkPattern.lastIndex = 0;
    while ((m = wikilinkPattern.exec(parsed.body)) !== null) {
      const raw = m[1].trim();
      bodyLinkCounts.set(raw, (bodyLinkCounts.get(raw) ?? 0) + 1);
    }
    for (const [raw, count] of bodyLinkCounts) {
      const key = normalizeWikilinkTarget(raw);
      if (!key) continue;
      const targetPath = nameToPath.get(key);
      if (!targetPath || targetPath === filePath) continue;
      if (!backlinkIndex.has(targetPath)) backlinkIndex.set(targetPath, new Map());
      const sourceMap = backlinkIndex.get(targetPath)!;
      sourceMap.set(filePath, (sourceMap.get(filePath) ?? 0) + count);
    }

    if (noteType === "concept") continue; // don't count self-links for concept backlinkCount

    const frontmatterLinks = extractFrontmatterWikilinks(parsed.frontmatter.concepts);
    const bodyLinks = extractWikilinks(parsed.body);
    const allLinks = new Set([...frontmatterLinks, ...bodyLinks]);

    // Resolve each link to a canonical concept name; non-concept links
    // (sources, MOCs, broken refs) resolve to null and are skipped.
    const referencedConcepts = new Set<string>();
    for (const name of allLinks) {
      const canonical = resolveConceptRef(name);
      if (canonical) referencedConcepts.add(canonical);
    }
    for (const canonical of referencedConcepts) {
      backlinkCounts.set(canonical, (backlinkCounts.get(canonical) ?? 0) + 1);
    }

    // Track concept-domain associations from non-source notes too
    if (noteType !== "source") {
      const domain = inferSourceDomain(filePath, config.vaultPath, registry);
      if (domain) {
        if (!domainConceptRefs.has(domain)) {
          domainConceptRefs.set(domain, new Set());
        }
        for (const canonical of referencedConcepts) {
          domainConceptRefs.get(domain)!.add(canonical);
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

// Compute source counts and domains for MOCs (public sources only)
for (const moc of mocs) {
  const referencingSources = sources.filter((s) =>
    s.mocs.includes(moc.name) && s.scope !== "private"
  );
  moc.sourceCount = referencingSources.length;
  moc.sources = referencingSources.map((s) => s.title);
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

// Materialize the inverted backlink index. Sort targets and sources by path
// so diffs between runs are deterministic.
const backlinkRecords = [...backlinkIndex.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([target, sources]) => ({
    target,
    backlinks: [...sources.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, count]) => ({ source, count })),
  }));

writeFileSync(join(config.wikiPath, "source-index.jsonl"), toJsonl(sources));
writeFileSync(join(config.wikiPath, "concept-index.jsonl"), toJsonl(concepts));
writeFileSync(join(config.wikiPath, "moc-index.jsonl"), toJsonl(mocs));
writeFileSync(join(config.wikiPath, "domain-index.jsonl"), toJsonl(domainSummaries));
writeFileSync(join(config.wikiPath, "backlink-index.jsonl"), toJsonl(backlinkRecords));

// Write last-index timestamp
writeFileSync(
  join(config.wikiPath, ".last-index"),
  String(Date.now())
);

// Re-run genre discovery so new genres crossing the ≥3-note threshold get
// surfaced without the user having to re-run init. We write conventions.json
// only when the discovered set actually changed; the SessionStart hook reads
// the file later and surfaces any untuned genres to the model.
const cfg = loadWikiConfig(config);
const genreStructureDirs = new Set(
  [cfg?.structure.concepts, cfg?.structure.mocs].filter((s): s is string => Boolean(s)),
);
const genreSamples = await loadGenreSamples(config.vaultPath);
const genreResult = discoverGenres(genreSamples, genreStructureDirs, config.wikiPath);
if (genreResult.changed) {
  writeFileSync(
    join(config.wikiPath, "conventions.json"),
    JSON.stringify(genreResult.conventions, null, 2) + "\n",
  );
}

const result = {
  status: "ok",
  filesProcessed: processFiles.length,
  sources: sources.length,
  concepts: concepts.length,
  mocs: mocs.length,
  domains: domainSummaries.length,
  timestamp: new Date().toISOString(),
};

console.log(`Indexed ${processFiles.length} files: ${sources.length} sources, ${concepts.length} concepts, ${mocs.length} MOCs, ${domainSummaries.length} domains, ${backlinkRecords.length} backlink targets`);
if (genreResult.newGenres.length > 0) {
  console.log(
    `Discovered ${genreResult.newGenres.length} new genre(s): ${genreResult.newGenres.join(", ")} — dispatch wiki-conventions-tuner to propose rules.`,
  );
}
