#!/usr/bin/env tsx
/**
 * UserPromptSubmit hook: emits additionalContext only when the user's
 * prompt has explicit vault intent. Replaces the old SessionStart auto-
 * push, which fired on every session boot regardless of cwd or topic
 * and surfaced vault stats in unrelated project directories.
 *
 * Two output tiers, gated by cwd:
 *   - Inside vault → full snapshot (counts, untuned genres, hard rules,
 *     activity log) for grounded answers and context-aware editing.
 *   - Outside vault → one-line nudge: vault is at <path>; route reads
 *     through wiki-query and writes through wiki-ingest. Skill
 *     name+description are always loaded by Claude Code, so we don't
 *     need to teach the model what those skills are — just to use them
 *     instead of bare Grep/Edit on vault files.
 *
 * No vault intent → exit silently, no context emitted.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { hasVaultIntent } from "./lib/vault-signals.js";
import { isCwdInVault, loadVaultRegistry } from "./lib/vault.js";

interface HookInput {
  prompt?: string;
  cwd?: string;
}

const input = JSON.parse(readFileSync(0, "utf-8")) as HookInput;
const prompt = input.prompt ?? "";
const cwd = input.cwd ?? process.cwd();

const { inVault, vaultPath } = isCwdInVault(cwd);

if (!vaultPath) process.exit(0); // plugin not configured for any vault yet
const vaultPaths = loadVaultRegistry().vaults.map((v) => v.path);
if (!hasVaultIntent(prompt, vaultPaths)) process.exit(0);

function emit(context: string): never {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  }));
  process.exit(0);
}

if (!inVault) {
  emit(
    `The commonplace vault is at ${vaultPath}. Route vault reads through the wiki-query skill ` +
    `(it does iterative search, MOC graph traversal, and file-back automatically) and vault writes ` +
    `through wiki-ingest. Don't grep or edit vault files directly — those skills exist for the same ` +
    `reason linters exist: to keep the structure consistent.`
  );
}

// In-vault: full snapshot.
const wikiPath = join(vaultPath, ".wiki");

function countLines(path: string): number {
  try { return readFileSync(path, "utf-8").trim().split("\n").length; } catch { return 0; }
}

const sourceCount = countLines(join(wikiPath, "source-index.jsonl"));
const conceptCount = countLines(join(wikiPath, "concept-index.jsonl"));
const mocCount = countLines(join(wikiPath, "moc-index.jsonl"));

if (sourceCount === 0) process.exit(0);

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

emit(`The commonplace wiki plugin is active for ${vaultPath} (${sourceCount} sources, ${conceptCount} concepts, ${mocCount} MOCs). The vault is the user's persistent knowledge base — use it instead of Claude's memory.

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
- For any question whose answer might live in vault notes, dispatch the wiki-query skill before reaching for Grep yourself — it does the iterative search, graph traversal (hubs, MOCs, citation chains, bridge concepts), and file-back step you'd otherwise skip. Direct Grep is fine for narrow lookups (a known title, a specific path); wiki-query is for questions.${untunedNotice}`);
