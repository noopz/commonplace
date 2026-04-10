#!/usr/bin/env tsx
/**
 * Compare methodologies, results, and research progression across papers.
 * Usage: npx tsx scripts/paper/compare-papers.ts <analysis1.md> <analysis2.md> [...]
 */

import { readFileSync } from "fs";
import { parseArgs } from "util";
import { basename } from "path";

const { values, positionals } = parseArgs({
  options: {
    format: { type: "string", default: "json" },
  },
  allowPositionals: true,
});

if (positionals.length < 2) {
  console.error("Usage: npx tsx scripts/paper/compare-papers.ts <file1> <file2> [...]");
  process.exit(1);
}

interface PaperSummary {
  file: string;
  title: string;
  methodology: string;
  results: string;
  keyContribution: string;
}

function extractSection(content: string, heading: string): string {
  const regex = new RegExp(`##\\s*${heading}[\\s\\S]*?(?=\\n##\\s|$)`, "i");
  const match = content.match(regex);
  return match ? match[0].replace(/^##\s*\S+\s*\n/, "").trim() : "";
}

const papers: PaperSummary[] = positionals.map((filePath) => {
  const content = readFileSync(filePath, "utf-8");
  const titleMatch = content.match(/^#\s+(.+)$/m);

  return {
    file: basename(filePath),
    title: titleMatch ? titleMatch[1] : basename(filePath, ".md"),
    methodology: extractSection(content, "(?:Methodology|Method|Approach)"),
    results: extractSection(content, "(?:Results|Findings)"),
    keyContribution: extractSection(content, "Core\\s*Contribution"),
  };
});

// Compare methodologies
const methodologies = papers.map((p) => ({
  paper: p.title,
  approach: p.methodology.slice(0, 500),
}));

// Collect results
const results = papers.map((p) => ({
  paper: p.title,
  findings: p.results.slice(0, 500),
}));

// Identify research progression (by file order, assumed chronological)
const progression = papers.map((p, i) => ({
  order: i + 1,
  paper: p.title,
  contribution: p.keyContribution.slice(0, 200),
}));

// Find common themes (simple keyword overlap)
const allKeywords = papers.map((p) => {
  const text = `${p.methodology} ${p.results} ${p.keyContribution}`.toLowerCase();
  const words = text.match(/\b[a-z]{4,}\b/g) || [];
  return new Set(words);
});

const commonKeywords: string[] = [];
if (allKeywords.length >= 2) {
  const first = allKeywords[0];
  for (const word of first) {
    if (allKeywords.every((s) => s.has(word))) {
      commonKeywords.push(word);
    }
  }
}

const result = {
  paperCount: papers.length,
  papers: papers.map((p) => ({ title: p.title, file: p.file })),
  methodologies,
  results,
  progression,
  commonThemes: commonKeywords.slice(0, 20),
};

console.log(JSON.stringify(result));
