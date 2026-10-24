#!/usr/bin/env tsx
/**
 * Prune old plugin cache versions.
 *
 * Claude Code's marketplace gives each plugin version its own cache dir
 * (`~/.claude/plugins/cache/<owner>/<plugin>/<version>/`), and the
 * SessionStart hook installs node_modules into that per-version dir
 * (~79MB). After many updates, every old version's node_modules sits
 * around forever — Claude Code never garbage-collects them. After 17
 * releases that's 1.3GB of dead weight per plugin.
 *
 * This script removes sibling version dirs of the current one. It only
 * acts on dirs whose name matches a strict semver pattern, so any
 * non-version sibling (cache metadata, lockfiles, etc.) is left alone.
 *
 * A version used in the last IN_USE_MS is kept: another session may still be
 * running from it. Deleting its bin/ and dist/ under a live module made every
 * CLI spawn fail, the guard load zero vaults, and sealing switch off for the
 * rest of that session. "Used" is the newest write to its `.runtime/` (the
 * module and the SessionStart hook both write there each session), else the
 * dir's own mtime.
 *
 * Trade-off: a user can no longer roll back to an old version by
 * selecting it in the marketplace UI without re-downloading. The
 * marketplace will fetch it fresh on demand.
 */

import { readdirSync, statSync, rmSync } from "fs";
import { dirname, basename, join } from "path";

const root = process.env.CLAUDE_PLUGIN_ROOT;
if (!root) process.exit(0);

const parent = dirname(root);
const current = basename(root);

let entries: string[];
try {
  entries = readdirSync(parent);
} catch {
  process.exit(0);
}

const semverRe = /^\d+\.\d+\.\d+$/;
const IN_USE_MS = 7 * 24 * 60 * 60 * 1000;

function lastUsed(dir: string): number {
  let t = statSync(dir).mtimeMs;
  try {
    const rt = join(dir, ".runtime");
    for (const f of readdirSync(rt)) t = Math.max(t, statSync(join(rt, f)).mtimeMs);
  } catch { /* no .runtime: the dir's mtime stands */ }
  return t;
}
const removed: string[] = [];

for (const entry of entries) {
  if (entry === current) continue;
  if (!semverRe.test(entry)) continue;
  const path = join(parent, entry);
  try {
    const st = statSync(path);
    if (!st.isDirectory()) continue;
    if (Date.now() - lastUsed(path) < IN_USE_MS) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(entry);
  } catch { /* skip — best effort */ }
}

if (removed.length > 0) {
  console.error(`Pruned ${removed.length} old plugin cache version(s): ${removed.join(", ")}`);
}
