#!/usr/bin/env tsx
/**
 * Vault health audit. Runs deterministic checks on all notes.
 * Usage: npx tsx scripts/lint.ts --vault <path> [--check <name>]
 */

import { readFileSync } from "fs";
import { basename, dirname, relative } from "path";
import { parseArgs } from "util";
import {
  resolveVault,
  loadDomainRegistry,
  loadWikiConfig,
  findAllNotes,
  classifyNote,
  ensureIndex,
  loadIndexes,
} from "./lib/vault.js";
import {
  parseNote,
  extractH1,
  extractWikilinks,
  extractFrontmatterWikilinks,
  extractAllFrontmatterLinks,
  isStub,
  hasMalformedDateLine,
  validateFrontmatter,
} from "./lib/frontmatter.js";
import {
  normalizeConceptSlug,
  isMalformedConceptName,
  canLink,
  inferSourceDomain,
  lookupScope,
} from "./lib/domain.js";
import { buildNameIndex, normalizeWikilinkTarget } from "./lib/resolve.js";
import { loadConventions, matchGenre } from "./lib/conventions.js";
import type {
  LintIssue,
  LintResult,
  ConceptNote,
  SourceNote,
  MocNote,
} from "./lib/types.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    check: { type: "string" },
    instruct: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "rank-by-traffic": { type: "boolean", default: false },
  },
});

const config = resolveVault(values.vault);
const registry = loadDomainRegistry(config.wikiPath);
const wikiConfig = loadWikiConfig(config);
const conventions = loadConventions(config.wikiPath);
const lintExclude: string[] = wikiConfig?.lintExclude ?? [];
const issues: LintIssue[] = [];

// Load indexes if available
let sourceIndex: SourceNote[] = [];
let conceptIndex: ConceptNote[] = [];
let mocIndex: MocNote[] = [];

if (ensureIndex(config)) {
  try {
    const indexes = loadIndexes(config);
    sourceIndex = indexes.sources;
    conceptIndex = indexes.concepts;
    mocIndex = indexes.mocs;
  } catch {
    // Will run with empty indexes
  }
}

const allFiles = await findAllNotes(config.vaultPath);
// Case-insensitive lookup of every filename + alias → canonical name.
// Obsidian wikilinks resolve case-insensitively, so the lint must too.
const nameIndex = buildNameIndex(allFiles, config.vaultPath);

const checksToRun = values.check ? [values.check] : [
  "unresolved",
  "stubs",
  "orphans",
  "frontmatter",
  "moc-staleness",
  "scope-violations",
  "duplicates",
  "malformed-dates",
  "filename-h1-mismatch",
  "near-duplicate-names",
  "malformed-concept-names",
  "underlinked",
  "cluster-cohesion",
  "bridge-thinness",
  "weak-summary",
  "cross-scope-bridge",
  "concept-density-without-source-links",
];

function shouldRun(check: string): boolean {
  return checksToRun.includes(check);
}

/// Files excluded from wikilink resolution — CLAUDE.md is a schema doc, not a vault note.
// Additional exclusions can be configured in .wiki/config.json (lintExclude: string[]).
function isLintExcluded(filePath: string, exclude: string[] = []): boolean {
  if (/\/CLAUDE\.md$/.test(filePath)) return true;
  if (/\/Templates\//.test(filePath) || /\/00 - Templates\//.test(filePath)) return true;
  return exclude.some((pattern) => filePath.includes(pattern));
}

/**
 * Levenshtein distance with early-exit when distance exceeds `maxDist`.
 * Returns Infinity if the bound is exceeded, so callers can cheaply skip.
 */
function levenshtein(a: string, b: string, maxDist: number): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > maxDist) return Infinity;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array<number>(bl + 1);
  let curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return Infinity;
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

/**
 * Fuzzy-match a broken link against a candidate pool. A candidate qualifies
 * if Levenshtein distance ≤ 3 OR similarity ratio ≥ 0.8 (1 - dist/maxLen).
 * Returns matches sorted ascending by distance.
 */
