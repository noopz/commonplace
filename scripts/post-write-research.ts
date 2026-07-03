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
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { discoverVault, loadDomainRegistry } from "./lib/vault.js";
import { inferSourceDomain } from "./lib/domain.js";

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

// Only act on files that resolve to a registered vault domain. Discover the
// vault from the written file's own path so the impact / cross-domain checks
// run against the vault that file actually lives in — not whatever happens
// to be the registry default. (The old gate matched the literal substring
// "/Research/", which never matches numbered folder conventions like
// "02 - Research/" — the character before "Research" is a space, not a
// slash — so for such vaults this hook never fired at all.)
const pluginRoot = join(import.meta.dirname!, "..");
const vaultPath = discoverVault(dirname(filePath));
if (!vaultPath) process.exit(0);

const registry = loadDomainRegistry(join(vaultPath, ".wiki")); // domains.json lives under .wiki/
if (inferSourceDomain(filePath, vaultPath, registry) === "unknown") {
  process.exit(0);
}

const tsx = join(pluginRoot, "node_modules", ".bin", "tsx");

// Refresh the index first. This hook and the `post-write` hook both fire on
// Write and Claude Code runs matching hooks in parallel, so we cannot assume
// `post-write` has already rebuilt the index — without this, impact.ts would
// read a stale index that doesn't yet contain the file we just wrote and
// silently find nothing. Incremental indexing is mtime-gated, so a redundant
// run here is close to a no-op.
spawnSync(tsx, [
  join(pluginRoot, "scripts", "index.ts"),
  "--vault", vaultPath,
  "--incremental",
], { encoding: "utf-8", cwd: pluginRoot, timeout: 15000 });

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
let hasConsolidation = false;
try {
  const impact = JSON.parse(impactJson);
  hasImpact = impact.affected?.length > 0;
  hasConsolidation = impact.consolidation?.length > 0;
} catch {}
try {
  const cross = JSON.parse(crossJson);
  hasCross = cross.results?.length > 0 &&
    cross.results.some((r: { bridgeConcepts?: unknown[] }) => r.bridgeConcepts?.length > 0);
} catch {}

if (!hasImpact && !hasCross && !hasConsolidation) {
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

if (hasConsolidation) {
  if (parts.length > 0) parts.push("");
  parts.push(
    `Consolidation candidates found: the new source's abstraction substantially overlaps existing sources' (${filePath}).`,
    ...(hasImpact ? [] : [`Impact results: ${impactJson}`]),
    "",
    "NEVER merge source notes — they carry citation identity and provenance. Flag-and-link only:",
    "- Dispatch the commonplace:wiki-impact-checker agent with the vault path and the new source path; its consolidation procedure decides supersession (route to wiki-supersede), complementary cross-links, or false positive (drop).",
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
    "",
    "Also mention this to the user directly, in conversation — not only as a file edit: this source connects to <affected domain>'s <affected note title> (via <bridge concept>). If anything else discussed in this session relates to that same connection, say so and ask whether it should be captured too.",
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
