import { appendFileSync } from "fs";
import { join } from "path";

/**
 * One record in .wiki/lineage.jsonl: which deterministic script wrote which
 * note, and why. Tier-1 provenance only (scripts self-report exactly what
 * they changed) — reconstructing provenance for judgment/agent edits is out
 * of scope; see docs/claude-science-architecture-plan.md item 5.
 */
export interface LineageEntry {
  note: string;
  source: string;
  writer: string;
  timestamp: string;
}

export function appendLineage(wikiPath: string, entry: Omit<LineageEntry, "timestamp">): void {
  const full: LineageEntry = { ...entry, timestamp: new Date().toISOString() };
  appendFileSync(join(wikiPath, "lineage.jsonl"), JSON.stringify(full) + "\n", "utf-8");
}