function fuzzyMatch(
  query: string,
  candidates: string[],
): Array<{ name: string; distance: number }> {
  const q = query.toLowerCase();
  const out: Array<{ name: string; distance: number }> = [];
  for (const cand of candidates) {
    const c = cand.toLowerCase();
    const maxLen = Math.max(q.length, c.length);
    const ratioBound = Math.ceil(maxLen * 0.2); // ratio ≥ 0.8 ↔ dist ≤ 0.2*maxLen
    const cutoff = Math.max(3, ratioBound);
    const d = levenshtein(q, c, cutoff);
    if (d === Infinity) continue;
    const ratio = maxLen === 0 ? 1 : 1 - d / maxLen;
    if (d <= 3 || ratio >= 0.8) {
      out.push({ name: cand, distance: d });
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

// === Check: unresolved wikilinks ===
if (shouldRun("unresolved")) {
  // Build candidate pool for fuzzy matching: concept names, source titles, MOC names.
  // Each carries its domain set so we can scope-filter suggestions.
  type FuzzyCandidate = { name: string; domains: string[] };
  const fuzzyPool: FuzzyCandidate[] = [];
  for (const c of conceptIndex) fuzzyPool.push({ name: c.name, domains: c.domains });
  for (const s of sourceIndex) fuzzyPool.push({ name: s.title, domains: [s.domain] });
  for (const m of mocIndex) fuzzyPool.push({ name: m.name, domains: m.domains });

  for (const filePath of allFiles) {
    if (isLintExcluded(filePath, lintExclude)) continue;
    try {
      const parsed = parseNote(filePath, config.vaultPath);
      const bodyLinks = extractWikilinks(parsed.body);
      const fmLinks = extractAllFrontmatterLinks(parsed.frontmatter);
      const allLinks = [...new Set([...bodyLinks, ...fmLinks])];

      // Determine the source's effective domain for scope filtering.
      const fileDomain = inferSourceDomain(filePath, config.vaultPath, registry);

      for (const link of allLinks) {
        const key = normalizeWikilinkTarget(link);
        if (key === null) continue; // intra-doc anchor or attachment — not a broken note ref

        if (!nameIndex.has(key)) {
          // Try fuzzy match. Filter pool by canLink so we never suggest a
          // private target as a fix for a public note's broken link.
          const reachable = fuzzyPool.filter((c) => {
            if (c.domains.length === 0) return true;
            return c.domains.some((d) => canLink(fileDomain, d, registry));
          });
          const matches = fuzzyMatch(link, reachable.map((c) => c.name));
          let suggestionText = "";
          let fixable = false;
          if (matches.length > 0) {
            const best = matches[0];
            const strongOnly = matches.filter((m) => m.distance <= 1);
            if (strongOnly.length === 1) fixable = true;
            suggestionText = ` — did you mean [[${best.name}]]?`;
          }

          issues.push({
            check: "unresolved",
            severity: "critical",
            file: filePath,
            message: `Broken wikilink: [[${link}]]${suggestionText}`,
            fixable,
            ...(matches.length > 0 ? { suggestion: matches[0].name } : {}),
          });
        }
      }
    } catch {
      // Skip unparseable files
    }
  }
}

// === Check: stubs ===
if (shouldRun("stubs")) {
  for (const concept of conceptIndex) {
    if (concept.isStub) {
      issues.push({
        check: "stubs",
        severity: "improvement",
        file: concept.path,
        message: `Concept stub: "${concept.name}" needs a real definition`,
        fixable: false, // Requires synthesis, not mechanical fix
      });
    }
  }
}

// === Check: orphans ===
if (shouldRun("orphans")) {
  for (const concept of conceptIndex) {
    if (concept.backlinkCount === 0) {
      issues.push({
        check: "orphans",
        severity: "suggestion",
        file: concept.path,
        message: `Orphan concept: "${concept.name}" has no backlinks from any source`,
        fixable: false,
      });
    }
  }
}

// === Check: frontmatter validation ===
if (shouldRun("frontmatter")) {
  for (const filePath of allFiles) {
    const noteType = classifyNote(filePath, config.vaultPath);
    if (noteType === "other") continue;

    try {
      const parsed = parseNote(filePath, config.vaultPath);
      const errors = validateFrontmatter(parsed.frontmatter, noteType);
      for (const err of errors) {
        issues.push({
          check: "frontmatter",
          severity: "critical",
          file: filePath,
          message: `${err.field}: ${err.message}`,
          fixable: err.message.startsWith("Duplicate"),
        });
      }
    } catch {
      issues.push({
        check: "frontmatter",
        severity: "critical",
        file: filePath,
        message: "Failed to parse frontmatter",
        fixable: false,
      });
    }
  }
}

// === Check: MOC staleness ===
if (shouldRun("moc-staleness")) {
  for (const moc of mocIndex) {
    if (moc.declaredCount !== null && moc.declaredCount !== moc.sourceCount) {
      issues.push({
        check: "moc-staleness",
        severity: "improvement",
        file: moc.path,
        message: `MOC "${moc.name}" declares ${moc.declaredCount} papers but ${moc.sourceCount} sources reference it`,
        fixable: true,
      });
    }
  }
}

// === Check: scope violations ===
if (shouldRun("scope-violations")) {
  for (const source of sourceIndex) {
    for (const conceptName of source.concepts) {
      const concept = conceptIndex.find((c) => c.name === conceptName);
      if (!concept) continue;

      for (const cDomain of concept.domains) {
        if (!canLink(source.domain, cDomain, registry)) {
          issues.push({
            check: "scope-violations",
            severity: "critical",
            file: source.path,
            message: `Scope violation: domain "${source.domain}" cannot link to concept "${conceptName}" in domain "${cDomain}"`,
            fixable: false,
          });
        }
      }
    }
  }
}

// === Check: duplicates in frontmatter arrays ===
if (shouldRun("duplicates")) {
  // Already handled by frontmatter validation above, but this check
  // can be run independently
  if (!shouldRun("frontmatter")) {
    for (const filePath of allFiles) {
      const noteType = classifyNote(filePath, config.vaultPath);
      if (noteType === "other") continue;
      try {
        const parsed = parseNote(filePath, config.vaultPath);
        const errors = validateFrontmatter(parsed.frontmatter, noteType);
        for (const err of errors) {
          if (err.message.startsWith("Duplicate")) {
            issues.push({
              check: "duplicates",
              severity: "improvement",
              file: filePath,
              message: `${err.field}: ${err.message}`,
              fixable: true,
            });
          }
        }
      } catch {
        // Skip
      }
    }
  }
}

// === Check: malformed dates ===
if (shouldRun("malformed-dates")) {
  for (const filePath of allFiles) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const malformed = hasMalformedDateLine(raw);
      if (malformed) {
        issues.push({
          check: "malformed-dates",
          severity: "critical",
          file: filePath,
          message: `Malformed date line: "${malformed}" — bare text, not a valid frontmatter field`,
          fixable: true,
        });
      }
    } catch {
      // Skip
    }
  }
}

// === Check: filename / H1 mismatch on source notes ===
// Obsidian resolves [[X]] by filename, not H1. When they disagree, agents that
// derive link text from H1 produce dead links (see wiki-moc-updater bug fix).
// Severity is suggestion: shortening paper titles for filename hygiene is
// legitimate, but the mismatch is worth surfacing so the author knows agents
// must use the filename stem in [[...]].
if (shouldRun("filename-h1-mismatch")) {
  for (const s of sourceIndex) {
    const filePath = s.path;
    try {
      const filename = filePath.split("/").pop()!.replace(/\.md$/, "");
      const parsed = parseNote(filePath, config.vaultPath);
      const h1 = extractH1(parsed.body);
      if (!h1) continue;
      if (h1 !== filename) {
        issues.push({
          check: "filename-h1-mismatch",
          severity: "suggestion",
          file: filePath,
          message: `Filename "${filename}" differs from H1 "${h1}" — agents and MOC entries must use the filename stem in [[wikilinks]] (Obsidian resolves by filename)`,
          fixable: false,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }
}

// === Check: near-duplicate concept names ===
if (shouldRun("near-duplicate-names")) {
  const slugMap = new Map<string, string[]>();
  for (const concept of conceptIndex) {
    const slug = normalizeConceptSlug(concept.name);
    if (!slugMap.has(slug)) slugMap.set(slug, []);
    slugMap.get(slug)!.push(concept.name);
  }

  for (const [slug, names] of slugMap) {
    if (names.length > 1) {
      issues.push({
        check: "near-duplicate-names",
        severity: "improvement",
        file: conceptIndex.find((c) => c.name === names[0])?.path || "",
        message: `Near-duplicate concepts: ${names.map((n) => `"${n}"`).join(", ")}`,
        fixable: false,
      });
    }
  }
}

// === Check: malformed concept names ===
if (shouldRun("malformed-concept-names")) {
  for (const concept of conceptIndex) {
    if (isMalformedConceptName(concept.name)) {
      issues.push({
        check: "malformed-concept-names",
        severity: "suggestion",
        file: concept.path,
        message: `Possibly malformed concept name: "${concept.name}" — looks like a sentence fragment, not a concept`,
        fixable: false,
      });
    }
  }
}

// === Check: underlinked notes (vault note names in body text not wikilinked) ===
if (shouldRun("underlinked")) {
  // Build lookup of all linkable vault note names with domain info for scope checks
  const linkTargets: { name: string; type: string; domains: string[] }[] = conceptIndex
    .filter((c) => !c.isStub)
    .map((c) => ({ name: c.name, type: "concept", domains: c.domains }));

  // Source notes — use title from index
  for (const s of sourceIndex) {
    linkTargets.push({ name: s.title, type: "source", domains: [s.domain] });
  }

  // MOC notes — public by nature
  for (const m of mocIndex) {
    linkTargets.push({ name: m.name, type: "moc", domains: [] });
  }

  // Sort longest-first so "FinMem: A Performance-Enhanced..." matches before "FinMem"
  // and we don't double-count
  linkTargets.sort((a, b) => b.name.length - a.name.length);

  // Skip 1-char names — anything shorter than two characters is too noisy
  // for word-boundary matching. Two-letter acronyms (AI, ML, OS) stay in.
  const filteredTargets = linkTargets.filter((t) => t.name.length >= 2);

  for (const source of sourceIndex) {
    try {
      const parsed = parseNote(source.path, config.vaultPath);
      const body = parsed.body;
      // Resolve body wikilinks to canonical names so an alias counts as a link
      // to the canonical target (otherwise we'd false-positive when the body
      // uses `[[Long Paper Title]]` and the target's canonical filename is short).
      const bodyLinks = new Set<string>();
      for (const link of extractWikilinks(body)) {
        const key = normalizeWikilinkTarget(link);
        if (!key) continue;
        const canonical = nameIndex.get(key);
        bodyLinks.add((canonical ?? key).toLowerCase());
      }

      // Strip existing wikilinks, fenced+inline code, indented code blocks, and headings.
      // Wikilink regex excludes `[` so a malformed `[[foo[[bar]]` doesn't over-strip the
      // text between the two `[[` markers (a real false-negative source on the old regex).
      const stripped = body
        .replace(/\[\[[^\[\]]+\]\]/g, "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]+`/g, "")
        .replace(/^(?: {4,}|\t).*$/gm, "")
        .replace(/^#{1,3}\s+.+$/gm, "");

      const sourceDomain = source.domain;
      const unlinked: string[] = [];
      for (const target of filteredTargets) {
        // No self-links
        if (target.name === source.title) continue;

        // Skip if already linked in body
        if (bodyLinks.has(target.name.toLowerCase())) continue;

        // Skip if linking would violate scope (e.g. public→private)
        if (target.domains.length > 0 && target.domains.every((d) => !canLink(sourceDomain, d, registry))) continue;

        // Word-boundary match, case-insensitive
        const escaped = target.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(?<![\\[\\w])${escaped}(?![\\]\\w])`, "i");

        if (re.test(stripped)) {
          unlinked.push(target.name);
        }
      }

      if (unlinked.length > 0) {
        issues.push({
          check: "underlinked",
          severity: "improvement",
          file: source.path,
          message: `${unlinked.length} vault note${unlinked.length > 1 ? "s" : ""} mentioned but not linked: ${unlinked.slice(0, 5).join(", ")}${unlinked.length > 5 ? ` (+${unlinked.length - 5} more)` : ""}`,
          fixable: true,
        });
      }

      // Per-genre lead-link rule. The conventions.json file lets a vault
      // declare that some genres don't need this check (skip), need a strict
      // Summary section (strict), or just need links somewhere in the lead
      // paragraphs (lenient — handbook/tutorial style, where strict is noise).
      const genre = matchGenre(parsed, config.vaultPath, conventions);
      const leadLinkMode = genre.rules["lead-link"];
      const summaryHeadings = conventions.checks["lead-link"]["summary-headings"];
      const headingPattern = summaryHeadings
        .map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      // Always also accept "Core Contribution" — historical paper-note default.
      const summaryRegex = new RegExp(
        `^##\\s+(?:${headingPattern}|Core Contribution)\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\n$|$)`,
        "m",
      );

      if (leadLinkMode === "strict") {
        const summaryMatch = body.match(summaryRegex);
        if (summaryMatch) {
          const summaryLinks = extractWikilinks(summaryMatch[1]);
          if (summaryLinks.length === 0 && summaryMatch[1].trim().length > 100) {
            issues.push({
              check: "underlinked",
              severity: "suggestion",
              file: source.path,
              message: `Summary section has no inline wikilinks — front-load links to key concepts and related work`,
              fixable: true,
            });
          }
        }
      } else if (leadLinkMode === "lenient") {
        // Either an explicit summary OR the lead paragraphs need to carry
        // some inline links. If both are empty, the note's opening is link-poor.
        const summaryMatch = body.match(summaryRegex);
        const summaryLinkCount = summaryMatch
          ? extractWikilinks(summaryMatch[1]).length
          : 0;
        if (summaryLinkCount === 0) {
          const leadParaCount = conventions.checks["lead-link"]["lenient-paragraphs"];
          const paragraphs = body
            .split(/\n{2,}/)
            .map((p) => p.trim())
            .filter((p) => p.length > 0 && !p.startsWith("#") && !p.startsWith("```"));
          const lead = paragraphs.slice(0, leadParaCount).join("\n\n");
          if (lead.length > 200 && extractWikilinks(lead).length === 0) {
            issues.push({
              check: "underlinked",
              severity: "suggestion",
              file: source.path,
              message: `Lead paragraphs have no inline wikilinks — front-load links to key concepts (genre: ${genre.name})`,
              fixable: true,
            });
          }
        }
      }

      // Check frontmatter-body coherence (both directions).
      // Resolve frontmatter concepts to canonical names so an alias in
      // frontmatter (e.g. `LM`) is treated the same as a body link to its
      // canonical target (`Layered Memory`).
      const fmConcepts = extractFrontmatterWikilinks(parsed.frontmatter.concepts);
      const fmConceptCanonical = new Map<string, string>();
      for (const c of fmConcepts) {
        const key = normalizeWikilinkTarget(c);
        const canon = key ? nameIndex.get(key)?.toLowerCase() : null;
        if (canon) fmConceptCanonical.set(c, canon);
      }

      // Direction 1: frontmatter concept with no inline body link
      if (fmConcepts.length > 0) {
        const notInBody = fmConcepts.filter((c) => {
          const canon = fmConceptCanonical.get(c);
          if (!canon) return false; // unresolvable — caught by `unresolved` check
          return !bodyLinks.has(canon);
        });
        if (notInBody.length > 0) {
          issues.push({
            check: "underlinked",
            severity: "suggestion",
            file: source.path,
            message: `${notInBody.length} frontmatter concept${notInBody.length > 1 ? "s" : ""} with no inline body link: ${notInBody.slice(0, 5).join(", ")}${notInBody.length > 5 ? ` (+${notInBody.length - 5} more)` : ""}`,
            fixable: true,
          });
        }
      }

      // Direction 2: body wikilink to concept note not in frontmatter
      const conceptNameSet = new Set(conceptIndex.map((c) => c.name.toLowerCase()));
      const fmConceptLower = new Set(fmConceptCanonical.values());
      const bodyConceptLinks = [...bodyLinks].filter((link) => conceptNameSet.has(link) && !fmConceptLower.has(link));
      if (bodyConceptLinks.length > 0) {
        issues.push({
          check: "underlinked",
          severity: "suggestion",
          file: source.path,
          message: `${bodyConceptLinks.length} body wikilink${bodyConceptLinks.length > 1 ? "s" : ""} to concept notes not in frontmatter: ${bodyConceptLinks.slice(0, 5).join(", ")}${bodyConceptLinks.length > 5 ? ` (+${bodyConceptLinks.length - 5} more)` : ""}`,
          fixable: true,
        });
      }
    } catch {
      // Skip unparseable files
    }
  }
}

// === Check: cluster cohesion ===
// A folder collecting ≥3 notes implies a topical cluster. If none of those
// notes link to each other, the cluster is a junk drawer — its members exist
// in the same physical location but aren't woven together as a knowledge
// graph. Surface as a suggestion so the user can either add cross-references
// or split the folder.
if (shouldRun("cluster-cohesion")) {
  const folderMap = new Map<string, SourceNote[]>();
  for (const s of sourceIndex) {
    const folder = dirname(s.path);
    if (!folderMap.has(folder)) folderMap.set(folder, []);
    folderMap.get(folder)!.push(s);
  }

  for (const [folder, sources] of folderMap) {
    if (sources.length < 3) continue;

    const folderTitles = new Set(sources.map((s) => s.title.toLowerCase()));
    let hasInternalLink = false;

    for (const source of sources) {
      try {
        const parsed = parseNote(source.path, config.vaultPath);
        const allLinks = [
          ...extractWikilinks(parsed.body),
          ...extractAllFrontmatterLinks(parsed.frontmatter),
        ];
        for (const link of allLinks) {
          const key = normalizeWikilinkTarget(link);
          if (!key) continue;
          const canonical = nameIndex.get(key);
          if (!canonical) continue;
          const canonLower = canonical.toLowerCase();
          if (canonLower === source.title.toLowerCase()) continue;
          if (folderTitles.has(canonLower)) {
            hasInternalLink = true;
            break;
          }
        }
        if (hasInternalLink) break;
      } catch { /* skip unparseable */ }
    }

    if (!hasInternalLink) {
      const folderRel = relative(config.vaultPath, folder);
      issues.push({
        check: "cluster-cohesion",
        severity: "suggestion",
        file: sources[0].path,
        message: `Folder "${folderRel}" has ${sources.length} notes but no wikilinks between them — add cross-references or split the cluster`,
        fixable: false,
      });
    }
  }
}

// === Check: bridge-thinness ===
// A bridge (concept appearing in ≥2 domains) carries cross-domain navigation
// load. If its body is anemic relative to the load, the bridge is structurally
// promising but informationally empty. Stratify by scope so a thin bridge
// reachable only from private sources can be deprioritized.
if (shouldRun("bridge-thinness")) {
  // Pre-compute scope-stratified backlinks per concept from the source index.
  const conceptByName = new Map(conceptIndex.map((c) => [c.name, c]));
  const publicLoad = new Map<string, number>();
  const privateLoad = new Map<string, number>();
  for (const source of sourceIndex) {
    for (const conceptName of source.concepts) {
      const concept = conceptByName.get(conceptName);
      if (!concept) continue;
      // Reachable iff source can link to at least one of the concept's domains
      const reachable =
        concept.domains.length === 0 ||
        concept.domains.some((d) => canLink(source.domain, d, registry));
      if (!reachable) continue;
      const bucket = source.scope === "public" ? publicLoad : privateLoad;
      bucket.set(conceptName, (bucket.get(conceptName) ?? 0) + 1);
    }
  }

  for (const concept of conceptIndex) {
    if (concept.domains.length < 2) continue;

    // Body word count: strip frontmatter, headings, wikilinks, then count words.
    let bodyWordCount = 0;
    try {
      const parsed = parseNote(concept.path, config.vaultPath);
      const stripped = parsed.body
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`]+`/g, " ")
        .replace(/^#{1,6}\s+.*$/gm, " ")
        .replace(/\[\[[^\[\]]+\]\]/g, " ");
      bodyWordCount = stripped.split(/\s+/).filter((w) => w.length > 0).length;
    } catch {
      continue;
    }

    const pubBL = publicLoad.get(concept.name) ?? 0;
    const privBL = privateLoad.get(concept.name) ?? 0;
    const dCount = concept.domains.length;

    const thin = (backlinks: number): boolean => {
      if (backlinks < 3) return false;
      return bodyWordCount / (backlinks * dCount) < 15;
    };

    const pubThin = thin(pubBL);
    const privThin = thin(privBL);
    if (!pubThin && !privThin) continue;

    const reachableOnlyPrivately = pubBL === 0 && privBL > 0;
    const stratum = pubThin && privThin
      ? `thin under public AND private load (public=${pubBL}, private=${privBL}, words=${bodyWordCount})`
      : pubThin
        ? `thin under public load (backlinks=${pubBL}, words=${bodyWordCount})`
        : `thin under private load (backlinks=${privBL}, words=${bodyWordCount})`;

    issues.push({
      check: "bridge-thinness",
      severity: "improvement",
      file: concept.path,
      message: `Bridge "${concept.name}" spans ${dCount} domains but is ${stratum}`,
      fixable: false,
      ...(reachableOnlyPrivately ? { scope: "private" as const } : {}),
    });
  }
}

// === Check: weak-summary ===
// A source's ## Summary is the front-page hook — if it carries no wikilinks
// at all, the note enters the graph cold. Suggestion only. Notes without a
// Summary section are a different shape of problem (not flagged here).
if (shouldRun("weak-summary")) {
  const summaryRegex =
    /^##\s+Summary\s*\n([\s\S]*?)(?=\n##\s|\n$|$)/m;
  for (const source of sourceIndex) {
    try {
      const parsed = parseNote(source.path, config.vaultPath);
      const m = parsed.body.match(summaryRegex);
      if (!m) continue;
      const summaryBody = m[1];
      if (extractWikilinks(summaryBody).length === 0) {
        issues.push({
          check: "weak-summary",
          severity: "suggestion",
          file: source.path,
          message: `Summary section has no wikilinks — front-load links to key concepts`,
          fixable: true,
        });
      }
    } catch {
      // skip
    }
  }
}

// === Check: cross-scope-bridge ===
// A concept backlinked by both public and private sources is an
// information-leakage surface — a public reader following the concept page
// sees the private side's adjacency. Not a violation, but worth surfacing.
if (shouldRun("cross-scope-bridge")) {
  const pubCount = new Map<string, number>();
  const privCount = new Map<string, number>();
  for (const source of sourceIndex) {
    const bucket = source.scope === "public" ? pubCount : privCount;
    for (const conceptName of source.concepts) {
      bucket.set(conceptName, (bucket.get(conceptName) ?? 0) + 1);
    }
  }
  for (const concept of conceptIndex) {
    const p = pubCount.get(concept.name) ?? 0;
    const q = privCount.get(concept.name) ?? 0;
    if (p > 0 && q > 0) {
      issues.push({
        check: "cross-scope-bridge",
        severity: "suggestion",
        file: concept.path,
        message: `Concept "${concept.name}" is backlinked by ${p} public and ${q} private source${q > 1 ? "s" : ""} — leakage surface`,
        fixable: false,
      });
    }
  }
}

// === Check: concept density without source-to-source links ===
// A source note's concepts: frontmatter array signals topical breadth. If a note covers
// many concepts but rarely wikilinks to other source notes, it's an isolated hub —
// candidate for manual `commonplace deep-link` review. Lets the user decide when
// embedding-based candidate surfacing is worth the Ollama call, instead of running
// it implicitly. DCI's coverage_all evidence motivates surfacing link-density gaps.
if (shouldRun("concept-density-without-source-links")) {
  const sourceTitles = new Set(sourceIndex.map((s) => s.title.toLowerCase()));
  for (const source of sourceIndex) {
    const conceptCount = source.concepts.length;
    if (conceptCount < 5) continue;
    try {
      const parsed = parseNote(source.path, config.vaultPath);
      let outboundSourceLinks = 0;
      for (const link of extractWikilinks(parsed.body)) {
        const key = normalizeWikilinkTarget(link);
        if (!key) continue;
        const canonical = (nameIndex.get(key) ?? key).toLowerCase();
        if (canonical === source.title.toLowerCase()) continue; // no self-links count
        if (sourceTitles.has(canonical)) outboundSourceLinks++;
      }
      if (outboundSourceLinks < 2) {
        issues.push({
          check: "concept-density-without-source-links",
          severity: "suggestion",
          file: source.path,
          message: `${conceptCount} concepts in frontmatter but only ${outboundSourceLinks} outbound link${outboundSourceLinks === 1 ? "" : "s"} to other sources — consider \`commonplace deep-link --note "${source.path}"\` to surface paraphrase-level connections`,
          fixable: false,
        });
      }
    } catch {
      // Skip unreadable
    }
  }
}

// --rank-by-traffic: sort stub findings by stub concept's backlinkCount desc.
// High-traffic stubs are the highest-leverage targets for compilation work.
if (values["rank-by-traffic"]) {
  const stubBacklinks = new Map<string, number>();
  for (const c of conceptIndex) stubBacklinks.set(c.path, c.backlinkCount);
  const stubFindings = issues.filter((i) => i.check === "stubs");
  const others = issues.filter((i) => i.check !== "stubs");
  stubFindings.sort((a, b) => (stubBacklinks.get(b.file) ?? 0) - (stubBacklinks.get(a.file) ?? 0));
  issues.length = 0;
  issues.push(...others, ...stubFindings);
}

// Build result
const result: LintResult = {
  critical: issues.filter((i) => i.severity === "critical"),
  improvement: issues.filter((i) => i.severity === "improvement"),
  suggestion: issues.filter((i) => i.severity === "suggestion"),
  summary: {
    total: issues.length,
    critical: issues.filter((i) => i.severity === "critical").length,
    fixable: issues.filter((i) => i.fixable).length,
  },
};

if (values.instruct && result.summary.total > 0) {
  const lines: string[] = [];
  lines.push(`Vault health: ${result.summary.total} issues (${result.summary.critical} critical, ${result.summary.fixable} fixable).`);
  const mechanicalFixable = issues.filter(i => i.fixable && i.check !== "underlinked").length;
  if (mechanicalFixable > 0) {
    lines.push(`Dispatch the wiki-linter agent to fix ${mechanicalFixable} mechanical issues (malformed dates, stale MOC counts, duplicates).`);
  }
  if (result.critical.length > 0) {
    const unresolvedCount = result.critical.filter(i => i.check === "unresolved").length;
    const fmCount = result.critical.filter(i => i.check === "frontmatter").length;
    if (unresolvedCount > 0) lines.push(`${unresolvedCount} broken wikilinks need review.`);
    if (fmCount > 0) lines.push(`${fmCount} frontmatter validation errors.`);
  }
  const stubCount = result.improvement.filter(i => i.check === "stubs").length;
  if (stubCount > 0) {
    lines.push(`${stubCount} concept stubs need definitions — offer to run wiki-compile.`);
  }
  const underlinkCount = result.improvement.filter(i => i.check === "underlinked").length;
  if (underlinkCount > 0) {
    lines.push(`${underlinkCount} notes have vault note mentions without inline wikilinks — run \`commonplace link\` to fix.`);
  }
  const sparseSummaryCount = result.suggestion.filter(i => i.check === "underlinked" && i.message.includes("Summary section")).length;
  if (sparseSummaryCount > 0) {
    lines.push(`${sparseSummaryCount} notes have summary sections with no inline links — front-load links to key concepts and related work.`);
  }
  const fmCoherenceCount = result.suggestion.filter(i => i.check === "underlinked" && i.message.includes("frontmatter concept")).length;
  if (fmCoherenceCount > 0) {
    lines.push(`${fmCoherenceCount} notes have frontmatter concepts with no inline body link — run \`commonplace link\` or \`commonplace deep-link\` to resolve.`);
  }
  const cohesionCount = result.suggestion.filter(i => i.check === "cluster-cohesion").length;
  if (cohesionCount > 0) {
    lines.push(`${cohesionCount} folder${cohesionCount > 1 ? "s have" : " has"} ≥3 notes with no wikilinks between them — review for missing cross-references or whether the cluster should be split.`);
  }
  lines.push(`Report this summary to the user and take the actions above.`);
  console.log(lines.join("\n"));
} else if (values.instruct) {
  // Clean vault, say nothing
} else if (values.json) {
  console.log(JSON.stringify(result));
} else {
  // Human-readable summary (default)
  if (result.summary.total === 0) {
    console.log("Vault clean: 0 issues");
  } else {
    console.log(`Critical: ${result.summary.critical}  |  Improvement: ${result.improvement.length}  |  Suggestion: ${result.suggestion.length}  |  Total: ${result.summary.total}`);
    // Group criticals by check
    const checks: Record<string, number> = {};
    for (const i of result.critical) {
      checks[i.check] = (checks[i.check] || 0) + 1;
    }
    if (Object.keys(checks).length > 0) {
      for (const [k, v] of Object.entries(checks).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k}: ${v}`);
      }
    }
  }
}
