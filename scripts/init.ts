#!/usr/bin/env tsx
/**
 * Initialize or reconfigure commonplace for a vault.
 *
 * - Auto-detects vault structure (sources/concepts/mocs dirs, stub pattern)
 * - Writes .wiki/config.json (merges with existing, preserving user edits)
 * - Writes .vault-path at the plugin root (used by SessionStart hooks)
 * - Generates/updates vault CLAUDE.md domain registry sentinel block
 *
 * Usage: npx tsx scripts/init.ts [--vault <path>]
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import { resolveVault, loadDomainRegistry } from "./lib/vault.js";
import type { WikiConfig } from "./lib/types.js";

const { values } = parseArgs({ options: { vault: { type: "string" } } });
const config = resolveVault(values.vault);

// ---- Step 1: Detect structure ----

// Inline detection (same logic as detect-structure.ts, no subprocess)
const SAMPLE_LIMIT = 200;
const STUB_PHRASES = ["Definition pending", "stub", "to be added", "coming soon", "TBD"];
const MOC_COUNT_PATTERNS = [
  { pattern: /\*\*Papers:\*\*\s*\d+/, label: "**Papers:** N" },
  { pattern: /\*\*Sources:\*\*\s*\d+/, label: "**Sources:** N" },
  { pattern: /##\s*Papers\s*\(\d+\)/, label: "## Papers (N)" },
  { pattern: /##\s*Sources\s*\(\d+\)/, label: "## Sources (N)" },
];

const allFiles = await glob("**/*.md", {
  cwd: config.vaultPath,
  absolute: true,
  ignore: [".obsidian/**", ".wiki/**", "node_modules/**"],
});

const sample = allFiles.slice(0, SAMPLE_LIMIT);

interface FileSample {
  relDir: string;
  tags: string[];
  body: string;
  fm: string; // raw frontmatter text
}

