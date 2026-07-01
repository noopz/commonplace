import { execFileSync } from "child_process";

/**
 * Returns the commit hash of the last commit that touched `relPath` inside
 * `vaultPath`, or null if the path was never committed or vaultPath isn't a
 * git repo. Never throws — staleness checks must treat "unknown" (null) as
 * distinct from "stale" (hash mismatch).
 */
export function currentHash(vaultPath: string, relPath: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%H", "--", relPath],
      { cwd: vaultPath, stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
    )
      .toString()
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
