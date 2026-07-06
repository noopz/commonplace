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
 *   3. cwd is NOT inside commonplace's own source repo
 *   4. prompt contains strong vault-intent signals
 *
 * Code-specific subagents (code-explorer, code-reviewer, etc.) pass
 * through. Prompts without vault-intent signals pass through. The hook
 * is a no-op outside vault contexts and on code work that happens to
 * mention the vault generically.
 *
 * Exemption: when cwd is inside commonplace's own repo (walk-up finds a
 * package.json named "commonplace"), the gate is skipped entirely before
 * hasVaultIntent() even runs. Working on commonplace's source is
 * necessarily dense with wiki-shaped vocabulary (wikilink, wiki-*,
 * .wiki/) without being a vault-content question — there's no vault
 * being queried, just code that implements one.
 *
 * Override: the guard only means to catch RESEARCH dispatches (an ad-hoc
 * agent re-implementing wiki-query's search). Orchestrated WORK — fanning
 * out general-purpose workers to compile, fix, lint, or edit many notes in
 * parallel — is a legitimate pattern, but its prompts intrinsically carry
 * vault vocabulary ([[wikilinks]], "source note", .wiki/, the vault path),
 * so hasVaultIntent() can't tell them apart from a question. An orchestrator
 * signals intent by including the marker ALLOW_VAULT_AGENT in the dispatch
 * prompt; the guard then passes it through. The deny message below teaches
 * this, so a blocked caller redirects to wiki-query (if research) or
 * re-dispatches with the marker (if work) — never silently falls back to
 * doing the whole job inline.
 */

import { readFileSync } from "fs";
import { hasVaultIntent } from "./lib/vault-signals.js";
import { loadVaultRegistry, isCwdInCommonplaceRepo } from "./lib/vault.js";

interface HookInput {
  tool_name: string;
  tool_input: {
    subagent_type?: string;
    prompt?: string;
    description?: string;
  };
  cwd?: string;
}

const input = JSON.parse(readFileSync(0, "utf-8")) as HookInput;
const { tool_name, tool_input } = input;
const cwd = input.cwd ?? process.cwd();

if (tool_name !== "Agent" && tool_name !== "Task") process.exit(0);

const subagentType = tool_input.subagent_type ?? "general-purpose";
if (subagentType !== "general-purpose") process.exit(0);

if (isCwdInCommonplaceRepo(cwd)) process.exit(0);

const prompt = `${tool_input.prompt ?? ""} ${tool_input.description ?? ""}`;

// Explicit override: an orchestrator dispatching intentional parallel WORK
// (compile / fix / lint / edit across many notes) rather than a research
// lookup includes this marker to bypass the guard. Deterministic escape so
// legitimate fan-out isn't blocked by vault vocabulary it can't avoid using.
if (/\bALLOW_VAULT_AGENT\b/.test(prompt)) process.exit(0);

// Test the prompt against EVERY registered vault path — with many vaults,
// a path mention for any of them is vault intent, not just the default.
const vaultPaths = loadVaultRegistry().vaults.map((v) => v.path);

if (!hasVaultIntent(prompt, vaultPaths)) process.exit(0);

const reason =
  `This general-purpose agent's prompt looks vault-shaped. Two legitimate paths — pick one, don't fall back to doing the whole job inline:\n` +
  `1. RESEARCH / lookup ("how does X relate to Y", "what do the notes say"): use the wiki-query skill instead — ` +
  `call \`Skill(skill='wiki-query', args='<your question>')\`. It does iterative semantic search, MOC graph traversal, and file-back automatically.\n` +
  `2. Orchestrated WORK (compiling, fixing, linting, or editing many notes as parallel workers — a valid pattern): re-dispatch the SAME agent with the marker ALLOW_VAULT_AGENT added to its prompt to bypass this guard.\n` +
  `(If "vault" was meant in a non-Obsidian sense, re-dispatch without the vault-shaped terminology.)`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
}));
