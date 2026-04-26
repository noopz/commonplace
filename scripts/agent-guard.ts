#!/usr/bin/env tsx
/**
 * PreToolUse hook for Agent/Task dispatches.
 *
 * Catches the failure mode where the model dispatches a general-purpose
 * Agent to research vault content instead of using the wiki-query skill.
 * wiki-query already does the iterative semantic search, MOC graph
 * traversal, and file-back step — re-implementing that inside an ad-hoc
 * Agent prompt is wasteful and skips the file-back.
 *
 * Triggers ONLY when:
 *   1. tool is Agent / Task
 *   2. subagent_type is "general-purpose" (or unspecified)
 *   3. prompt contains strong vault-intent signals
 *
 * Code-specific subagents (code-explorer, code-reviewer, etc.) pass
 * through. Prompts without vault-intent signals pass through. The hook
 * is a no-op outside vault contexts and on code work that happens to
 * mention the vault generically.
 */

import { readFileSync } from "fs";
import { join } from "path";

interface HookInput {
  tool_name: string;
  tool_input: {
    subagent_type?: string;
    prompt?: string;
    description?: string;
  };
}

const input = JSON.parse(readFileSync(0, "utf-8")) as HookInput;
const { tool_name, tool_input } = input;

if (tool_name !== "Agent" && tool_name !== "Task") process.exit(0);

const subagentType = tool_input.subagent_type ?? "general-purpose";
if (subagentType !== "general-purpose") process.exit(0);

const prompt = `${tool_input.prompt ?? ""} ${tool_input.description ?? ""}`;

// Resolve vault path via the same mechanism scripts/session-context.ts uses.
// Env vars are populated by Claude Code; .vault-path stores an absolute path
// in OS-native form (forward slashes on POSIX, backslashes on Windows).
let vaultPath: string | undefined;
const candidates: string[] = [];
if (process.env.CLAUDE_PLUGIN_DATA) {
  candidates.push(join(process.env.CLAUDE_PLUGIN_DATA, ".vault-path"));
}
if (process.env.CLAUDE_PLUGIN_ROOT) {
  candidates.push(join(process.env.CLAUDE_PLUGIN_ROOT, ".vault-path"));
}
for (const p of candidates) {
  try {
    const v = readFileSync(p, "utf-8").trim();
    if (v) { vaultPath = v; break; }
  } catch { /* try next */ }
}

// Vault-intent signals. Folder markers use [\\/] to match either separator
// so a Windows path like .wiki\foo and a POSIX path like .wiki/foo both hit.
const signals: RegExp[] = [
  /\bwiki-(query|ingest|domain|compile|deep-linker|moc-updater|linter|pruner|freshness-checker|domain-manager|conventions-tuner|cross-domain-linker|impact-checker)\b/i,
  /\bcommonplace\b/i,
  /\bMOC\b/,
  /\bobsidian\s+vault\b/i,
  /\b(my|the)\s+vault\b/i,
  /\b(concept|source|MOC)\s+note\b/i,
  /\bmy\s+notes\s+(on|about|say)\b/i,
  /\.wiki[\\/]/,
  /\.obsidian[\\/]/,
  /\[\[[^\[\]\n]+\]\]/, // [[Wikilink]] syntax — unmistakable vault-intent marker
];

function pathMentioned(text: string, vault: string): boolean {
  // Normalize separators + case for cross-platform comparison
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  return norm(text).includes(norm(vault));
}

const matched =
  signals.some((re) => re.test(prompt)) ||
  (vaultPath !== undefined && pathMentioned(prompt, vaultPath));

if (!matched) process.exit(0);

const reason =
  `Vault-content question detected. Use the wiki-query skill instead — ` +
  `call \`Skill(skill='wiki-query', args='<your question>')\`. ` +
  `wiki-query handles iterative semantic search, MOC graph traversal, and ` +
  `file-back automatically. If this is genuinely not a vault question ` +
  `(e.g. "vault" used in a non-Obsidian sense), re-dispatch with a prompt ` +
  `that omits the vault-shaped terminology.`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
}));
