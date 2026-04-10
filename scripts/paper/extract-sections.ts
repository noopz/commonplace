#!/usr/bin/env tsx
/**
 * Extract text from specific page ranges of a PDF.
 * Usage: npx tsx scripts/paper/extract-sections.ts <pdf-path> <command> [args...]
 *   Commands:
 *     info              - Get page count and metadata
 *     range <start> <end> - Extract pages
 *     overview          - First + last pages
 */

import { parseArgs } from "util";
import { extractPages, getPdfInfo, estimateTokens } from "./lib/pdf.js";

const { positionals } = parseArgs({ allowPositionals: true });

const pdfPath = positionals[0];
const command = positionals[1];

if (!pdfPath || !command) {
  console.error("Usage: npx tsx scripts/paper/extract-sections.ts <pdf> <info|range|overview> [args]");
  process.exit(1);
}

if (command === "info") {
  const info = await getPdfInfo(pdfPath);
  console.log(JSON.stringify({
    totalPages: info.totalPages,
    metadata: info.metadata,
  }));
} else if (command === "range") {
  const start = parseInt(positionals[2], 10);
  const end = parseInt(positionals[3], 10);
  if (isNaN(start) || isNaN(end)) {
    console.error("range requires start and end page numbers");
    process.exit(1);
  }
  const pages = await extractPages(pdfPath, start, end);
  console.log(JSON.stringify({
    pages: pages.map((p) => ({
      page: p.pageNumber,
      text: p.text,
      tokens: estimateTokens(p.text),
    })),
  }));
} else if (command === "overview") {
  const info = await getPdfInfo(pdfPath);
  const n = Math.min(3, Math.floor(info.totalPages / 3));
  const firstPages = await extractPages(pdfPath, 1, n);
  const lastStart = Math.max(n + 1, info.totalPages - n + 1);
  const lastPages = await extractPages(pdfPath, lastStart, info.totalPages);

  const result = {
    totalPages: info.totalPages,
    firstPages: firstPages.map((p) => ({
      page: p.pageNumber,
      text: p.text,
      tokens: estimateTokens(p.text),
    })),
    lastPages: lastPages.map((p) => ({
      page: p.pageNumber,
      text: p.text,
      tokens: estimateTokens(p.text),
    })),
  };
  console.log(JSON.stringify(result));
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
