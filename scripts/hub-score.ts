#!/usr/bin/env tsx
/**
 * HITS hub/authority scoring over the vault's link graph.
 * Separates administrative aggregators (MOCs that link to everything — high
 * hub, low authority) from genuine topical authorities (heavily linked-to,
 * regardless of how much they link out) — the fix for in-degree alone
 * conflating "connects to everything" with "is actually important".
 *
 * Usage: npx tsx scripts/hub-score.ts --vault <path> [--top <n>] [--json]
 */

import { readFileSync, existsSync } from "fs";
import { join, relative } from "path";
import { parseArgs } from "util";
import { resolveVault, ensureIndex, loadIndexes } from "./lib/vault.js";
import { computeHITS, type HitsEdge, type HitsScore } from "./lib/hits.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    top: { type: "string", default: "15" },
    json: { type: "boolean", default: false },
  },
});

const config = resolveVault(values.vault);
const topN = Math.max(1, parseInt(values.top!, 10) || 15);

const backlinkPath = join(config.wikiPath, "backlink-index.jsonl");
if (!existsSync(backlinkPath)) {
  console.error("backlink-index.jsonl not found. Run `commonplace index` first.");
  process.exit(1);
}

interface BacklinkRecord {
  target: string;
  backlinks: { source: string; count: number }[];
}

function parseJsonl<T>(filePath: string): T[] {
  return readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter((line) => line)
    .map((line) => JSON.parse(line) as T);
}

const backlinkRecords = parseJsonl<BacklinkRecord>(backlinkPath);

const edges: HitsEdge[] = [];
for (const record of backlinkRecords) {
  for (const { source, count } of record.backlinks) {
    edges.push({ source, target: record.target, weight: count });
  }
}

if (edges.length === 0) {
  console.error("No links found in backlink-index.jsonl — nothing to score.");
  process.exit(1);
}

// Best-effort path -> display title, from indexes if available. Falls back
// to filename (extension stripped) when indexes are missing or stale.
const displayName = new Map<string, string>();
if (ensureIndex(config)) {
  try {
    const { sources, concepts, mocs } = loadIndexes(config);
    for (const s of sources) displayName.set(relative(config.vaultPath, s.path), s.title);
    for (const c of concepts) displayName.set(relative(config.vaultPath, c.path), c.name);
    for (const m of mocs) displayName.set(relative(config.vaultPath, m.path), m.name);
  } catch {
    // Fall back to filenames below
  }
}
function titleFor(relPath: string): string {
  return displayName.get(relPath) ?? relPath.replace(/\.md$/, "").split("/").pop()!;
}

const scores = computeHITS(edges);

interface RankedNode {
  path: string;
  title: string;
  hub: number;
  authority: number;
}

const ranked: RankedNode[] = [...scores.entries()].map(([path, s]: [string, HitsScore]) => ({
  path,
  title: titleFor(path),
  hub: s.hub,
  authority: s.authority,
}));

const topHubs = [...ranked].sort((a, b) => b.hub - a.hub).slice(0, topN);
const topAuthorities = [...ranked].sort((a, b) => b.authority - a.authority).slice(0, topN);

// Administrative aggregators: high hub rank but not among the top authorities —
// they connect broadly (MOCs, index pages) without being what others point to.
const authorityPaths = new Set(topAuthorities.map((n) => n.path));
const aggregators = topHubs.filter((n) => !authorityPaths.has(n.path) && n.hub > 0);

if (values.json) {
  console.log(
    JSON.stringify({
      hubs: topHubs,
      authorities: topAuthorities,
      aggregators,
    })
  );
} else {
  console.log(`HITS over ${ranked.length} nodes, ${edges.length} edges\n`);

  console.log(`Top ${topHubs.length} hubs (link out broadly):`);
  for (const n of topHubs) {
    console.log(`  ${n.hub.toFixed(4)}  ${n.title}  (${n.path})`);
  }

  console.log(`\nTop ${topAuthorities.length} authorities (linked to by many hubs):`);
  for (const n of topAuthorities) {
    console.log(`  ${n.authority.toFixed(4)}  ${n.title}  (${n.path})`);
  }

  if (aggregators.length > 0) {
    console.log(
      `\nLikely administrative aggregators (high hub, low authority — probably MOCs/index pages, not topical authorities):`
    );
    for (const n of aggregators) {
      console.log(`  ${n.title}  (${n.path})`);
    }
  }
}
