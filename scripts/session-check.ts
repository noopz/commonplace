#!/usr/bin/env tsx
/**
 * The one remaining shell hook (SessionStart). Three jobs:
 *
 *   1. Keep `dist/` fresh: rebuild the esbuild bundle when a source is newer
 *      than its stamp (after a plugin update), so `commonplace <cmd>` runs on
 *      plain node instead of a tsx cold start.
 *   2. Run cache cleanup (what the old SessionStart did).
 *   3. WATCHDOG. v2 has no shell fallback for the guards and context — the
 *      in-process module IS the plugin. If modules are disabled (org policy, an
 *      old build), the plugin silently does almost nothing. So: this script
 *      increments `.runtime/shell-sessions` every session; the module resets it
 *      to 0 at its own session.start and writes `.runtime/module-alive.json`.
 *      Two consecutive sessions without the module → print a systemMessage.
 *      The counter (not this session's stamp) is what's checked, because this
 *      hook and the module's session.start run concurrently. `compact` and
 *      `clear` are skipped: they fire this hook but not the module's start.
 *
 * Prints at most one JSON line on stdout (`{"systemMessage": ...}`); never
 * fails the session.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { newestSourceMtime } from "./lib/build-stamp.js";

const root = join(import.meta.dirname!, "..");
const runtime = join(root, ".runtime");
const messages: string[] = [];

function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, "utf-8")) as T; } catch { return null; }
}

// 1. dist freshness
try {
  const stamp = readJson<{ newestSourceMtime: number }>(join(root, "dist", "stamp.json"));
  const stale = !stamp || newestSourceMtime(root) > stamp.newestSourceMtime;
  const esbuild = join(root, "node_modules", "esbuild");
  if (stale && existsSync(esbuild)) {
    spawnSync(process.execPath, [join(root, "node_modules", ".bin", "tsx"), join(root, "scripts", "build.ts")], {
      cwd: root, stdio: "ignore", timeout: 60_000,
    });
  }
} catch { /* tsx fallback still works */ }

// 2. cache cleanup
try {
  spawnSync(process.execPath, [join(root, "node_modules", ".bin", "tsx"), join(root, "scripts", "cleanup-cache.ts")], {
    cwd: root, stdio: "ignore", timeout: 30_000,
  });
} catch {}

// 3. watchdog. The shell SessionStart also fires on `compact` and `clear`,
// where the module's session.start does not (module memory survives both), so
// counting those would report a live module as missing after two compacts.
function hookSource(): string {
  if (process.stdin.isTTY) return "";
  try { return String(JSON.parse(readFileSync(0, "utf-8")).source ?? ""); } catch { return ""; }
}
const source = hookSource();
if (source !== "compact" && source !== "clear") try {
  mkdirSync(runtime, { recursive: true });
  const counterPath = join(runtime, "shell-sessions");
  let prev = 0;
  try { prev = Number(readFileSync(counterPath, "utf-8").trim()) || 0; } catch {}
  const n = prev + 1;
  writeFileSync(counterPath, String(n));
  const alive = readJson<{ tooOld?: boolean; base?: string }>(join(runtime, "module-alive.json"));
  if (alive?.tooOld) {
    messages.push(
      `commonplace: this Claude Code build (${alive.base ?? "unknown"}) is older than the plugin needs ` +
      "(2.1.288+). Vault tools, guards and context are off until Claude Code is updated.",
    );
  } else if (n >= 2) {
    messages.push(
      "commonplace: its in-process module has not loaded for the last few sessions, so vault tools, " +
      "private-domain guards and ambient connections are off. Plugin modules may be disabled by " +
      "settings or policy; the `commonplace` CLI still works.",
    );
  }
} catch {}

if (messages.length > 0) console.log(JSON.stringify({ systemMessage: messages.join("\n") }));
