#!/usr/bin/env tsx
/**
 * SessionStart hook: emits additionalContext telling the model
 * the commonplace wiki is active and how to use it.
 *
 * Keeps it short — vault stats for grounding, index locations
 * for searchability, methodology reference, skill pointer.
 */

import { readFileSync } from "fs";
import { join } from "path";

// Resolve vault path
const dataDir = process.env.CLAUDE_PLUGIN_DATA;
const pluginRoot = join(import.meta.dirname!, "..");
let vaultPath: string | undefined;
for (const loc of [
  ...(dataDir ? [join(dataDir, ".vault-path")] : []),
  join(pluginRoot, ".vault-path"),
]) {
  try { vaultPath = readFileSync(loc, "utf-8").trim(); break; } catch {}
}
if (!vaultPath) process.exit(0);

const wikiPath = join(vaultPath, ".wiki");

// Count records (cheap — just count newlines)
function countLines(path: string): number {
  try { return readFileSync(path, "utf-8").trim().split("\n").length; } catch { return 0; }
}

const sourceCount = countLines(join(wikiPath, "source-index.jsonl"));
const conceptCount = countLines(join(wikiPath, "concept-index.jsonl"));
const mocCount = countLines(join(wikiPath, "moc-index.jsonl"));

if (sourceCount === 0) process.exit(0);

const context = `The commonplace wiki plugin is active for ${vaultPath} (${sourceCount} sources, ${conceptCount} concepts, ${mocCount} MOCs).

When the user asks research questions, discusses topics that may be covered in the vault, or wants to explore connections between ideas — use the wiki-query skill. It defines the full methodology for searching and traversing the vault's knowledge graph.

Searchable JSONL indexes at ${wikiPath}/:
- source-index.jsonl — {title, path, domain, scope, tags, concepts, mocs}
- concept-index.jsonl — {name, path, domains, backlinkCount, isStub}
- moc-index.jsonl — {name, path, sourceCount, sources}
One JSON record per line — Grep returns complete records.`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: context,
  },
}));
