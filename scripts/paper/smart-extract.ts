#!/usr/bin/env tsx
/**
 * Intelligently extract critical paper content based on structure.
 * Adapts strategy to paper length: <20 pages (full), 20-50 (critical), 50+ (minimal).
 * Usage: npx tsx scripts/paper/smart-extract.ts <pdf-path> [--plan-only] [--max-tokens 100000]
 */

import { writeFileSync } from "fs";
import { parseArgs } from "util";
import { extractPages, getPdfInfo, estimateTokens } from "./lib/pdf.js";
import type { DetectedSection, ExtractionStrategy, ExtractedContent } from "./lib/types.js";

const { values, positionals } = parseArgs({
  options: {
    "plan-only": { type: "boolean", default: false },
    "max-tokens": { type: "string", default: "100000" },
    save: { type: "string" },
  },
  allowPositionals: true,
});

const pdfPath = positionals[0];
if (!pdfPath) {
  console.error("Usage: npx tsx scripts/paper/smart-extract.ts <pdf-path> [--plan-only] [--max-tokens N]");
  process.exit(1);
}

const maxTokens = parseInt(values["max-tokens"]!, 10);

// Step 1: Get PDF info
const info = await getPdfInfo(pdfPath);
const totalPages = info.totalPages;

// Step 2: Detect sections (inline, same logic as detect-sections.ts)
const SECTION_PATTERNS: {
  pattern: RegExp;
  type: string;
  importance: "critical" | "high" | "medium" | "low";
}[] = [
  { pattern: /^(?:\d+[\.\s]+)?abstract$/i, type: "abstract", importance: "medium" },
  { pattern: /^(?:\d+[\.\s]+)?introduction$/i, type: "introduction", importance: "high" },
  { pattern: /^(?:\d+[\.\s]+)?(?:related\s+work|prior\s+work)/i, type: "related_work", importance: "medium" },
  { pattern: /^(?:\d+[\.\s]+)?(?:background|preliminaries)/i, type: "background", importance: "medium" },
  { pattern: /^(?:\d+[\.\s]+)?(?:method|methodology|approach|proposed)/i, type: "methods", importance: "critical" },
  { pattern: /^(?:\d+[\.\s]+)?(?:model|architecture|framework)/i, type: "model", importance: "critical" },
  { pattern: /^(?:\d+[\.\s]+)?(?:experiment|evaluation)/i, type: "experiments", importance: "critical" },
  { pattern: /^(?:\d+[\.\s]+)?(?:results?|findings)/i, type: "results", importance: "critical" },
  { pattern: /^(?:\d+[\.\s]+)?(?:discussion|analysis)/i, type: "discussion", importance: "high" },
  { pattern: /^(?:\d+[\.\s]+)?(?:ablation)/i, type: "ablation", importance: "high" },
  { pattern: /^(?:\d+[\.\s]+)?(?:conclusion|summary)/i, type: "conclusion", importance: "high" },
  { pattern: /^(?:\d+[\.\s]+)?(?:references|bibliography)/i, type: "references", importance: "low" },
  { pattern: /^(?:\d+[\.\s]+)?(?:appendix|supplementary)/i, type: "appendix", importance: "low" },
];

const allPages = await extractPages(pdfPath, 1, totalPages);
const rawSections: { type: string; name: string; page: number; importance: DetectedSection["importance"] }[] = [];

for (const page of allPages) {
  const lines = page.text.split("\n").slice(0, 20);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 3 || trimmed.length > 80) continue;
    for (const { pattern, type, importance } of SECTION_PATTERNS) {
      if (pattern.test(trimmed)) {
        if (!rawSections.some((s) => s.type === type && s.page === page.pageNumber)) {
          rawSections.push({ type, name: trimmed, page: page.pageNumber, importance });
        }
        break;
      }
    }
  }
}

const sections: DetectedSection[] = rawSections.map((s, i) => {
  const nextPage = i + 1 < rawSections.length ? rawSections[i + 1].page : totalPages;
  return {
    sectionType: s.type,
    sectionName: s.name,
    startPage: s.page,
    endPage: nextPage > s.page ? nextPage - 1 : s.page,
    pageCount: (nextPage > s.page ? nextPage - 1 : s.page) - s.page + 1,
    importance: s.importance,
  };
});

