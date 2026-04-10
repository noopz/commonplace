#!/usr/bin/env tsx
/**
 * Validate a single file's frontmatter against schema.
 * Usage: npx tsx scripts/validate.ts --vault <path> <file>
 *        npx tsx scripts/validate.ts --vault <path> --stdin-path (reads file path from stdin JSON)
 */

import { parseArgs } from "util";
import { resolveVault, classifyNote, isInVault } from "./lib/vault.js";
import { parseNote, validateFrontmatter } from "./lib/frontmatter.js";
import type { ValidationResult } from "./lib/types.js";

const { values, positionals } = parseArgs({
  options: {
    vault: { type: "string" },
    "stdin-path": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const config = resolveVault(values.vault);

let filePath = positionals[0];

// Read file path from stdin JSON if --stdin-path
if (values["stdin-path"]) {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    const data = JSON.parse(input);
    filePath = data.file_path || data.filePath;
  } catch {
    process.exit(0); // Can't parse stdin, silently exit
  }
}

if (!filePath || !isInVault(filePath, config.vaultPath)) {
  // Not a vault file, nothing to validate
  const result: ValidationResult = { valid: true, errors: [] };
  console.log(JSON.stringify(result));
  process.exit(0);
}

const noteType = classifyNote(filePath, config.vaultPath);
if (noteType === "other") {
  const result: ValidationResult = { valid: true, errors: [] };
  console.log(JSON.stringify(result));
  process.exit(0);
}

try {
  const parsed = parseNote(filePath, config.vaultPath);
  const errors = validateFrontmatter(parsed.frontmatter, noteType);
  const result: ValidationResult = {
    valid: errors.length === 0,
    errors,
  };
  console.log(JSON.stringify(result));
} catch (err) {
  const result: ValidationResult = {
    valid: false,
    errors: [
      {
        field: "_parse",
        message: `Failed to parse file: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
  };
  console.log(JSON.stringify(result));
}
