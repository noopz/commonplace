#!/usr/bin/env tsx
/**
 * Download papers from arXiv, HuggingFace, or direct URLs.
 * Usage: npx tsx scripts/paper/fetch-paper.ts <url-or-arxiv-id> [--output-dir <dir>]
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { parseArgs } from "util";
import { getPdfInfo } from "./lib/pdf.js";

const { values, positionals } = parseArgs({
  options: {
    "output-dir": { type: "string", default: "/tmp/papers" },
  },
  allowPositionals: true,
});

const input = positionals[0];
if (!input) {
  console.error("Usage: npx tsx scripts/paper/fetch-paper.ts <url-or-arxiv-id> [--output-dir <dir>]");
  process.exit(1);
}

const outputDir = values["output-dir"] || "/tmp/papers";
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

// Detect source type
function extractArxivId(input: string): string | null {
  // Match patterns: 2501.12345, arxiv.org/abs/2501.12345, arXiv:2501.12345
  const patterns = [
    /(?:arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})/i,
    /arXiv:(\d{4}\.\d{4,5})/i,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

function extractHfId(input: string): string | null {
  const m = input.match(/huggingface\.co\/papers\/(\d{4}\.\d{4,5})/);
  return m ? m[1] : null;
}

async function downloadPdf(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "commonplace-paper-analyzer/1.0" },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(outputPath, buffer);
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 100);
}

// Main logic
let pdfUrl: string;
let suggestedName: string;

const arxivId = extractArxivId(input) || extractHfId(input);
if (arxivId) {
  pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
  suggestedName = `arxiv_${arxivId}`;
} else if (input.startsWith("http")) {
  pdfUrl = input;
  suggestedName = basename(new URL(input).pathname, ".pdf") || "paper";
} else {
  console.error("Could not determine paper source from input:", input);
  process.exit(1);
}

const tempPath = join(outputDir, `${suggestedName}.pdf`);

console.error(`Downloading: ${pdfUrl}`);
await downloadPdf(pdfUrl, tempPath);

// Try to extract title for better naming
let finalPath = tempPath;
try {
  const info = await getPdfInfo(tempPath);
  if (info.metadata.title && info.metadata.title.length > 5) {
    const betterName = sanitizeFilename(info.metadata.title);
    finalPath = join(outputDir, `${betterName}.pdf`);
    if (finalPath !== tempPath && !existsSync(finalPath)) {
      const { renameSync } = await import("fs");
      renameSync(tempPath, finalPath);
    } else {
      finalPath = tempPath;
    }
  }
} catch {
  // Keep temp path
}

const result = {
  status: "ok",
  path: finalPath,
  arxivId,
  url: pdfUrl,
};

console.log(JSON.stringify(result));
