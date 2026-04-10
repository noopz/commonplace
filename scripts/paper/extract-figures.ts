#!/usr/bin/env tsx
/**
 * Extract figure/table captions from PDFs.
 * Note: Image extraction requires canvas (optional). This script focuses on caption catalog.
 * Usage: npx tsx scripts/paper/extract-figures.ts <pdf-path> [--format json|human]
 */

import { parseArgs } from "util";
import { extractPages, getPdfInfo } from "./lib/pdf.js";

const { values, positionals } = parseArgs({
  options: {
    format: { type: "string", default: "json" },
  },
  allowPositionals: true,
});

const pdfPath = positionals[0];
if (!pdfPath) {
  console.error("Usage: npx tsx scripts/paper/extract-figures.ts <pdf-path>");
  process.exit(1);
}

const info = await getPdfInfo(pdfPath);
const allPages = await extractPages(pdfPath, 1, info.totalPages);
const fullText = allPages.map((p) => `[Page ${p.pageNumber}]\n${p.text}`).join("\n");

// Extract figure captions
const figureCaptions: { number: string; caption: string; page: number }[] = [];
const figureRegex = /(?:Figure|Fig\.?)\s*(\d+)[.:]\s*(.+?)(?:\n|$)/gi;
let match;
while ((match = figureRegex.exec(fullText)) !== null) {
  // Find which page this was on
  const beforeMatch = fullText.slice(0, match.index);
  const pageMatch = beforeMatch.match(/\[Page (\d+)\]/g);
  const page = pageMatch ? parseInt(pageMatch[pageMatch.length - 1].match(/\d+/)![0], 10) : 0;

  figureCaptions.push({
    number: match[1],
    caption: match[2].trim(),
    page,
  });
}

// Extract table captions
const tableCaptions: { number: string; caption: string; page: number }[] = [];
const tableRegex = /Table\s*(\d+)[.:]\s*(.+?)(?:\n|$)/gi;
while ((match = tableRegex.exec(fullText)) !== null) {
  const beforeMatch = fullText.slice(0, match.index);
  const pageMatch = beforeMatch.match(/\[Page (\d+)\]/g);
  const page = pageMatch ? parseInt(pageMatch[pageMatch.length - 1].match(/\d+/)![0], 10) : 0;

  tableCaptions.push({
    number: match[1],
    caption: match[2].trim(),
    page,
  });
}

const result = {
  totalPages: info.totalPages,
  figures: { count: figureCaptions.length, captions: figureCaptions },
  tables: { count: tableCaptions.length, captions: tableCaptions },
};

if (values.format === "human") {
  console.log(`Figures: ${figureCaptions.length}`);
  for (const f of figureCaptions) {
    console.log(`  Fig ${f.number} (p${f.page}): ${f.caption.slice(0, 80)}`);
  }
  console.log(`\nTables: ${tableCaptions.length}`);
  for (const t of tableCaptions) {
    console.log(`  Table ${t.number} (p${t.page}): ${t.caption.slice(0, 80)}`);
  }
} else {
  console.log(JSON.stringify(result));
}
