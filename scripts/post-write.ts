#!/usr/bin/env tsx
/**
 * Combined post-write hook pipeline: validate → index → scope-check.
 * Reads file path from stdin JSON (PostToolUse hook provides tool input on stdin).
 * Exits silently for non-vault files.
 *
 * Usage (as hook): stdin receives tool input JSON
 * Usage (manual): echo '{"file_path":"/path/to/file.md"}' | npx tsx scripts/post-write.ts --vault <path>
 */

import { parseArgs } from "util";
import { existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { discoverVault, getVaultConfig, isInVault, classifyNote } from "./lib/vault.js";
import { parseNote, validateFrontmatter } from "./lib/frontmatter.js";
import { sanitizeIngestedBody, splitFrontmatterRaw } from "./lib/sanitize.js";
import { moduleIsLive } from "./lib/module-gate.js";
import { execSync } from "child_process";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
  },
});

// Read stdin for tool input JSON
let filePath: string | undefined;
let sessionId: string | undefined;
try {
  let input = "";
  // Set a short timeout so we don't hang if there's no stdin
  process.stdin.setEncoding("utf-8");

  // Read available stdin data
  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      process.stdin.destroy();
      resolve();
    }, 1000);

    process.stdin.on("data", (chunk) => {
      chunks.push(chunk as string);
    });

    process.stdin.on("end", () => {
      clearTimeout(timeout);
      resolve();
    });

    process.stdin.on("error", () => {
      clearTimeout(timeout);
      resolve();
    });

    // If stdin is not a TTY, it should provide data
    if (process.stdin.isTTY) {
      clearTimeout(timeout);
      resolve();
    }
  });

  input = chunks.join("");
  if (input.trim()) {
    const data = JSON.parse(input);
    // A PostToolUse hook payload nests the tool's arguments under
    // `tool_input`; only a direct invocation passes a flat `file_path`. This
    // read the flat shape ONLY, so as a PostToolUse hook it found no path and
    // exited silently every time — validate, index, scope-check and the
    // impact/cross-domain chain never ran on a vault write. Accept both.
    filePath =
      data.tool_input?.file_path ||
      data.tool_input?.filePath ||
      data.file_path ||
      data.filePath;
    sessionId = data.session_id;
  }
} catch {
  // No valid stdin, exit silently
  process.exit(0);
}

if (!filePath) process.exit(0);

// Resolve vault: explicit --vault takes precedence, then discover from file path
const vaultPath = values.vault
  ? resolve(values.vault)
  : discoverVault(dirname(filePath));
if (!vaultPath) process.exit(0);

// Double-fire guard. `hooks/hooks.json` wires BOTH the shell PostToolUse hook
// and the in-process module, deliberately, so a broken module degrades to this
// rather than to nothing. When the module is loaded it runs this same script
// itself (via $.process.run) and merges the result into the tool's own
// `context`, so without this guard a vault write would run the whole pipeline
// twice — including two concurrent index rebuilds, the race v1.57.1 removed.
//
// COMMONPLACE_HOOK_CHILD marks the module's own invocation so it is not guarded
// against itself. Runs after vault resolution because `moduleIsLive` reads the
// module's marker from the vault; see scripts/lib/module-gate.ts for why an
// env-var check alone misses the flag-based rollout.
if (
  process.env.COMMONPLACE_HOOK_CHILD !== "1" &&
  moduleIsLive(sessionId, vaultPath)
) {
  process.exit(0);
}

const config = getVaultConfig(vaultPath);

if (!isInVault(filePath, config.vaultPath)) {
  process.exit(0);
}

if (!existsSync(filePath)) {
  process.exit(0);
}

const noteType = classifyNote(filePath, config.vaultPath);
if (noteType === "other") {
  process.exit(0);
}

const output: {
  validate?: unknown;
  index?: string;
  scopeCheck?: unknown;
  supersede?: { target: string; keyword: string };
  sourceWritten?: boolean;
  sanitized?: string[];
} = {};

if (noteType === "source") {
  output.sourceWritten = true;
}

