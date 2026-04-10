#!/usr/bin/env tsx
/**
 * Detect paper structure via section header matching.
 * Usage: npx tsx scripts/paper/detect-sections.ts <pdf-path> [--format json|human]
 */

import { parseArgs } from "util";
import { extractPages, getPdfInfo } from "./lib/pdf.js";
import type { DetectedSection, SectionDetectionResult } from "./lib/types.js";

const { values, positionals } = parseArgs({
  options: {
    format: { type: "string", default: "json" },
  },
  allowPositionals: true,
});

const pdfPath = positionals[0];
if (!pdfPath) {
  console.error("Usage: npx tsx scripts/paper/detect-sections.ts <pdf-path>");
  process.exit(1);
}

// Section header patterns with importance levels
const SECTION_PATTERNS: {
  pattern: RegExp;
  type: string;
  importance: DetectedSection["importance"];
}[] = [
  { pattern: /^(?:\d+[\.\s]+)?abstract$/i, type: "abstract", importance: "medium" },
  { pattern: /^(?:\d+[\.\s]+)?introduction$/i, type: "introduction", importance: "high" },
  { pattern: /^(?:\d+[\.\s]+)?(?:related\s+work|prior\s+work|literature\s+review)/i, type: "related_work", importance: "medium" },
  { pattern: /^(?:\d+[\.\s]+)?(?:background|preliminaries)/i, type: "background", importance: "medium" },
  { pattern: /^(?:\d+[\.\s]+)?(?:method|methodology|approach|proposed\s+(?:method|approach|framework|model))/i, type: "methods", importance: "critical" },
  { pattern: /^(?:\d+[\.\s]+)?(?:model|architecture|framework|system\s+design)/i, type: "model", importance: "critical" },
  { pattern: /^(?:\d+[\.\s]+)?(?:experiment|evaluation|empirical)/i, type: "experiments", importance: "critical" },
  { pattern: /^(?:\d+[\.\s]+)?(?:results?|findings)/i, type: "results", importance: "critical" },
  { pattern: /^(?:\d+[\.\s]+)?(?:discussion|analysis)/i, type: "discussion", importance: "high" },
  { pattern: /^(?:\d+[\.\s]+)?(?:ablation|ablation\s+stud)/i, type: "ablation", importance: "high" },
  { pattern: /^(?:\d+[\.\s]+)?(?:conclusion|summary|concluding)/i, type: "conclusion", importance: "high" },
  { pattern: /^(?:\d+[\.\s]+)?(?:references|bibliography)/i, type: "references", importance: "low" },
  { pattern: /^(?:\d+[\.\s]+)?(?:appendix|supplementary)/i, type: "appendix", importance: "low" },
  { pattern: /^(?:\d+[\.\s]+)?(?:acknowledgment|acknowledgement)/i, type: "acknowledgments", importance: "low" },
];

const info = await getPdfInfo(pdfPath);
const pages = await extractPages(pdfPath, 1, info.totalPages);

const rawSections: { type: string; name: string; page: number; importance: DetectedSection["importance"] }[] = [];

for (const page of pages) {
  // Check first 20 lines of each page for section headers
  const lines = page.text.split("\n").slice(0, 20);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 3 || trimmed.length > 80) continue;

    for (const { pattern, type, importance } of SECTION_PATTERNS) {
      if (pattern.test(trimmed)) {
        // Avoid duplicates on same page
        if (!rawSections.some((s) => s.type === type && s.page === page.pageNumber)) {
          rawSections.push({
            type,
            name: trimmed,
            page: page.pageNumber,
            importance,
          });
        }
        break;
      }
    }
  }
}

// Build sections with page ranges
const sections: DetectedSection[] = rawSections.map((s, i) => {
  const nextPage = i + 1 < rawSections.length ? rawSections[i + 1].page : info.totalPages;
  const endPage = nextPage > s.page ? nextPage - 1 : s.page;
  return {
    sectionType: s.type,
    sectionName: s.name,
    startPage: s.page,
    endPage,
    pageCount: endPage - s.page + 1,
    importance: s.importance,
  };
});

// Extend last non-reference section to cover remaining pages before references
const refIdx = sections.findIndex((s) => s.sectionType === "references");
if (refIdx > 0) {
  sections[refIdx - 1].endPage = sections[refIdx].startPage - 1;
  sections[refIdx - 1].pageCount =
    sections[refIdx - 1].endPage - sections[refIdx - 1].startPage + 1;
}

const result: SectionDetectionResult = {
  totalPages: info.totalPages,
  detectedSections: sections,
  sectionCount: sections.length,
};

if (values.format === "human") {
  console.log(`Paper: ${pdfPath}`);
  console.log(`Total pages: ${info.totalPages}`);
  console.log(`Sections found: ${sections.length}\n`);
  console.log("Section".padEnd(25) + "Pages".padEnd(12) + "Importance");
  console.log("-".repeat(50));
  for (const s of sections) {
    console.log(
      s.sectionName.slice(0, 24).padEnd(25) +
        `${s.startPage}-${s.endPage}`.padEnd(12) +
        s.importance
    );
  }
} else {
  console.log(JSON.stringify(result));
}
