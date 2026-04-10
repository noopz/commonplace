#!/usr/bin/env tsx
/**
 * Verify analysis completeness and quality (0-100 score).
 * Usage: npx tsx scripts/paper/quality-check.ts <analysis-file> [--min-score 60]
 */

import { readFileSync } from "fs";
import { parseArgs } from "util";
import type { QualityScore } from "./lib/types.js";

const { values, positionals } = parseArgs({
  options: {
    "min-score": { type: "string", default: "60" },
    format: { type: "string", default: "json" },
  },
  allowPositionals: true,
});

const filePath = positionals[0];
if (!filePath) {
  console.error("Usage: npx tsx scripts/paper/quality-check.ts <analysis-file>");
  process.exit(1);
}

const minScore = parseInt(values["min-score"]!, 10);
const content = readFileSync(filePath, "utf-8");

const checks: QualityScore["checks"] = [];
const warnings: string[] = [];
const errors: string[] = [];

// Required sections (5 points each)
const requiredSections = [
  { name: "Core Contribution", pattern: /##\s*Core\s*Contribution/i },
  { name: "Background", pattern: /##\s*(?:Background|Motivation)/i },
  { name: "Methodology", pattern: /##\s*(?:Methodology|Method|Approach)/i },
  { name: "Results", pattern: /##\s*(?:Results|Findings)/i },
  { name: "Implications", pattern: /##\s*(?:Implications|Impact)/i },
  { name: "Limitations", pattern: /##\s*(?:Limitations|Open\s*Questions)/i },
  { name: "Key Takeaways", pattern: /##\s*Key\s*Takeaways/i },
  { name: "Critical Assessment", pattern: /##\s*Critical\s*Assessment/i },
  { name: "Metadata", pattern: /##\s*Metadata/i },
  { name: "Connections", pattern: /##\s*(?:Connections|Related)/i },
];

for (const section of requiredSections) {
  const found = section.pattern.test(content);
  checks.push({ name: section.name, passed: found, points: found ? 5 : 0 });
  if (!found && ["Core Contribution", "Results", "Methodology"].includes(section.name)) {
    errors.push(`Missing critical section: ${section.name}`);
  }
}

// Content depth checks (5 points each)
const depthChecks = [
  { name: "Contains percentages/numbers", pattern: /\d+(?:\.\d+)?%/ },
  { name: "Contains figure references", pattern: /(?:Figure|Fig\.?)\s*\d+/i },
  { name: "Contains table references", pattern: /Table\s*\d+/i },
  { name: "Contains specific metrics", pattern: /(?:accuracy|F1|BLEU|ROUGE|precision|recall|AUC|Sharpe)/i },
  { name: "Contains comparisons", pattern: /(?:outperform|baseline|compared\s+to|improvement|better\s+than)/i },
];

for (const check of depthChecks) {
  const found = check.pattern.test(content);
  checks.push({ name: check.name, passed: found, points: found ? 5 : 0 });
}

// Warning patterns
const warningPatterns = [
  { pattern: /TODO/gi, msg: "Contains TODO items" },
  { pattern: /\[(?:placeholder|TBD|TBA)\]/gi, msg: "Contains placeholders" },
  { pattern: /\.{3,}/g, msg: "Contains ellipsis (possible incomplete sections)" },
  { pattern: /\[Paper Title\]/g, msg: "Contains unfilled template fields" },
];

for (const wp of warningPatterns) {
  const matches = content.match(wp.pattern);
  if (matches && matches.length > 0) {
    warnings.push(`${wp.msg} (${matches.length} occurrences)`);
  }
}

// Word count check
const wordCount = content.split(/\s+/).length;
if (wordCount < 500) {
  errors.push(`Analysis too short: ${wordCount} words (minimum 500)`);
} else if (wordCount < 1000) {
  warnings.push(`Analysis is brief: ${wordCount} words (recommended 2000+)`);
}
checks.push({
  name: "Adequate length",
  passed: wordCount >= 1000,
  points: wordCount >= 2000 ? 10 : wordCount >= 1000 ? 5 : 0,
});

// Section count
const sectionCount = (content.match(/^##\s/gm) || []).length;
checks.push({
  name: "Sufficient sections",
  passed: sectionCount >= 5,
  points: sectionCount >= 8 ? 5 : sectionCount >= 5 ? 3 : 0,
});

// Calculate score
let score = checks.reduce((sum, c) => sum + c.points, 0);
score -= warnings.length * 2;
score -= errors.length * 10;
score = Math.max(0, Math.min(100, score));

const grade: QualityScore["grade"] =
  score >= 80 ? "EXCELLENT" :
  score >= 60 ? "GOOD" :
  score >= 40 ? "ACCEPTABLE" :
  "NEEDS_IMPROVEMENT";

const result: QualityScore = {
  score,
  passed: score >= minScore,
  grade,
  checks,
  warnings,
  errors,
};

console.log(JSON.stringify(result));
