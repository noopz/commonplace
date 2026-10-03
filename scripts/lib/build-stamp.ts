/**
 * The newest mtime across everything a `dist/` bundle is built from.
 *
 * Shared by `scripts/build.ts` (written into `dist/stamp.json`) and mirrored
 * in `bin/commonplace`, which runs a bundle only when no source is newer than
 * its stamp. Walks `scripts/`, `evals/`, `hooks/lib/` — not `node_modules`.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const STAMP_DIRS = ["scripts", "evals", join("hooks", "lib")];

export function newestSourceMtime(root: string): number {
  let newest = 0;
  const walk = (dir: string) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  for (const d of STAMP_DIRS) walk(join(root, d));
  return newest;
}
