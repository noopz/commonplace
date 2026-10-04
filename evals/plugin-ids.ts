/**
 * Every id this machine knows commonplace by. Plugin options and
 * `enabledPlugins` are keyed by the full id (`name@marketplace`), so a
 * `--settings` override keyed only by the bare name never reaches an
 * installed copy — eval:prime ran with prime silently off because of that.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export function commonplaceIds(): string[] {
  const ids = new Set(["commonplace", "commonplace@inline"]);
  try {
    const installed = readFileSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf-8");
    for (const m of installed.matchAll(/"(commonplace@[^"]+)"/g)) ids.add(m[1]);
  } catch {
    /* nothing installed: --plugin-dir runs use the bare names */
  }
  return [...ids];
}

/** `--settings` for a bare model call: commonplace off, so it neither hooks nor logs. */
export const PLUGIN_OFF_SETTINGS = (): string =>
  JSON.stringify({ enabledPlugins: Object.fromEntries(commonplaceIds().map((id) => [id, false])) });
