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
  extractAllFrontmatterLinks,
  isStub,
  hasMalformedDateLine,
  validateFrontmatter,
} from "./lib/frontmatter.js";
import {
  normalizeConceptSlug,
  isMalformedConceptName,
  lookupScope,
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
const registry = loadDomainRegistry(config.claudeMdPath);
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
    if (source.scope !== "hobby") continue;

    // Hobby sources should not reference concepts from other domains
    for (const conceptName of source.concepts) {
      const concept = conceptIndex.find((c) => c.name === conceptName);
      if (!concept) continue;

      for (const cDomain of concept.domains) {
        if (cDomain !== source.domain) {
          const cScope = lookupScope(cDomain, registry);
          if (cScope !== "hobby") continue; // Professional cross-ref is fine
          issues.push({
            check: "scope-violations",
            severity: "critical",
            file: source.path,
            message: `Hobby scope violation: "${source.domain}" references concept "${conceptName}" from hobby domain "${cDomain}"`,
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
  if (result.summary.fixable > 0) {
    lines.push(`Dispatch the wiki-linter agent to fix ${result.summary.fixable} mechanical issues (malformed dates, stale MOC counts, duplicates).`);
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
  lines.push(`Report this summary to the user and take the actions above.`);
  console.log(lines.join("\n"));
} else if (values.instruct) {
  // Clean vault, say nothing
} else {
  console.log(JSON.stringify(result));
}
