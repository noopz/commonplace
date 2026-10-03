/**
 * `bin/commonplace vault-path` (plain JS, instant) and `chooseVault()` (the
 * TS resolver every script uses) must pick the same vault.
 *
 * They disagreed for several releases: the bin checked the registry default
 * BEFORE the cwd walk-up, so a session inside vault B printed the default A
 * while `seed`/`connect` resolved B. Each case runs both in a child process
 * against one isolated plugin-data dir.
 *
 * FIXTURES ARE INVENTED (alpha/beta/gamma vaults in a temp dir).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const repo = join(import.meta.dirname!, "..", "..");
const bin = join(repo, "bin", "commonplace");
const vaultCli = join(repo, "scripts", "vault.ts");

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vp-parity-")));
  const data = join(root, "data");
  const mk = (rel: string, marker = ".wiki") => {
    const p = join(root, rel);
    mkdirSync(join(p, marker), { recursive: true });
    return p;
  };
  const alpha = mk("alpha");
  const beta = mk("beta", ".obsidian");
  const gamma = mk("gamma");
  const repoDir = join(root, "repos", "app");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(data, { recursive: true });
  const writeReg = (def: string) =>
    writeFileSync(join(data, "vaults.json"), JSON.stringify({
      default: def,
      vaults: [
        { id: "alpha", path: alpha, label: "Alpha", aliases: ["work"] },
        { id: "beta", path: beta, label: "Beta", aliases: [] },
        { id: "gamma", path: gamma, label: "Gamma", aliases: [], isPrivate: true },
      ],
    }));
  writeReg("alpha");
  writeFileSync(join(data, "vault-pins.json"), "{}");
  return { root, data, alpha, beta, gamma, repoDir, writeReg };
}

function viaBin(data: string, cwd: string, extra: string[] = []): string | null {
  const r = spawnSync(process.execPath, [bin, "vault-path", ...extra], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: data, COMMONPLACE_CALLER_CWD: cwd, HOME: data },
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

function viaResolver(data: string, cwd: string): string | null {
  const out = execFileSync(process.execPath, ["--import", "tsx", vaultCli, "show", "--json"], {
    encoding: "utf-8",
    cwd: repo,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: data, COMMONPLACE_CALLER_CWD: cwd, HOME: data },
  }).trim();
  const parsed = JSON.parse(out);
  return parsed ? String(parsed.path) : null;
}

test("bin vault-path and chooseVault agree on every precedence rule", () => {
  const f = setup();
  try {
    const cases: Array<[string, string, string | null]> = [
      ["cwd inside a non-default vault beats the default", join(f.beta), f.beta],
      ["cwd inside a private vault selects it", f.gamma, f.gamma],
      ["unrelated cwd falls back to the default", f.repoDir, f.alpha],
    ];
    for (const [label, cwd, want] of cases) {
      assert.equal(viaBin(f.data, cwd), want, `bin: ${label}`);
      assert.equal(viaResolver(f.data, cwd), want, `resolver: ${label}`);
    }

    // A pin beats both the walk-up and the default, and covers subdirectories.
    writeFileSync(join(f.data, "vault-pins.json"), JSON.stringify({ [f.repoDir]: "beta" }));
    for (const cwd of [f.repoDir, join(f.repoDir, "src")]) {
      assert.equal(viaBin(f.data, cwd), f.beta, "bin: pin");
      assert.equal(viaResolver(f.data, cwd), f.beta, "resolver: pin");
    }
    writeFileSync(join(f.data, "vault-pins.json"), "{}");

    // --vault accepts an alias (bin only — scripts take it as their own flag).
    assert.equal(viaBin(f.data, f.repoDir, ["--vault", "work"]), f.alpha);

    // A private vault named as default is never used as the fallback.
    f.writeReg("gamma");
    assert.equal(viaBin(f.data, f.repoDir), null, "bin: private default ignored");
    assert.equal(viaResolver(f.data, f.repoDir), null, "resolver: private default ignored");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
