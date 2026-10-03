/**
 * Script readers merge `sealed/<shard>/records.jsonl` rows only for shards
 * named in COMMONPLACE_OPEN, and the indexer writes no v1 `*-index.jsonl`
 * (invented vault).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getVaultConfig, readLegacyIndex, openShardsFromEnv } from "./lib/vault.ts";

const ROOT = join(import.meta.dirname!, "..");

test("openShardsFromEnv parses ids and *", () => {
  assert.deepEqual([...openShardsFromEnv({ COMMONPLACE_OPEN: "gamma, delta" }).shards], ["gamma", "delta"]);
  assert.equal(openShardsFromEnv({ COMMONPLACE_OPEN: "*" }).all, true);
  assert.equal(openShardsFromEnv({}).shards.size, 0);
});

test("private records merge per open shard only", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-open-vault-"));
  const prev = process.env.COMMONPLACE_OPEN;
  try {
    mkdirSync(join(root, ".wiki"), { recursive: true });
    writeFileSync(join(root, ".wiki", "config.json"), JSON.stringify({ structure: { sources: "Research", concepts: "Concepts", mocs: "Maps" } }));
    writeFileSync(join(root, ".wiki", "domains.json"), JSON.stringify({
      domains: {
        alpha: { path: "Research/Alpha", scope: "public" },
        gamma: { path: "Research/Gamma", scope: "private" },
        delta: { path: "Research/Delta", scope: "private" },
      },
    }));
    for (const [rel, body] of [
      ["Research/Alpha/Acme Report.md", "# Acme Report\n"],
      ["Research/Gamma/Gamma Ledger.md", "# Gamma Ledger\n"],
      ["Research/Delta/Delta Chart.md", "# Delta Chart\n"],
    ]) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), `---\ntags: [paper]\n---\n${body}`);
    }
    execFileSync(process.execPath, [join(ROOT, "bin", "commonplace"), "index", "--vault", root], { stdio: "ignore" });
    for (const v1 of ["source", "concept", "moc", "domain", "backlink"]) {
      assert.ok(!existsSync(join(root, ".wiki", `${v1}-index.jsonl`)), `${v1}-index.jsonl written`);
    }
    assert.ok(!existsSync(join(root, ".wiki", "sealed", "legacy")));
    const cfg = getVaultConfig(root);
    const titles = () => readLegacyIndex<{ title: string }>(cfg, "source").map((r) => r.title).sort();
    delete process.env.COMMONPLACE_OPEN;
    assert.deepEqual(titles(), ["Acme Report"]);
    process.env.COMMONPLACE_OPEN = "gamma";
    assert.deepEqual(titles(), ["Acme Report", "Gamma Ledger"]);
    process.env.COMMONPLACE_OPEN = "*";
    assert.deepEqual(titles(), ["Acme Report", "Delta Chart", "Gamma Ledger"]);
    assert.ok(!readLegacyIndex<Record<string, unknown>>(cfg, "source").some((r) => "shard" in r));
  } finally {
    if (prev === undefined) delete process.env.COMMONPLACE_OPEN;
    else process.env.COMMONPLACE_OPEN = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
