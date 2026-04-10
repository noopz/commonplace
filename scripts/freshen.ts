#!/usr/bin/env tsx
/**
 * Sample source notes with live URLs for freshness checking.
 * Tracks check history in .wiki/freshness.json.
 *
 * Modes:
 *   (default)   Sample oldest-unchecked notes with live URLs
 *   --record    Read one check record from stdin, merge into freshness.json
 *   --clear     Clear stale flag for a specific note path
 *
 * Usage:
 *   npx tsx scripts/freshen.ts --vault <path> [--sample <n>] [--min-age-days <n>]
 *   echo '<json>' | npx tsx scripts/freshen.ts --vault <path> --record
 *   npx tsx scripts/freshen.ts --vault <path> --clear "relative/path/to/note.md"
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";
import { resolveVault, ensureIndex, loadIndexes } from "./lib/vault.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    sample: { type: "string", default: "5" },
    "min-age-days": { type: "string", default: "7" },
    record: { type: "boolean", default: false },
    clear: { type: "string" },
  },
});

const config = resolveVault(values.vault);
const freshnessPath = join(config.wikiPath, "freshness.json");

// ---- Shared: load/save freshness.json ----

type FreshnessRecord = {
  url: string;
  lastChecked: string | null;
  stale: boolean;
};
type FreshnessIndex = { checks: Record<string, FreshnessRecord> };

function loadFreshness(): FreshnessIndex {
  if (!existsSync(freshnessPath)) return { checks: {} };
  try {
    return JSON.parse(readFileSync(freshnessPath, "utf-8")) as FreshnessIndex;
  } catch {
    return { checks: {} };
  }
}

function saveFreshness(data: FreshnessIndex): void {
  writeFileSync(freshnessPath, JSON.stringify(data, null, 2) + "\n");
}

// ---- Mode: --record (stdin → merge into freshness.json) ----

if (values.record) {
  const chunks: string[] = [];
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (c) => chunks.push(c as string));
  process.stdin.on("end", () => {
    try {
      const entry = JSON.parse(chunks.join("")) as {
        path: string;
        url: string;
        lastChecked: string;
        stale: boolean;
      };
      const data = loadFreshness();
      data.checks[entry.path] = {
        url: entry.url,
        lastChecked: entry.lastChecked,
        stale: entry.stale,
      };
      saveFreshness(data);
      console.log(JSON.stringify({ ok: true, recorded: entry.path }));
    } catch (err) {
      console.error("freshen --record: failed to parse stdin JSON:", err);
      process.exit(1);
    }
  });
  process.stdin.on("error", () => process.exit(1));
  // Let stdin events run
  process.exit; // don't exit early — wait for 'end' event
} else if (values.clear) {

// ---- Mode: --clear <path> ----

  const data = loadFreshness();
  const key = values.clear;
  if (data.checks[key]) {
    data.checks[key].stale = false;
    saveFreshness(data);
    console.log(JSON.stringify({ ok: true, cleared: key }));
  } else {
    console.log(JSON.stringify({ ok: false, reason: "path not found in freshness.json" }));
  }

} else {

// ---- Mode: default (candidate selection) ----

  const sampleSize = parseInt(values.sample ?? "5", 10);
  const minAgeDays = parseInt(values["min-age-days"] ?? "7", 10);
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;

  // URLs matching these patterns are permanent — skip them
  const PERMANENT = [
    /arxiv\.org/,
    /doi\.org/,
    /huggingface\.co\/papers/,
    /semanticscholar\.org/,
  ];

  function extractLiveUrl(body: string): string | null {
    // Match both **URL:** url (colon inside bold) and **URL**: url (colon outside bold)
    const labeled = body.match(/\*\*(?:URL|Source|Link|Webpage|Doc):?\*\*:?\s*(https?:\/\/\S+)/i);
    if (labeled) {
      const url = labeled[1].replace(/[)>\].,\s]+$/, "").trim();
      if (!PERMANENT.some((p) => p.test(url))) return url;
      return null;
    }
    return null;
  }

  if (!ensureIndex(config)) {
    console.log(JSON.stringify({ candidates: [], totalEligible: 0, freshnessPath }));
    process.exit(0);
  }

  const { sources } = loadIndexes(config);
  const freshness = loadFreshness();
  const now = Date.now();

  const candidates: Array<{
    notePath: string;
    noteTitle: string;
    url: string;
    lastChecked: string | null;
    lastCheckedMs: number;
    relPath: string;
  }> = [];

  for (const source of sources) {
    const absPath = source.path.startsWith("/")
      ? source.path
      : join(config.vaultPath, source.path);

    if (!existsSync(absPath)) continue;

    const relPath = absPath.startsWith(config.vaultPath + "/")
      ? absPath.slice(config.vaultPath.length + 1)
      : absPath;

    // Skip raw/ files — local copies, not live URLs
    if (relPath.startsWith("raw/")) continue;

    let body = "";
    try {
      body = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    const url = extractLiveUrl(body);
    if (!url) continue;

    const record = freshness.checks[relPath];
    const lastChecked = record?.lastChecked ?? null;
    const lastCheckedMs = lastChecked ? new Date(lastChecked).getTime() : 0;

    // Skip recently checked
    if (lastChecked && now - lastCheckedMs < minAgeMs) continue;

    candidates.push({ notePath: absPath, noteTitle: source.title, url, lastChecked, lastCheckedMs, relPath });
  }

  // Sort: oldest checked first; tiebreaker: alphabetical by relPath (stable)
  candidates.sort((a, b) =>
    a.lastCheckedMs !== b.lastCheckedMs
      ? a.lastCheckedMs - b.lastCheckedMs
      : a.relPath.localeCompare(b.relPath)
  );

  const sampled = candidates.slice(0, sampleSize).map(({ notePath, noteTitle, url, lastChecked, relPath }) => ({
    notePath,
    relPath,
    noteTitle,
    url,
    lastChecked,
  }));

  console.log(JSON.stringify({ candidates: sampled, totalEligible: candidates.length, freshnessPath }));
}
