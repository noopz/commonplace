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
const removed: string[] = [];

for (const entry of entries) {
  if (entry === current) continue;
  if (!semverRe.test(entry)) continue;
  const path = join(parent, entry);
  try {
    const st = statSync(path);
    if (!st.isDirectory()) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(entry);
  } catch { /* skip — best effort */ }
}

if (removed.length > 0) {
  console.error(`Pruned ${removed.length} old plugin cache version(s): ${removed.join(", ")}`);
}
