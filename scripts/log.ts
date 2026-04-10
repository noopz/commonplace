#!/usr/bin/env tsx
/**
 * Append a structured entry to .wiki/log.md.
 * Usage:
 *   commonplace log --vault <path> --entry "## [2026-04-09] ingest | Title\n- ..."
 *   echo "## [2026-04-09] ..." | commonplace log --vault <path>
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";
import { resolveVault } from "./lib/vault.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    entry: { type: "string" },
  },
});

const config = resolveVault(values.vault);
const logPath = join(config.wikiPath, "log.md");

// Ensure .wiki/ exists
if (!existsSync(config.wikiPath)) {
  mkdirSync(config.wikiPath, { recursive: true });
}

async function getEntry(): Promise<string> {
  if (values.entry) return values.entry;
  if (process.stdin.isTTY) {
    console.error("commonplace log: provide --entry or pipe text via stdin");
    process.exit(1);
  }
  const chunks: string[] = [];
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) chunks.push(chunk as string);
  return chunks.join("");
}

const entry = await getEntry();
const text = entry.endsWith("\n") ? entry : entry + "\n";
appendFileSync(logPath, text);
