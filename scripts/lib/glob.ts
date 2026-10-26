import { globSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Node's built-in glob with the npm `glob` defaults the scripts relied on:
 * dot entries are skipped and paths come back absolute. `ignoreDirs` are
 * top-level folder names (relative to `cwd`) left out entirely.
 */
export function globFiles(pattern: string, cwd: string, ignoreDirs: string[] = []): string[] {
  const skip = new Set(ignoreDirs);
  return globSync(pattern, { cwd, exclude: (p: string) => basename(p).startsWith(".") || skip.has(p) })
    .map((rel) => join(cwd, rel));
}
