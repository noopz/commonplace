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
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { discoverVault, getVaultConfig, isInVault, classifyNote } from "./lib/vault.js";
import { parseNote, validateFrontmatter } from "./lib/frontmatter.js";
import { execSync } from "child_process";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
  },
});

// Read stdin for tool input JSON
let filePath: string | undefined;
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
    filePath = data.file_path || data.filePath;
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

const output: { validate?: unknown; index?: string; scopeCheck?: unknown } = {};

// Step 1: Validate frontmatter
try {
  const parsed = parseNote(filePath, config.vaultPath);
  const errors = validateFrontmatter(parsed.frontmatter, noteType);
  if (errors.length > 0) {
    output.validate = { valid: false, errors };
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

// Only output if there were issues
if (output.validate || output.scopeCheck) {
  console.log(JSON.stringify(output));
}
