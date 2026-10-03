#!/usr/bin/env tsx
/**
 * `commonplace test:ui` — run `ui-tests/*.test.tsx` under `claude plugin test`.
 *
 * `claude plugin test <dir>` runs EVERY `*.test.ts(x)` under the folder in the
 * module's sandbox, and this repo's node:test suites (scripts/, hooks/lib/)
 * import Node and cannot load there. So the module is staged into a temp
 * folder — manifest, `hooks/` without its node tests, `types/` — with only the
 * UI tests beside it, and the kit runs against that copy. The module the
 * staged tests load is byte-identical to the one a session loads.
 *
 * Exits with `claude plugin test`'s status.
 */

import { cpSync, mkdtempSync, rmSync, readdirSync, mkdirSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dirname!, "..");
const stage = mkdtempSync(join(tmpdir(), "commonplace-ui-"));
const isNodeTest = (p: string) => /\.test\.tsx?$/.test(p);

try {
  cpSync(join(ROOT, ".claude-plugin", "plugin.json"), join(stage, ".claude-plugin", "plugin.json"));
  cpSync(join(ROOT, "hooks"), join(stage, "hooks"), { recursive: true, filter: (src) => !isNodeTest(src) });
  cpSync(join(ROOT, "types"), join(stage, "types"), { recursive: true });
  mkdirSync(join(stage, "ui-tests"), { recursive: true });
  for (const f of readdirSync(join(ROOT, "ui-tests"))) {
    if (isNodeTest(f) || f.endsWith(".ts") || f.endsWith(".tsx")) copyFileSync(join(ROOT, "ui-tests", f), join(stage, "ui-tests", basename(f)));
  }
  const r = spawnSync("claude", ["plugin", "test", stage], { stdio: "inherit" });
  process.exitCode = r.status ?? 1;
} finally {
  if (!process.env.COMMONPLACE_KEEP_STAGE) rmSync(stage, { recursive: true, force: true });
  else console.error(`staged at ${stage}`);
}
