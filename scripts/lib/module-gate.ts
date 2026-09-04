/**
 * Whether the in-process hooks module is live for THIS session.
 *
 * WHY THIS IS NOT JUST AN ENV-VAR CHECK
 * `hooks/hooks.json` wires both the shell hooks and the in-process module on
 * purpose, so a broken module degrades to current behaviour rather than to
 * nothing. That only works if exactly one of the two does each job, and the
 * shell scripts decided by reading CLAUDE_CODE_ENABLE_FUNCTION_HOOKS.
 *
 * That gate is incomplete: the module ALSO loads for anyone in the
 * `tengu_plugin_hooks_modules` rollout, with no env var set anywhere. Such a
 * session would run both wirings — two prompt-context blocks per prompt, and
 * two concurrent index rebuilds per vault write, which is the exact race
 * v1.57.1 was written to remove.
 *
 * So the module announces itself instead of being inferred. At session start it
 * writes its session id to `<vault>/.wiki/<MODULE_MARKER>`, and a shell hook
 * stands down when that id matches the one on its own stdin payload. Comparing
 * ids rather than timestamps means no staleness window to tune: a marker left
 * behind by a previous session simply does not match.
 */

import { readFileSync } from "fs";
import { join } from "path";

/** Written by `hooks/register.ts` at session.start, under the vault's `.wiki/`. */
export const MODULE_MARKER = "hooks-module.json";

/**
 * True when the in-process module is handling this session's hooks.
 *
 * Fails OPEN (returns false, shell hook proceeds) on anything unreadable: a
 * missing marker is the normal case for the large majority of users, and
 * treating an unreadable one as "module is live" would silently disable the
 * shell hooks that are the whole plugin for them.
 */
export function moduleIsLive(
  sessionId: string | undefined,
  vaultPath: string | undefined,
): boolean {
  if (process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === "1") return true;
  if (!sessionId || !vaultPath) return false;
  try {
    const raw = readFileSync(join(vaultPath, ".wiki", MODULE_MARKER), "utf-8");
    return (JSON.parse(raw) as { sessionId?: string }).sessionId === sessionId;
  } catch {
    return false;
  }
}
