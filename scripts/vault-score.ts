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
import { resolveVault, ensureIndex, loadIndexes } from "./lib/vault.js";
import type {
  LintResult,
  VaultScore,
  VaultScoreDimension,
} from "./lib/types.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    verbose: { type: "boolean", default: false },
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
    `npx tsx ${scriptDir}lint.ts --vault ${config.vaultPath}`,
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
// DIMENSION 1: Integrity (weight: 25)
// ============================================================

const integrityRaw =
  classifiedNoteCount === 0
    ? 1.0
    : Math.max(0, 1 - criticalIssues / classifiedNoteCount);

const integrity: VaultScoreDimension = {
  name: "integrity",
  score: integrityRaw,
  weight: 25,
  weighted: Math.round(integrityRaw * 25 * 10) / 10,
  details: {
    criticalIssues,
    classifiedNotes: classifiedNoteCount,
  },
};

// ============================================================
// DIMENSION 2: Coverage (weight: 25)
// ============================================================

const coverageRaw =
  totalConcepts === 0 ? 1.0 : nonStubConcepts / totalConcepts;

const coverage: VaultScoreDimension = {
  name: "coverage",
  score: coverageRaw,
  weight: 25,
  weighted: Math.round(coverageRaw * 25 * 10) / 10,
  details: {
    totalConcepts,
    nonStubConcepts,
    stubConcepts,
  },
};

// ============================================================
// DIMENSION 3: Connectivity (weight: 20)
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

const connectivityRaw =
  (backlinkDensity + orphanRatio + mocCoverage + conceptExtraction) / 4;

const connectivity: VaultScoreDimension = {
  name: "connectivity",
  score: connectivityRaw,
  weight: 20,
  weighted: Math.round(connectivityRaw * 20 * 10) / 10,
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
// DIMENSION 4: Consistency (weight: 15)
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
  weight: 15,
  weighted: Math.round(consistencyRaw * 15 * 10) / 10,
  details: {
    mocAccuracy: Math.round(mocAccuracy * 1000) / 1000,
    duplicateCount,
    nearDuplicateCount: nearDupCount,
  },
};

// ============================================================
// DIMENSION 5: Hygiene (weight: 15) — git-derived
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

  // Get dirty .md files in content directories only
  const statusOutput = execSync("git status --porcelain", {
    cwd: config.vaultPath,
    stdio: "pipe",
    timeout: 10000,
  }).toString();

  const dirtyMdFiles = statusOutput
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      // Extract file path (skip the 2-char status + space prefix)
      const filePath = line.slice(3).replace(/^"(.*)"$/, "$1");
      // Only count .md files in content dirs (00-99), exclude .obsidian, .wiki, .strata
      return (
        filePath.endsWith(".md") &&
        /^\d{2}\s*-\s/.test(filePath) &&
        !filePath.startsWith(".obsidian/") &&
        !filePath.startsWith(".wiki/") &&
        !filePath.startsWith(".strata/")
      );
    }).length;

  const dirtyRatio =
    classifiedNoteCount === 0
      ? 1.0
      : Math.max(0, 1 - dirtyMdFiles / classifiedNoteCount);

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

  hygieneRaw = (dirtyRatio + stalenessScore) / 2;
  hygieneDetails.dirtyMdFiles = dirtyMdFiles;
  hygieneDetails.dirtyRatio = Math.round(dirtyRatio * 1000) / 1000;
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
  weight: 15,
  weighted: Math.round(hygieneRaw * 15 * 10) / 10,
  details: hygieneDetails,
};

// ============================================================
// COMPOSITE SCORE
// ============================================================

const dimensions = [integrity, coverage, connectivity, consistency, hygiene];
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

if (values.verbose) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(JSON.stringify(result));
}
