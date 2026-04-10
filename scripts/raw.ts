#!/usr/bin/env tsx
/**
 * Scan the vault's raw/ folder and report ingest status per file.
 * A file is "ingested" if any source note body contains a reference to its filename.
 * Usage: npx tsx scripts/raw.ts --vault <path>
 */

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, extname, basename } from "path";
import { parseArgs } from "util";
import { resolveVault, loadWikiConfig, findAllNotes, classifyNote } from "./lib/vault.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    instruct: { type: "boolean", default: false },
  },
});

const config = resolveVault(values.vault);
const wikiConfig = loadWikiConfig(config);
const rawDir = join(config.vaultPath, wikiConfig?.rawFolder ?? "raw");

if (!existsSync(rawDir)) {
  console.log(JSON.stringify({ pending: [], ingested: [], rawDir }));
  process.exit(0);
}

// Supported intake types and how to describe them
const FILE_TYPES: Record<string, string> = {
  ".pdf": "pdf",
  ".csv": "csv",
  ".tsv": "tsv",
  ".html": "html",
  ".htm": "html",
  ".epub": "epub",
  ".json": "json",
  ".txt": "text",
};

// Collect all files in raw/ (non-recursive — raw/ is flat by convention)
const rawFiles = readdirSync(rawDir)
  .filter((f) => !f.startsWith("."))
  .filter((f) => {
    const ext = extname(f).toLowerCase();
    return ext in FILE_TYPES;
  })
  .map((f) => ({
    filename: f,
    path: join(rawDir, f),
    type: FILE_TYPES[extname(f).toLowerCase()] ?? "unknown",
    sizeMb: Math.round(statSync(join(rawDir, f)).size / 1024 / 1024 * 10) / 10,
  }));

if (rawFiles.length === 0) {
  console.log(JSON.stringify({ pending: [], ingested: [], rawDir }));
  process.exit(0);
}

// Check each raw file against all source notes
const allNotes = findAllNotes(config.vaultPath);
const sourceNotes = allNotes.filter(
  (p) => classifyNote(p, config.vaultPath) === "source"
);

// Build a map: filename → source note paths that reference it
const referenceMap = new Map<string, string[]>();
for (const rawFile of rawFiles) {
  referenceMap.set(rawFile.filename, []);
}

for (const notePath of sourceNotes) {
  try {
    const body = readFileSync(notePath, "utf-8");
    for (const rawFile of rawFiles) {
      if (body.includes(rawFile.filename)) {
        referenceMap.get(rawFile.filename)!.push(notePath);
      }
    }
  } catch {
    // skip unreadable notes
  }
}

const pending = rawFiles
  .filter((f) => referenceMap.get(f.filename)!.length === 0)
  .map((f) => ({ filename: f.filename, type: f.type, sizeMb: f.sizeMb }));

const ingested = rawFiles
  .filter((f) => referenceMap.get(f.filename)!.length > 0)
  .map((f) => ({
    filename: f.filename,
    type: f.type,
    sizeMb: f.sizeMb,
    sourceNotes: referenceMap.get(f.filename)!,
  }));

if (values.instruct) {
  if (pending.length > 0) {
    console.log(`=== Uningested raw/ files (${pending.length}) ===`);
    for (const f of pending) {
      console.log(`  - ${f.filename} (${f.type}, ${f.sizeMb}MB)`);
    }
    console.log(`Run \`ingest raw/${pending[0].filename}\` to process, or say "what's in raw/" to see all.`);
  }
  process.exit(0);
}

console.log(JSON.stringify({ pending, ingested, rawDir }));
