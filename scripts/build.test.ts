/**
 * The esbuild bundle must behave like the tsx source — in particular every
 * `import.meta.dirname`/`url` must still resolve relative to the ORIGINAL
 * source file, or plugin-root lookups (vaults.json, pins) silently move into
 * dist/. Builds into a temp dir (never the live dist/, which concurrent tests
 * use) and compares one command's output both ways.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname!, "..");

test("bundled and tsx commands agree, including plugin-root-relative lookups", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "build-parity-")));
  const out = join(root, "dist");
  execFileSync(process.execPath, ["--import", "tsx", join(repo, "scripts", "build.ts"), "--out", out], { cwd: repo, encoding: "utf-8" });
  try {
    const vault = join(root, "alpha");
    mkdirSync(join(vault, ".wiki"), { recursive: true });
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: join(root, "data"),
      HOME: root,
      COMMONPLACE_CALLER_CWD: join(root, "elsewhere"),
    };
    mkdirSync(env.CLAUDE_PLUGIN_DATA, { recursive: true });
    writeFileSync(join(env.CLAUDE_PLUGIN_DATA, "vaults.json"), JSON.stringify({
      default: "alpha", vaults: [{ id: "alpha", path: vault, label: "Alpha", aliases: [] }],
    }));
    const run = (bundle: boolean) =>
      execFileSync(process.execPath, bundle
        ? [join(out, "scripts", "vault.mjs"), "show", "--json"]
        : [join(repo, "bin", "commonplace"), "vault", "show", "--json"], {
        encoding: "utf-8",
        cwd: repo,
        env: { ...env, COMMONPLACE_NO_DIST: "1" },
      }).trim();
    const bundled = run(true);
    assert.equal(bundled, run(false));
    assert.match(bundled, /"via":"default"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