// Step 1: Validate frontmatter + scan body for supersession declarations
try {
  const parsed = parseNote(filePath, config.vaultPath);

  if (noteType === "source") {
    const { frontmatterBlock, body: rawBody } = splitFrontmatterRaw(parsed.raw);
    const { body: cleanBody, stripped } = sanitizeIngestedBody(rawBody);
    if (stripped.length > 0) {
      writeFileSync(filePath, frontmatterBlock + cleanBody);
      output.sanitized = stripped;
    }
  }

  const errors = validateFrontmatter(parsed.frontmatter, noteType);
  if (errors.length > 0) {
    output.validate = { valid: false, errors };
  }
  const supersedeMatch = parsed.body.match(
    /\b(supersedes|replaces|formerly)\s+\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/i,
  );
  if (supersedeMatch) {
    output.supersede = {
      keyword: supersedeMatch[1].toLowerCase(),
      target: supersedeMatch[2].trim(),
    };
  }
} catch (err) {
  output.validate = {
    valid: false,
    errors: [{ field: "_parse", message: String(err) }],
  };
}

// Step 2: Incremental index update
try {
  const scriptDir = new URL(".", import.meta.url).pathname;
  execSync(
    `npx tsx ${scriptDir}index.ts --vault ${config.vaultPath} --incremental`,
    { stdio: "pipe", timeout: 15000 }
  );
  output.index = "updated";
} catch {
  output.index = "failed";
}

// Step 3: Scope check
try {
  const scriptDir = new URL(".", import.meta.url).pathname;
  const result = execSync(
    `npx tsx ${scriptDir}scope-check.ts --vault ${config.vaultPath} "${filePath}"`,
    { stdio: "pipe", timeout: 10000 }
  );
  const violations = JSON.parse(result.toString());
  if (violations.length > 0) {
    output.scopeCheck = violations;
  }
} catch {
  // Scope check failed silently
}

// Step 4: impact + cross-domain analysis.
//
// Runs here, in sequence, rather than as its own PostToolUse hook. Both were
// wired as separate hooks on Write, and Claude Code runs matching hooks in
// parallel — so two `index.ts --incremental` processes wrote the same
// .wiki/*.jsonl files concurrently. Chaining also lets the two hooks' notes
// merge into ONE stdout object: a hook that prints two JSON documents emits
// malformed output and its additionalContext is dropped silently.
let researchContext = "";
try {
  const scriptDir = new URL(".", import.meta.url).pathname;
  const raw = execSync(
    `npx tsx ${scriptDir}post-write-research.ts --file "${filePath}"`,
    { stdio: ["ignore", "pipe", "pipe"], timeout: 60000 },
  ).toString().trim();
  if (raw) {
    researchContext = String(
      JSON.parse(raw)?.hookSpecificOutput?.additionalContext ?? "",
    );
  }
} catch {
  // Analysis is advisory. A failure here must not cost the caller the
  // validate/scope-check results that Step 1-3 already produced.
}

// Only output if there were issues or signals to surface
if (
  researchContext ||
  output.validate ||
  output.scopeCheck ||
  output.supersede ||
  output.sourceWritten ||
  output.sanitized
) {
  const notes: string[] = [];
  if (output.sanitized) {
    notes.push(
      `Sanitized ${output.sanitized.length} item(s) from this note's body before indexing:\n- ${output.sanitized.join("\n- ")}`,
    );
  }
  if (output.supersede) {
    const { keyword, target } = output.supersede;
    notes.push(
      `This note ${keyword} [[${target}]]. To retroactively reframe sibling notes that still treat [[${target}]] as live, invoke the wiki-supersede skill (or run \`commonplace supersede --retire --old "${target}" --new "<this-note-title>" --reason "..."\`).`,
    );
  }
  if (output.sourceWritten) {
    notes.push(
      `Source note written. Vault connectedness opportunity: consider running wiki-lint (orphans, underlinked, weak summaries, bridge thinness) and/or \`/wiki-deep-link\` (embedding-discovered concept connections, requires Ollama).`,
    );
  }
  if (researchContext) notes.push(researchContext);
  if (notes.length > 0) {
    console.log(
      JSON.stringify({
        ...output,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: notes.join("\n\n"),
        },
      }),
    );
  } else {
    console.log(JSON.stringify(output));
  }
}
