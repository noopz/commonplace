#!/usr/bin/env tsx
/**
 * Vault health audit. Runs deterministic checks on all notes.
 * Usage: npx tsx scripts/lint.ts --vault <path> [--check <name>]
 */

import { readFileSync } from "fs";
import { basename } from "path";
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
} from "./lib/domain.js";
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
  },
});

const config = resolveVault(values.vault);
const registry = loadDomainRegistry(config.wikiPath);
const wikiConfig = loadWikiConfig(config);
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
const allNoteNames = new Set(
  allFiles.map((f) => basename(f, ".md"))
);

const checksToRun = values.check ? [values.check] : [
  "unresolved",
  "stubs",
  "orphans",
  "frontmatter",
  "moc-staleness",
  "scope-violations",
  "duplicates",
  "malformed-dates",
  "near-duplicate-names",
  "malformed-concept-names",
  "underlinked",
];

function shouldRun(check: string): boolean {
  return checksToRun.includes(check);
}

/// Files excluded from wikilink resolution — CLAUDE.md is a schema doc, not a vault note.
// Additional exclusions can be configured in .wiki/config.json (lintExclude: string[]).
function isLintExcluded(filePath: string, exclude: string[] = []): boolean {
  if (/\/CLAUDE\.md$/.test(filePath)) return true;
  return exclude.some((pattern) => filePath.includes(pattern));
}

// === Check: unresolved wikilinks ===
if (shouldRun("unresolved")) {
  for (const filePath of allFiles) {
    if (isLintExcluded(filePath, lintExclude)) continue;
    try {
      const parsed = parseNote(filePath, config.vaultPath);
      const bodyLinks = extractWikilinks(parsed.body);
      const fmLinks = extractAllFrontmatterLinks(parsed.frontmatter);
      const allLinks = [...new Set([...bodyLinks, ...fmLinks])];

      for (const link of allLinks) {
        if (!allNoteNames.has(link)) {
          issues.push({
            check: "unresolved",
            severity: "critical",
            file: filePath,
            message: `Broken wikilink: [[${link}]]`,
            fixable: false,
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
  // Build lookup of all linkable vault note names
  // Concepts (skip stubs — no definition to link to)
  const linkTargets: { name: string; type: string }[] = conceptIndex
    .filter((c) => !c.isStub)
    .map((c) => ({ name: c.name, type: "concept" }));

  // Source notes — use title from index
  for (const s of sourceIndex) {
    linkTargets.push({ name: s.title, type: "source" });
  }

  // MOC notes
  for (const m of mocIndex) {
    linkTargets.push({ name: m.name, type: "moc" });
  }

  // Sort longest-first so "FinMem: A Performance-Enhanced..." matches before "FinMem"
  // and we don't double-count
  linkTargets.sort((a, b) => b.name.length - a.name.length);

  // Skip very short names (<=2 chars) that would false-positive on abbreviations
  const filteredTargets = linkTargets.filter((t) => t.name.length > 2);

  for (const source of sourceIndex) {
    try {
      const parsed = parseNote(source.path, config.vaultPath);
      const body = parsed.body;
      const bodyLinks = new Set(extractWikilinks(body).map((l) => l.toLowerCase()));

      // Strip existing wikilinks, code blocks, and headings before searching
      const stripped = body
        .replace(/\[\[[^\]]+\]\]/g, "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]+`/g, "")
        .replace(/^#{1,3}\s+.+$/gm, "");

      const unlinked: string[] = [];
      for (const target of filteredTargets) {
        // No self-links
        if (target.name === source.title) continue;

        // Skip if already linked in body
        if (bodyLinks.has(target.name.toLowerCase())) continue;

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

      // Check if the Summary/lead section has inline links
      const summaryMatch = body.match(/^##\s+(?:Summary|Core Contribution|Overview)\s*\n([\s\S]*?)(?=\n##\s|\n$|$)/m);
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

      // Check frontmatter-body coherence: concepts in frontmatter without inline body links
      const fmConcepts = extractFrontmatterWikilinks(parsed.frontmatter.concepts);
      if (fmConcepts.length > 0) {
        const notInBody = fmConcepts.filter((c) => !bodyLinks.has(c.toLowerCase()));
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
    } catch {
      // Skip unparseable files
    }
  }
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
    lines.push(`${underlinkCount} notes have vault note mentions without inline wikilinks — dispatch the wiki-linker agent to fix.`);
  }
  const sparseSummaryCount = result.suggestion.filter(i => i.check === "underlinked" && i.message.includes("Summary section")).length;
  if (sparseSummaryCount > 0) {
    lines.push(`${sparseSummaryCount} notes have summary sections with no inline links — front-load links to key concepts and related work.`);
  }
  const fmCoherenceCount = result.suggestion.filter(i => i.check === "underlinked" && i.message.includes("frontmatter concept")).length;
  if (fmCoherenceCount > 0) {
    lines.push(`${fmCoherenceCount} notes have frontmatter concepts with no inline body link — the wiki-linker or deep-link can resolve.`);
  }
  lines.push(`Report this summary to the user and take the actions above.`);
  console.log(lines.join("\n"));
} else if (values.instruct) {
  // Clean vault, say nothing
} else {
  console.log(JSON.stringify(result));
}
