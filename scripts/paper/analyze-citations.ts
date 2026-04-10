#!/usr/bin/env tsx
/**
 * Map citation network and identify most-cited papers.
 * Usage: npx tsx scripts/paper/analyze-citations.ts <pdf-path> [--top-n 10]
 */

import { parseArgs } from "util";
import { extractPages, getPdfInfo } from "./lib/pdf.js";
import type { CitationAnalysis, CitationInfo } from "./lib/types.js";

const { values, positionals } = parseArgs({
  options: {
    "top-n": { type: "string", default: "10" },
    format: { type: "string", default: "json" },
  },
  allowPositionals: true,
});

const pdfPath = positionals[0];
if (!pdfPath) {
  console.error("Usage: npx tsx scripts/paper/analyze-citations.ts <pdf-path>");
  process.exit(1);
}

const topN = parseInt(values["top-n"]!, 10);
const info = await getPdfInfo(pdfPath);
const allPages = await extractPages(pdfPath, 1, info.totalPages);
const fullText = allPages.map((p) => p.text).join("\n");

// Find references section
let refStartPage = -1;
for (const page of allPages) {
  if (/^(?:\d+[\.\s]+)?references$/im.test(page.text) ||
      /^bibliography$/im.test(page.text)) {
    refStartPage = page.pageNumber;
    break;
  }
}

// Extract references text
const refText = refStartPage > 0
  ? allPages
      .filter((p) => p.pageNumber >= refStartPage)
      .map((p) => p.text)
      .join("\n")
  : "";

// Parse individual references
const references: CitationInfo[] = [];
if (refText) {
  // Split by [N] or N. patterns
  const refEntries = refText.split(/\n(?=\[\d+\]|\d+\.\s)/);
  let refNum = 0;

  for (const entry of refEntries) {
    const trimmed = entry.trim();
    if (trimmed.length < 10) continue;

    refNum++;
    const numMatch = trimmed.match(/^\[(\d+)\]/);
    const actualNum = numMatch ? parseInt(numMatch[1], 10) : refNum;

    // Extract author (first capitalized word sequence)
    const authorMatch = trimmed.match(/(?:\[\d+\]\s*)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
    const author = authorMatch ? authorMatch[1] : null;

    // Extract year
    const yearMatch = trimmed.match(/\b((?:19|20)\d{2})\b/);
    const year = yearMatch ? yearMatch[1] : null;

    // Extract arXiv ID
    const arxivMatch = trimmed.match(/(\d{4}\.\d{4,5})/);
    const arxivId = arxivMatch ? arxivMatch[1] : null;

    references.push({
      referenceNumber: actualNum,
      count: 0,
      fullText: trimmed.slice(0, 300),
      author,
      year,
      arxivId,
    });
  }
}

// Count in-text citations [N]
const citationCounts = new Map<number, number>();
const citationRegex = /\[(\d+)\]/g;
let match;
// Only count citations in body (before references)
const bodyText = refStartPage > 0
  ? allPages
      .filter((p) => p.pageNumber < refStartPage)
      .map((p) => p.text)
      .join("\n")
  : fullText;

while ((match = citationRegex.exec(bodyText)) !== null) {
  const num = parseInt(match[1], 10);
  citationCounts.set(num, (citationCounts.get(num) || 0) + 1);
}

// Merge citation counts with references
for (const ref of references) {
  ref.count = citationCounts.get(ref.referenceNumber) || 0;
}

// Sort by citation count
const keyPapers = [...references]
  .sort((a, b) => b.count - a.count)
  .slice(0, topN);

// Statistics
const years = references
  .map((r) => r.year ? parseInt(r.year, 10) : null)
  .filter((y): y is number => y !== null);

const result: CitationAnalysis = {
  referencesFound: references.length > 0,
  statistics: {
    totalReferences: references.length,
    arxivPapers: references.filter((r) => r.arxivId).length,
    yearRange: years.length > 0 ? `${Math.min(...years)}-${Math.max(...years)}` : "unknown",
    averageYear: years.length > 0 ? Math.round(years.reduce((a, b) => a + b, 0) / years.length) : null,
    totalInTextCitations: [...citationCounts.values()].reduce((a, b) => a + b, 0),
  },
  keyPapers,
  allReferences: references,
};

console.log(JSON.stringify(result));
