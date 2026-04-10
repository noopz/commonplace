#!/usr/bin/env tsx
/**
 * Detect vault structure by sampling .md files and their frontmatter.
 * Infers sources/concepts/mocs directories, stub pattern, and MOC count pattern.
 *
 * Usage: npx tsx scripts/detect-structure.ts --vault <path>
 * Output: WikiConfig-shaped JSON with _confidence metadata
 */

import { parseArgs } from "util";
import { readFileSync, existsSync } from "fs";
import { join, dirname, relative } from "path";
import { glob } from "glob";
import { resolveVault } from "./lib/vault.js";
import type { WikiConfig } from "./lib/types.js";

const { values } = parseArgs({ options: { vault: { type: "string" } } });
const config = resolveVault(values.vault);

const SAMPLE_LIMIT = 200;
const STUB_PHRASES = ["Definition pending", "stub", "to be added", "coming soon", "TBD"];
const MOC_COUNT_PATTERNS = [
  { pattern: /\*\*Papers:\*\*\s*\d+/, label: "**Papers:** N" },
  { pattern: /\*\*Sources:\*\*\s*\d+/, label: "**Sources:** N" },
  { pattern: /##\s*Papers\s*\(\d+\)/, label: "## Papers (N)" },
  { pattern: /##\s*Sources\s*\(\d+\)/, label: "## Sources (N)" },
];

// ---- Sample files ----

const allFiles = await glob("**/*.md", {
  cwd: config.vaultPath,
  absolute: true,
  ignore: [".obsidian/**", ".wiki/**", "node_modules/**"],
});

const sample = allFiles.slice(0, SAMPLE_LIMIT);

interface FileSample {
  path: string;
  relDir: string;
  tags: string[];
  body: string;
}

const samples: FileSample[] = [];

for (const filePath of sample) {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    let tags: string[] = [];

    if (fmMatch) {
      const fmText = fmMatch[1];
      // Parse tags array: tags: [a, b, c] or tags:\n  - a
      const inlineMatch = fmText.match(/^tags:\s*\[([^\]]*)\]/m);
      if (inlineMatch) {
        tags = inlineMatch[1].split(",").map((t) => t.trim().replace(/['"]/g, ""));
      } else {
        const blockMatch = fmText.match(/^tags:\s*\n((?:\s+-[^\n]+\n?)*)/m);
        if (blockMatch) {
          tags = [...blockMatch[1].matchAll(/^\s+-\s+(.+)$/gm)].map((m) =>
            m[1].trim().replace(/['"]/g, "")
          );
        }
      }
    }

    const relPath = relative(config.vaultPath, filePath);
    const relDir = dirname(relPath);

    samples.push({ path: filePath, relDir, tags, body: raw });
  } catch {
    // skip unreadable files
  }
}

// ---- Infer structure directories ----

function inferDir(tagName: string): { dir: string; confidence: number } {
  const counts: Record<string, number> = {};
  for (const s of samples) {
    if (s.tags.includes(tagName)) {
      // Use the top-level dir (first two segments) as the candidate
      const parts = s.relDir.split("/");
      const key = parts.length >= 2 ? parts.slice(0, 2).join("/") : parts[0];
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return { dir: "", confidence: 0 };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    dir: entries[0][0],
    confidence: entries[0][1] / total,
  };
}

const sourcesResult = inferDir("paper");
const conceptsResult = inferDir("concept");
const mocsResult = inferDir("moc");

// ---- Infer stub pattern ----

function inferStubPattern(): { pattern: string; confidence: number } {
  const phraseHits: Record<string, number> = {};
  const conceptSamples = samples.filter((s) => s.tags.includes("concept"));

  for (const s of conceptSamples) {
    for (const phrase of STUB_PHRASES) {
      if (s.body.includes(phrase)) {
        phraseHits[phrase] = (phraseHits[phrase] ?? 0) + 1;
      }
    }
  }

  const entries = Object.entries(phraseHits).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return { pattern: "Definition pending", confidence: 0 };

  const total = conceptSamples.length || 1;
  return { pattern: entries[0][0], confidence: entries[0][1] / total };
}

const stubResult = inferStubPattern();

// ---- Infer MOC count pattern ----

function inferMocCountPattern(): { pattern: string; confidence: number } {
  const patternHits: Record<string, number> = {};
  const mocSamples = samples.filter((s) => s.tags.includes("moc"));

  for (const s of mocSamples) {
    for (const { pattern, label } of MOC_COUNT_PATTERNS) {
      if (pattern.test(s.body)) {
        patternHits[label] = (patternHits[label] ?? 0) + 1;
      }
    }
  }

  const entries = Object.entries(patternHits).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return { pattern: "**Papers:** N", confidence: 0 };

  const total = mocSamples.length || 1;
  return { pattern: entries[0][0], confidence: entries[0][1] / total };
}

const mocCountResult = inferMocCountPattern();

// ---- Build output ----

const wikiConfig: WikiConfig = {
  structure: {
    sources: sourcesResult.dir || "",
    concepts: conceptsResult.dir || "",
    mocs: mocsResult.dir || "",
  },
  stubPattern: stubResult.pattern,
  mocCountPattern: mocCountResult.pattern,
};

const output = {
  ...wikiConfig,
  _confidence: {
    sources: Math.round(sourcesResult.confidence * 100) / 100,
    concepts: Math.round(conceptsResult.confidence * 100) / 100,
    mocs: Math.round(mocsResult.confidence * 100) / 100,
    stubPattern: Math.round(stubResult.confidence * 100) / 100,
    mocCountPattern: Math.round(mocCountResult.confidence * 100) / 100,
  },
  _sampledFiles: samples.length,
};

console.log(JSON.stringify(output, null, 2));