function parseTags(fmText: string): string[] {
  const inline = fmText.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inline) return inline[1].split(",").map((t) => t.trim().replace(/['"]/g, ""));
  const block = fmText.match(/^tags:\s*\n((?:\s+-[^\n]+\n?)*)/m);
  if (block) return [...block[1].matchAll(/^\s+-\s+(.+)$/gm)].map((m) => m[1].trim().replace(/['"]/g, ""));
  return [];
}

const samples: FileSample[] = [];
for (const filePath of sample) {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    const fm = fmMatch ? fmMatch[1] : "";
    const tags = fm ? parseTags(fm) : [];
    const parts = filePath.slice(config.vaultPath.length + 1).split("/");
    const relDir = parts.length >= 3 ? parts.slice(0, 2).join("/") : parts.slice(0, 1).join("/");
    samples.push({ relDir, tags, body: raw, fm });
  } catch { /* skip */ }
}

/** Find the common ancestor directory of a set of relative dir paths */
function commonAncestor(dirs: string[]): string {
  if (!dirs.length) return "";
  const splitDirs = dirs.map(d => d.split("/"));
  const ancestor: string[] = [];
  for (let i = 0; i < splitDirs[0].length; i++) {
    const seg = splitDirs[0][i];
    if (splitDirs.every(parts => parts[i] === seg)) {
      ancestor.push(seg);
    } else {
      break;
    }
  }
  return ancestor.join("/");
}

/**
 * Infer a directory using a predicate on samples.
 * Groups by top-level directory, picks the majority group,
 * then returns the common ancestor within that group.
 * This handles: Research/AI, Research/Finance → "Research" (not a subdomain).
 */
function inferDirBy(predicate: (s: FileSample) => boolean): { dir: string; confidence: number } {
  const dirs = samples.filter(predicate).map(s => s.relDir);
  if (!dirs.length) return { dir: "", confidence: 0 };

  // Group by first path segment
  const groups: Record<string, string[]> = {};
  for (const d of dirs) {
    const top = d.split("/")[0];
    (groups[top] ??= []).push(d);
  }

  // Pick the group with the most entries
  const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  const [, topDirs] = sorted[0];

  // Common ancestor within the winning group
  const dir = commonAncestor(topDirs) || topDirs[0].split("/")[0];
  const confidence = topDirs.length / dirs.length;
  return { dir, confidence };
}

function inferStubPattern(): { pattern: string; confidence: number } {
  const hits: Record<string, number> = {};
  const cs = samples.filter((s) => s.tags.includes("concept"));
  for (const s of cs) {
    for (const p of STUB_PHRASES) if (s.body.includes(p)) hits[p] = (hits[p] ?? 0) + 1;
  }
  const entries = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { pattern: "Definition pending", confidence: 0 };
  return { pattern: entries[0][0], confidence: entries[0][1] / (cs.length || 1) };
}

function inferMocCountPattern(): { pattern: string; confidence: number } {
  const hits: Record<string, number> = {};
  const ms = samples.filter((s) => s.tags.includes("moc"));
  for (const s of ms) {
    for (const { pattern, label } of MOC_COUNT_PATTERNS) if (pattern.test(s.body)) hits[label] = (hits[label] ?? 0) + 1;
  }
  const entries = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { pattern: "**Papers:** N", confidence: 0 };
  return { pattern: entries[0][0], confidence: entries[0][1] / (ms.length || 1) };
}

// Sources: notes with concepts: array in frontmatter (strongest signal), or tagged "paper"
const sourcesResult = inferDirBy(s => /^concepts:/m.test(s.fm) || s.tags.includes("paper"));
// Concepts: tagged "concept"
const conceptsResult = inferDirBy(s => s.tags.includes("concept"));
// MOCs: tagged "moc"
const mocsResult = inferDirBy(s => s.tags.includes("moc"));
const stubResult = inferStubPattern();
const mocCountResult = inferMocCountPattern();

const detected: WikiConfig = {
  structure: {
    sources: sourcesResult.dir || "",
    concepts: conceptsResult.dir || "",
    mocs: mocsResult.dir || "",
  },
  stubPattern: stubResult.pattern,
  mocCountPattern: mocCountResult.pattern,
};

// ---- Step 2: Merge with existing config.json ----

mkdirSync(config.wikiPath, { recursive: true });
const configPath = join(config.wikiPath, "config.json");
let merged: WikiConfig = detected;

if (existsSync(configPath)) {
  try {
    const existing = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<WikiConfig>;
    merged = {
      structure: {
        sources: existing.structure?.sources ?? detected.structure.sources,
        concepts: existing.structure?.concepts ?? detected.structure.concepts,
        mocs: existing.structure?.mocs ?? detected.structure.mocs,
      },
      stubPattern: existing.stubPattern ?? detected.stubPattern,
      mocCountPattern: existing.mocCountPattern ?? detected.mocCountPattern,
    };
  } catch {
    console.error("Warning: Could not parse existing config.json — using detected values");
  }
}

writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");

// ---- Step 3: Write .vault-path ----

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Write to CLAUDE_PLUGIN_DATA (survives plugin updates), fall back to plugin root
const dataDir = process.env.CLAUDE_PLUGIN_DATA;
const vaultPathDest = dataDir ? join(dataDir, ".vault-path") : join(pluginRoot, ".vault-path");
writeFileSync(vaultPathDest, config.vaultPath + "\n");

// Write reverse pointer in vault so agents running from vault context can find the plugin
writeFileSync(join(config.wikiPath, "plugin-root"), pluginRoot + "\n");

// ---- Step 4: Generate/update vault CLAUDE.md ----

const REGISTRY_START = "<!-- DOMAIN_REGISTRY_START -->";
const REGISTRY_END = "<!-- DOMAIN_REGISTRY_END -->";

// Load existing domain registry from CLAUDE.md if present, else detect from directory structure
let domainBlock: string;
if (existsSync(config.claudeMdPath)) {
  const existing = readFileSync(config.claudeMdPath, "utf-8");
  if (existing.includes(REGISTRY_START)) {
    // Already has markers — preserve existing registry, we'll update it in-place below
    domainBlock = existing.slice(
      existing.indexOf(REGISTRY_START) + REGISTRY_START.length,
      existing.indexOf(REGISTRY_END)
    ).trim();
  } else {
    domainBlock = buildRegistryBlock(merged.structure.sources, config.vaultPath);
  }
} else {
  domainBlock = buildRegistryBlock(merged.structure.sources, config.vaultPath);
}

function buildRegistryBlock(sourcesDir: string, vaultPath: string): string {
  // Detect domain subdirectories under sources dir
  const sourcesDirAbs = join(vaultPath, sourcesDir);
  let domainEntries = "";
  if (existsSync(sourcesDirAbs)) {
    const subdirs = readdirSync(sourcesDirAbs).filter((d) => {
      try { return statSync(join(sourcesDirAbs, d)).isDirectory(); } catch { return false; }
    });
    for (const d of subdirs) {
      const slug = d.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      domainEntries += `  ${slug}:\n    path: "${sourcesDir}/${d}"\n    scope: professional\n`;
    }
  }
  if (!domainEntries) {
    domainEntries = `  # Add domains here, e.g.:\n  # my-domain:\n  #   path: "${sourcesDir}/My Domain"\n  #   scope: professional\n`;
  }
  return `\`\`\`yaml\ndomains:\n${domainEntries}\`\`\``;
}

const registrySection = `${REGISTRY_START}\n${domainBlock}\n${REGISTRY_END}`;

if (existsSync(config.claudeMdPath)) {
  let content = readFileSync(config.claudeMdPath, "utf-8");
  if (content.includes(REGISTRY_START) && content.includes(REGISTRY_END)) {
    // Update in-place
    content = content.slice(0, content.indexOf(REGISTRY_START)) +
      registrySection +
      content.slice(content.indexOf(REGISTRY_END) + REGISTRY_END.length);
  } else {
    // Append
    content = content.trimEnd() + "\n\n## Domain Registry\n\n" + registrySection + "\n";
  }
  writeFileSync(config.claudeMdPath, content);
} else {
  // Generate skeleton CLAUDE.md
  const skeleton = `# Vault Schema & Conventions

This file defines the structure, rules, and conventions for this knowledge base.

## Vault Structure

- **Sources**: \`${merged.structure.sources}/\` — research notes, papers, articles
- **Concepts**: \`${merged.structure.concepts}/\` — atomic concept definitions
- **MOCs**: \`${merged.structure.mocs}/\` — Maps of Content

## Domain Registry

Domains are inferred from file paths, never stored in frontmatter.

${registrySection}

## Working with Indexes

Never use Python or shell one-liners to parse JSON index files. Instead:
- **Search**: use Grep — e.g. \`Grep "pattern" ".wiki/concept-index.jsonl"\`
- **Read**: use the Read tool — never \`cat file | python3 -c ...\`
- **Script output**: scripts output valid JSON, read it directly

## Frontmatter Schema

*Document your note types and required fields here.*

## Quality Standards

- No broken wikilinks
- No orphan notes
- No stub concepts left indefinitely
`;
  writeFileSync(config.claudeMdPath, skeleton);
}

// ---- Step 5: Report ----

const lowConfidence: string[] = [];
if (sourcesResult.confidence < 0.7) lowConfidence.push(`sources dir (${Math.round(sourcesResult.confidence * 100)}% confidence) → "${merged.structure.sources}"`);
if (conceptsResult.confidence < 0.7) lowConfidence.push(`concepts dir (${Math.round(conceptsResult.confidence * 100)}% confidence) → "${merged.structure.concepts}"`);
if (mocsResult.confidence < 0.7) lowConfidence.push(`mocs dir (${Math.round(mocsResult.confidence * 100)}% confidence) → "${merged.structure.mocs}"`);

console.log(JSON.stringify({
  status: "ok",
  vaultPath: config.vaultPath,
  configWritten: configPath,
  vaultPathFile: vaultPathDest,
  pluginRootFile: join(config.wikiPath, "plugin-root"),
  structure: merged.structure,
  stubPattern: merged.stubPattern,
  mocCountPattern: merged.mocCountPattern,
  lowConfidence: lowConfidence.length ? lowConfidence : undefined,
  sampledFiles: samples.length,
}, null, 2));
