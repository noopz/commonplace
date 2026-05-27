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
import { hasVaultIntent } from "./lib/vault-signals.js";
import { loadVaultRegistry } from "./lib/vault.js";

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

// Test the prompt against EVERY registered vault path — with many vaults,
// a path mention for any of them is vault intent, not just the default.
const vaultPaths = loadVaultRegistry().vaults.map((v) => v.path);

if (!hasVaultIntent(prompt, vaultPaths)) process.exit(0);

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
