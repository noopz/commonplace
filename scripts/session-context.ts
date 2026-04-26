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

// Surface untuned genres (discovered detection signals but no rules yet).
// The indexer auto-discovers new genres as the vault grows; this nudges
// the model to dispatch the wiki-conventions-tuner agent to fill rules.
let untunedNotice = "";
try {
  const conv = JSON.parse(readFileSync(join(wikiPath, "conventions.json"), "utf-8"));
  const untuned: string[] = (conv.genres ?? [])
    .filter((g: { rules?: Record<string, unknown> }) => !g.rules || Object.keys(g.rules).length === 0)
    .map((g: { name: string }) => g.name);
  if (untuned.length > 0) {
    untunedNotice = `\n\n${untuned.length} genre(s) discovered without rules: ${untuned.join(", ")}. Dispatch the wiki-conventions-tuner agent to propose rules so genre-aware lint checks apply.`;
  }
} catch { /* conventions.json not yet written; skip */ }

const context = `The commonplace wiki plugin is active for ${vaultPath} (${sourceCount} sources, ${conceptCount} concepts, ${mocCount} MOCs). The vault is the user's persistent knowledge base — use it instead of Claude's memory.

Use the plugin's skills for structural vault operations (creating notes, adding domains, ingesting sources) — never create source/concept notes, domains, or indexes by hand. Editing existing note content directly is fine.
- wiki-query: answer questions using vault knowledge
- wiki-ingest: save new knowledge to the vault (not Claude's memory)
- wiki-domain: create a new topic area in the vault

When the user shares knowledge, findings, or starts exploring a new topic — proactively ask if they want it saved to the vault. For new topics not covered by existing domains, suggest creating a domain via wiki-domain. The vault is where the user's knowledge lives long-term; Claude's memory is not a substitute.

Searchable JSONL indexes at ${wikiPath}/:
- source-index.jsonl — {title, path, domain, scope, tags, concepts, mocs}
- concept-index.jsonl — {name, path, domains, backlinkCount, isStub}
- moc-index.jsonl — {name, path, sourceCount, sources}
- domain-index.jsonl — {domain, scope, sourceCount, conceptCount}
One JSON record per line — Grep returns complete records.

Hard rules:
- For research papers, use \`commonplace paper:*\` commands instead of pdftotext — they handle section detection, smart extraction, and metadata enrichment.
- Never write Python scripts, shell one-liners, or custom code to parse indexes, check links, or analyze vault state. All analysis is built into \`commonplace\` commands which output human-readable summaries by default. Use \`--json\` flag when machine-parseable output is needed. Use the Grep tool to search JSONL indexes and the Read tool to read JSON files.
- Files in raw/ are permanent originals — never delete, rename, or modify them after ingestion. They are the source of truth for re-ingestion.
- For any question whose answer might live in vault notes, dispatch the wiki-query skill before reaching for Grep yourself — it does the iterative search, graph traversal (hubs, MOCs, citation chains, bridge concepts), and file-back step you'd otherwise skip. Direct Grep is fine for narrow lookups (a known title, a specific path); wiki-query is for questions.${untunedNotice}`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: context,
  },
}));
