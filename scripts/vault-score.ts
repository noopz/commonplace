#!/usr/bin/env tsx
/**
 * Vault quality score — the val_bpb for knowledge bases.
 * Computes a deterministic 0-100 score from indexes, lint, and git state.
 * Zero LLM cost (Tier 1). Appends to .wiki/score-history.json for trend tracking.
 *
 * Usage: npx tsx scripts/vault-score.ts --vault <path> [--verbose]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";
import { execSync } from "child_process";
import { resolveVault, ensureIndex, loadIndexes, findAllNotes } from "./lib/vault.js";
import { parseNote, extractWikilinks } from "./lib/frontmatter.js";
import { buildNameIndex, normalizeWikilinkTarget } from "./lib/resolve.js";
import type {
  LintResult,
  VaultScore,
  VaultScoreDimension,
} from "./lib/types.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    verbose: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

const config = resolveVault(values.vault);

// --- Load indexes ---

if (!ensureIndex(config)) {
  console.error("Indexes not found. Run index.ts first.");
  process.exit(1);
}

let indexes;
try {
  indexes = loadIndexes(config);
} catch {
  console.error("Failed to load indexes.");
  process.exit(1);
}
const { sources: sourceIndex, concepts: conceptIndex, mocs: mocIndex } = indexes;

// --- Run lint via subprocess ---

let lintResult: LintResult | null = null;
try {
  const scriptDir = new URL(".", import.meta.url).pathname;
  const lintOutput = execSync(
    `npx tsx ${scriptDir}lint.ts --vault ${config.vaultPath} --json`,
    { stdio: "pipe", timeout: 60000 }
  );
  lintResult = JSON.parse(lintOutput.toString());
} catch {
  // Lint failed — integrity will score 0
}

// --- Derived counts ---

const classifiedNoteCount =
  sourceIndex.length + conceptIndex.length + mocIndex.length;
const totalConcepts = conceptIndex.length;
const stubConcepts = conceptIndex.filter((c) => c.isStub).length;
const nonStubConcepts = totalConcepts - stubConcepts;
const criticalIssues = lintResult ? lintResult.critical.length : classifiedNoteCount;

// ============================================================
// DIMENSION 1: Integrity (weight: 15)
// ============================================================

const integrityRaw =
  classifiedNoteCount === 0
    ? 1.0
    : Math.max(0, 1 - criticalIssues / classifiedNoteCount);

const integrity: VaultScoreDimension = {
  name: "integrity",
  score: integrityRaw,
  weight: 15,
  weighted: Math.round(integrityRaw * 15 * 10) / 10,
  details: {
    criticalIssues,
    classifiedNotes: classifiedNoteCount,
  },
};

// ============================================================
// DIMENSION 2: Coverage (weight: 15)
// ============================================================

const conceptCoverage =
  totalConcepts === 0 ? 1.0 : nonStubConcepts / totalConcepts;

// Sub-metric: note completeness (fraction of source notes with a Summary section)
let notesWithSummary = 0;
for (const source of sourceIndex) {
  try {
    const parsed = parseNote(source.path, config.vaultPath);
    if (/^##\s+(?:Summary|Core Contribution|Overview)/m.test(parsed.body)) {
      notesWithSummary++;
    }
  } catch {
    // Skip
  }
}
const noteCompleteness =
  sourceIndex.length === 0 ? 1.0 : notesWithSummary / sourceIndex.length;

const coverageRaw = (conceptCoverage + noteCompleteness) / 2;

const coverage: VaultScoreDimension = {
  name: "coverage",
  score: coverageRaw,
  weight: 15,
  weighted: Math.round(coverageRaw * 15 * 10) / 10,
  details: {
    totalConcepts,
    nonStubConcepts,
    stubConcepts,
    conceptCoverage: Math.round(conceptCoverage * 1000) / 1000,
    noteCompleteness: Math.round(noteCompleteness * 1000) / 1000,
    notesWithSummary,
    totalSourceNotes: sourceIndex.length,
  },
};

// ============================================================
// DIMENSION 3: Graph Structure (weight: 10)
// Are notes connected in the graph at all?
// ============================================================

// Sub-metric: backlink density
const totalBacklinks = conceptIndex.reduce(
  (sum, c) => sum + c.backlinkCount,
  0
);
const avgBacklinks = totalConcepts > 0 ? totalBacklinks / totalConcepts : 0;
const backlinkDensity = Math.min(1, avgBacklinks / 3);

// Sub-metric: orphan ratio
const orphanCount = conceptIndex.filter((c) => c.backlinkCount === 0).length;
const orphanRatio =
  totalConcepts === 0 ? 1.0 : 1 - orphanCount / totalConcepts;

// Sub-metric: MOC coverage (fraction of sources with at least one MOC)
const sourcesWithMocs = sourceIndex.filter((s) => s.mocs.length > 0).length;
const mocCoverage =
  sourceIndex.length === 0 ? 1.0 : sourcesWithMocs / sourceIndex.length;

// Sub-metric: concept extraction (fraction of sources with at least one concept)
const sourcesWithConcepts = sourceIndex.filter(
  (s) => s.concepts.length > 0
).length;
const conceptExtraction =
  sourceIndex.length === 0
    ? 1.0
    : sourcesWithConcepts / sourceIndex.length;

// Sub-metric: inline link density (vault note mentions in body that are actually wikilinked)
// Covers concepts (non-stub), source notes, and MOCs.
// 1-char names are too noisy for word-boundary matching; everything else is in.
const linkTargetNames: string[] = [
  ...conceptIndex.filter((c) => !c.isStub).map((c) => c.name),
  ...sourceIndex.map((s) => s.title),
  ...mocIndex.map((m) => m.name),
].filter((n) => n.length >= 2);

// Build a vault-wide name index (filenames + aliases → canonical) so a
// body wikilink to an alias counts as a link to its canonical target.
const allFiles = await findAllNotes(config.vaultPath);
const nameIndex = buildNameIndex(allFiles, config.vaultPath);

function bodyLinkCanonicalSet(body: string): Set<string> {
  const out = new Set<string>();
  for (const link of extractWikilinks(body)) {
    const key = normalizeWikilinkTarget(link);
    if (!key) continue;
    out.add((nameIndex.get(key) ?? key).toLowerCase());
  }
  return out;
}

let totalMentions = 0;
let linkedMentions = 0;

for (const source of sourceIndex) {
  try {
    const parsed = parseNote(source.path, config.vaultPath);
    const body = parsed.body;
    const bodyLinks = bodyLinkCanonicalSet(body);

    // Strip wikilinks (excluding `[` so a malformed `[[` doesn't gobble the
    // text between two real wikilinks), fenced+inline code, indented code
    // blocks, and headings before plain-text scanning.
    const stripped = body
      .replace(/\[\[[^\[\]]+\]\]/g, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]+`/g, "")
      .replace(/^(?: {4,}|\t).*$/gm, "")
      .replace(/^#{1,3}\s+.+$/gm, "");

    for (const name of linkTargetNames) {
      if (name === source.title) continue; // no self-links
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<![\\[\\w])${escaped}(?![\\]\\w])`, "i");
      const isLinked = bodyLinks.has(name.toLowerCase());
      const appearsAsText = re.test(stripped);

      if (isLinked || appearsAsText) {
        totalMentions++;
        if (isLinked) linkedMentions++;
      }
    }
  } catch {
    // Skip unparseable files
  }
}

const inlineLinkDensity =
  totalMentions === 0 ? 1.0 : linkedMentions / totalMentions;

// Sub-metric: summary link coverage (fraction of source notes with links in their summary section)
let summariesWithLinks = 0;
let summariesTotal = 0;

for (const source of sourceIndex) {
  try {
    const parsed = parseNote(source.path, config.vaultPath);
    const summaryMatch = parsed.body.match(
      /^##\s+(?:Summary|Core Contribution|Overview)\s*\n([\s\S]*?)(?=\n##\s|\n$|$)/m
    );
    if (summaryMatch && summaryMatch[1].trim().length > 100) {
      summariesTotal++;
      const summaryLinks = extractWikilinks(summaryMatch[1]);
      if (summaryLinks.length > 0) summariesWithLinks++;
    }
  } catch {
    // Skip
  }
}

const summaryLinkCoverage =
  summariesTotal === 0 ? 1.0 : summariesWithLinks / summariesTotal;

// Sub-metric: frontmatter-body coherence
// For each source note, what fraction of its frontmatter concepts: entries
// have at least one inline [[wikilink]] in the body?
let fmConceptsTotal = 0;
let fmConceptsLinkedInBody = 0;

for (const source of sourceIndex) {
  if (source.concepts.length === 0) continue;
  try {
    const parsed = parseNote(source.path, config.vaultPath);
    // bodyLinks holds canonical lowercase names — same form as source.concepts
    // (which the indexer canonicalizes), so an alias body-link counts as a link
    // to the canonical concept named in frontmatter.
    const bodyLinks = bodyLinkCanonicalSet(parsed.body);

    for (const conceptName of source.concepts) {
      fmConceptsTotal++;
      if (bodyLinks.has(conceptName.toLowerCase())) {
        fmConceptsLinkedInBody++;
      }
    }
  } catch {
    // Skip
  }
}

const frontmatterBodyCoherence =
  fmConceptsTotal === 0 ? 1.0 : fmConceptsLinkedInBody / fmConceptsTotal;

// DIMENSION 3: Graph Structure (weight: 10)
// Are notes connected in the graph at all?
const graphStructureRaw =
  (backlinkDensity + orphanRatio + mocCoverage + conceptExtraction) / 4;

const graphStructure: VaultScoreDimension = {
  name: "graph-structure",
  score: graphStructureRaw,
  weight: 10,
  weighted: Math.round(graphStructureRaw * 10 * 10) / 10,
  details: {
    avgBacklinks: Math.round(avgBacklinks * 100) / 100,
    backlinkDensity: Math.round(backlinkDensity * 1000) / 1000,
    orphanCount,
    orphanRatio: Math.round(orphanRatio * 1000) / 1000,
    mocCoverage: Math.round(mocCoverage * 1000) / 1000,
    conceptExtraction: Math.round(conceptExtraction * 1000) / 1000,
  },
};

// ============================================================
// DIMENSION 4: Inline Linking (weight: 15)
// Are vault note mentions in body text actually wikilinked?
// ============================================================

const inlineLinking: VaultScoreDimension = {
  name: "inline-linking",
  score: inlineLinkDensity,
  weight: 15,
  weighted: Math.round(inlineLinkDensity * 15 * 10) / 10,
  details: {
    inlineLinkDensity: Math.round(inlineLinkDensity * 1000) / 1000,
    linked: linkedMentions,
    total: totalMentions,
    unlinked: totalMentions - linkedMentions,
  },
};

// ============================================================
// DIMENSION 5: Summary Links (weight: 15)
// Do summary/lead sections front-load links to key concepts?
// ============================================================

const summaryLinks: VaultScoreDimension = {
  name: "summary-links",
  score: summaryLinkCoverage,
  weight: 15,
  weighted: Math.round(summaryLinkCoverage * 15 * 10) / 10,
  details: {
    summaryLinkCoverage: Math.round(summaryLinkCoverage * 1000) / 1000,
    withLinks: summariesWithLinks,
    total: summariesTotal,
    withoutLinks: summariesTotal - summariesWithLinks,
  },
};

// ============================================================
// DIMENSION 6: Frontmatter Coherence (weight: 15)
// Do frontmatter concepts have corresponding inline body links?
// ============================================================

const frontmatterCoherence: VaultScoreDimension = {
  name: "frontmatter-coherence",
  score: frontmatterBodyCoherence,
  weight: 15,
  weighted: Math.round(frontmatterBodyCoherence * 15 * 10) / 10,
  details: {
    coherence: Math.round(frontmatterBodyCoherence * 1000) / 1000,
    linked: fmConceptsLinkedInBody,
    total: fmConceptsTotal,
    unlinked: fmConceptsTotal - fmConceptsLinkedInBody,
  },
};

// ============================================================
// DIMENSION 7: Consistency (weight: 5)
// ============================================================

// Sub-metric: MOC count accuracy
const mocsWithCounts = mocIndex.filter((m) => m.declaredCount !== null);
const accurateMocs = mocsWithCounts.filter(
  (m) => m.declaredCount === m.sourceCount
).length;
const mocAccuracy =
  mocsWithCounts.length === 0 ? 1.0 : accurateMocs / mocsWithCounts.length;

// Sub-metric: no duplicates (from lint)
const duplicateCount = lintResult
  ? lintResult.improvement.filter((i) => i.check === "duplicates").length
  : 0;
const noDuplicates =
  classifiedNoteCount === 0
    ? 1.0
    : Math.max(0, 1 - duplicateCount / classifiedNoteCount);

// Sub-metric: no near-duplicate concept names (from lint)
const nearDupCount = lintResult
  ? lintResult.improvement.filter((i) => i.check === "near-duplicate-names")
      .length
  : 0;
const noNearDupes =
  totalConcepts === 0
    ? 1.0
    : Math.max(0, 1 - nearDupCount / totalConcepts);

const consistencyRaw = (mocAccuracy + noDuplicates + noNearDupes) / 3;

const consistency: VaultScoreDimension = {
  name: "consistency",
  score: consistencyRaw,
  weight: 5,
  weighted: Math.round(consistencyRaw * 5 * 10) / 10,
  details: {
    mocAccuracy: Math.round(mocAccuracy * 1000) / 1000,
    duplicateCount,
    nearDuplicateCount: nearDupCount,
  },
};

// ============================================================
// DIMENSION 8: Hygiene (weight: 10) — git-derived
// ============================================================

let hygieneRaw = 0.5; // Default: neutral if no git
const hygieneDetails: Record<string, number> = {};

try {
  // Check if vault is in a git repo
  execSync("git rev-parse --is-inside-work-tree", {
    cwd: config.vaultPath,
    stdio: "pipe",
    timeout: 5000,
  });

  // Get days since last commit
  let daysSinceCommit = 0;
  try {
    const lastCommitTs = parseInt(
      execSync("git log -1 --format=%ct", {
        cwd: config.vaultPath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim(),
      10
    );
    daysSinceCommit = (Date.now() / 1000 - lastCommitTs) / 86400;
  } catch {
    daysSinceCommit = 30; // No commits = max staleness
  }

  const stalenessScore = Math.max(0, 1 - daysSinceCommit / 30);

  hygieneRaw = stalenessScore;
  hygieneDetails.daysSinceCommit = Math.round(daysSinceCommit * 10) / 10;
  hygieneDetails.stalenessScore = Math.round(stalenessScore * 1000) / 1000;
  hygieneDetails.isGitRepo = 1;
} catch {
  // Not a git repo or git not installed
  hygieneDetails.isGitRepo = 0;
}

const hygiene: VaultScoreDimension = {
  name: "hygiene",
  score: hygieneRaw,
  weight: 10,
  weighted: Math.round(hygieneRaw * 10 * 10) / 10,
  details: hygieneDetails,
};

// ============================================================
// COMPOSITE SCORE
// ============================================================

const dimensions = [integrity, coverage, graphStructure, inlineLinking, summaryLinks, frontmatterCoherence, consistency, hygiene];
const totalScore =
  Math.round(dimensions.reduce((sum, d) => sum + d.weighted, 0) * 10) / 10;

const grade =
  totalScore >= 90
    ? "A"
    : totalScore >= 80
      ? "B"
      : totalScore >= 70
        ? "C"
        : totalScore >= 60
          ? "D"
          : "F";

const result: VaultScore = {
  score: totalScore,
  grade,
  dimensions,
  counts: {
    sources: sourceIndex.length,
    concepts: totalConcepts,
    stubs: stubConcepts,
    mocs: mocIndex.length,
    criticalIssues,
  },
  timestamp: new Date().toISOString(),
};

// --- Append to score history ---

const historyPath = join(config.wikiPath, "score-history.json");
try {
  let history: Array<{
    score: number;
    dimensions: Record<string, number>;
    timestamp: string;
  }> = [];

  if (existsSync(historyPath)) {
    history = JSON.parse(readFileSync(historyPath, "utf-8"));
  }

  history.push({
    score: totalScore,
    dimensions: Object.fromEntries(
      dimensions.map((d) => [d.name, d.weighted])
    ),
    timestamp: result.timestamp,
  });

  // Cap at 500 entries
  if (history.length > 500) {
    history = history.slice(history.length - 500);
  }

  writeFileSync(historyPath, JSON.stringify(history, null, 2));
} catch {
  // Score history write failed — non-fatal
}

// --- Output ---

if (values.json || values.verbose) {
  console.log(JSON.stringify(result, values.verbose ? null : undefined, values.verbose ? 2 : undefined));
} else {
  // Human-readable summary (default)
  console.log(`Score: ${totalScore}/100 (${grade}) — ${sourceIndex.length} sources, ${conceptIndex.length} concepts, ${mocIndex.length} MOCs`);
  for (const d of dimensions) {
    console.log(`  ${d.name}: ${d.weighted}/${d.weight}`);
  }
}
