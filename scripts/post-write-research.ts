#!/usr/bin/env tsx
/**
 * PostToolUse hook for Research/ file writes.
 * Runs impact + cross-domain checks and returns additionalContext
 * so the main model can act on results — no agent spawn needed.
 *
 * Reads hook context from stdin (JSON with tool_input.file_path).
 * Outputs JSON with hookSpecificOutput.additionalContext on stdout.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

// Read hook context from stdin
let input = "";
try {
  input = readFileSync(0, "utf-8");
} catch {
  process.exit(0);
}

let filePath: string;
try {
  const ctx = JSON.parse(input);
  filePath = ctx.tool_input?.file_path ?? "";
} catch {
  process.exit(0);
}

// Only act on Research/ files
if (!filePath.includes("/Research/")) {
  process.exit(0);
}

// Resolve vault path
const pluginRoot = join(import.meta.dirname!, "..");
let vaultPath: string;
try {
  vaultPath = readFileSync(join(pluginRoot, ".vault-path"), "utf-8").trim();
} catch {
  process.exit(0);
}

const tsx = join(pluginRoot, "node_modules", ".bin", "tsx");

// Run impact check
const impactResult = spawnSync(tsx, [
  join(pluginRoot, "scripts", "impact.ts"),
  "--vault", vaultPath,
  "--source", filePath,
], { encoding: "utf-8", cwd: pluginRoot });

const impactJson = impactResult.stdout?.trim() || "";

// Run cross-domain check
const crossResult = spawnSync(tsx, [
  join(pluginRoot, "scripts", "cross-domain.ts"),
  "--vault", vaultPath,
  "--source", filePath,
], { encoding: "utf-8", cwd: pluginRoot });

const crossJson = crossResult.stdout?.trim() || "";

// Parse results to check if there's anything actionable
let hasImpact = false;
let hasCross = false;
try {
  const impact = JSON.parse(impactJson);
  hasImpact = impact.affected?.length > 0;
} catch {}
try {
  const cross = JSON.parse(crossJson);
  hasCross = cross.results?.length > 0 &&
    cross.results.some((r: { bridgeConcepts?: unknown[] }) => r.bridgeConcepts?.length > 0);
} catch {}

if (!hasImpact && !hasCross) {
  process.exit(0);
}

// Build additionalContext instructions
const parts: string[] = [];

if (hasImpact) {
  parts.push(
    `Impact check found notes affected by the file you just wrote (${filePath}).`,
    `Impact results: ${impactJson}`,
    "",
    "For each affected note (up to 5, ordered by most shared concepts):",
    "- Read the new source's Summary/Key Contributions and the affected note's Connections/Notes sections",
    "- If the new source extends or relates: append `- See also: [[New Source Title]]` to the affected note's Connections section",
    "- If the new source contradicts or supersedes a specific claim: add `> [!update] — [[New Source Title]] changes this analysis` callout to the affected note's Notes section",
    "- Skip if no clear relationship or link already exists",
  );
}

if (hasCross) {
  if (parts.length > 0) parts.push("");
  parts.push(
    `Cross-domain bridge concepts found for ${filePath}.`,
    `Cross-domain results: ${crossJson}`,
    "",
    "For each bridge concept (up to 3, skip generic terms like 'AI' or 'model'):",
    "- Read the new source's Summary and the affected note's Connections section",
    "- If the cross-domain link is substantive: append `- Cross-domain: [[Source Title]] (domain) — via [[Concept]]` to the affected note's Connections section",
    "- Skip if link already exists or concept is too generic",
  );
}

const additionalContext = parts.join("\n");

// Output in hook format
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext,
  },
}));