// Step 3: Determine extraction strategy
let strategy: ExtractionStrategy;

const nonRefSections = sections.filter(
  (s) => s.sectionType !== "references" && s.sectionType !== "appendix" && s.sectionType !== "acknowledgments"
);
const criticalSections = sections.filter(
  (s) => s.importance === "critical" || s.importance === "high"
);

if (sections.length === 0) {
  // Fallback: no sections detected
  let pagesToExtract: number[];
  if (totalPages < 20) {
    pagesToExtract = Array.from({ length: Math.max(1, totalPages - 5) }, (_, i) => i + 1);
  } else if (totalPages < 50) {
    const third = Math.floor(totalPages / 3);
    const mid = Math.floor(totalPages / 2);
    pagesToExtract = [
      ...Array.from({ length: third }, (_, i) => i + 1),
      ...Array.from({ length: 5 }, (_, i) => mid - 2 + i),
      ...Array.from({ length: 5 }, (_, i) => totalPages - 4 + i),
    ];
  } else {
    pagesToExtract = [
      ...Array.from({ length: 15 }, (_, i) => i + 1),
      ...Array.from({ length: 10 }, (_, i) => Math.floor(totalPages / 2) - 5 + i),
      ...Array.from({ length: 10 }, (_, i) => totalPages - 9 + i),
    ];
  }
  strategy = {
    name: "smart_overview_fallback",
    totalPages,
    sectionsToExtract: [`pages: ${pagesToExtract[0]}-${pagesToExtract[pagesToExtract.length - 1]}`],
    estimatedTokens: pagesToExtract.length * 1500,
  };
} else if (totalPages < 20) {
  strategy = {
    name: "full_extraction",
    totalPages,
    sectionsToExtract: nonRefSections.map((s) => s.sectionName),
    estimatedTokens: nonRefSections.reduce((sum, s) => sum + s.pageCount * 1500, 0),
  };
} else if (totalPages < 50) {
  strategy = {
    name: "critical_sections",
    totalPages,
    sectionsToExtract: criticalSections.map((s) => s.sectionName),
    estimatedTokens: criticalSections.reduce((sum, s) => sum + s.pageCount * 1500, 0),
  };
} else {
  const critOnly = sections.filter((s) => s.importance === "critical");
  const intro = sections.find((s) => s.sectionType === "introduction");
  const toExtract = intro ? [intro, ...critOnly.filter((s) => s !== intro)] : critOnly;
  strategy = {
    name: "critical_only",
    totalPages,
    sectionsToExtract: toExtract.map((s) => s.sectionName),
    estimatedTokens: toExtract.reduce((sum, s) => sum + s.pageCount * 1500, 0),
  };
}

if (values["plan-only"]) {
  console.log(JSON.stringify({ strategy, detectedSections: sections }));
  process.exit(0);
}

// Step 4: Extract content
const extractedSections: ExtractedContent["sections"] = [];

if (sections.length === 0) {
  // Fallback extraction
  const text = allPages
    .filter((p) => p.pageNumber <= totalPages - 5 || totalPages < 10)
    .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
    .join("\n\n");
  extractedSections.push({ name: "Full Content", pages: `1-${totalPages}`, text });
} else {
  const toExtract = strategy.name === "full_extraction" ? nonRefSections : criticalSections;
  let tokenBudget = maxTokens;

  for (const section of toExtract) {
    if (tokenBudget <= 0) break;

    const sectionPages = allPages.filter(
      (p) => p.pageNumber >= section.startPage && p.pageNumber <= section.endPage
    );
    const text = sectionPages.map((p) => p.text).join("\n\n");
    const tokens = estimateTokens(text);

    extractedSections.push({
      name: section.sectionName,
      pages: `${section.startPage}-${section.endPage}`,
      text,
    });

    tokenBudget -= tokens;
  }
}

const result: ExtractedContent = { strategy, sections: extractedSections };

if (values.save) {
  const output = extractedSections
    .map(
      (s) =>
        `${"=".repeat(40)}\nSECTION: ${s.name}\nPages ${s.pages}\n${"=".repeat(40)}\n\n${s.text}`
    )
    .join("\n\n");
  writeFileSync(values.save, output);
  console.error(`Saved to: ${values.save}`);
}

console.log(JSON.stringify(result));
