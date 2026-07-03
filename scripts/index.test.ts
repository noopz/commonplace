import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dirname!, "index.ts");

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "index-hits-vault-"));
  mkdirSync(join(root, ".wiki"), { recursive: true });
  writeFileSync(join(root, ".wiki", "config.json"), JSON.stringify({
    structure: { sources: "02 - Research", concepts: "03 - Concepts", mocs: "05 - MOCs" },
    stubPattern: "Definition pending",
    mocCountPattern: "**Papers:** N",
  }, null, 2) + "\n");
  writeFileSync(join(root, ".wiki", "domains.json"), JSON.stringify({
    domains: { alpha: { path: "02 - Research/Alpha", scope: "public" } },
  }, null, 2));
  mkdirSync(join(root, "02 - Research", "Alpha"), { recursive: true });
  mkdirSync(join(root, "03 - Concepts"), { recursive: true });
  // Two sources both link the concept; one source also links the other.
  writeFileSync(join(root, "02 - Research", "Alpha", "Alpha Source Note.md"),
    "---\ntags: [paper]\ncreated: '2026-01-01'\n---\n\n# Alpha Source Note\n\nUses [[Shared Bridge Concept]] and cites [[Beta Source Note]].\n");
  writeFileSync(join(root, "02 - Research", "Alpha", "Beta Source Note.md"),
    "---\ntags: [paper]\ncreated: '2026-01-01'\n---\n\n# Beta Source Note\n\nAlso uses [[Shared Bridge Concept]].\n");
  writeFileSync(join(root, "03 - Concepts", "Shared Bridge Concept.md"),
    "---\ntags: [concept]\ncreated: '2026-01-01'\n---\n\n# Shared Bridge Concept\n\nA real definition here.\n");
  return root;
}

function records(root: string, file: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, ".wiki", file), "utf-8")
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("index persists HITS hub/authority on linked records", () => {
  const root = makeVault();
  try {
    execFileSync(process.execPath, ["--import", "tsx", CLI, "--vault", root], { encoding: "utf-8" });

    const concepts = records(root, "concept-index.jsonl");
    const bridge = concepts.find((c) => c.name === "Shared Bridge Concept")!;
    assert.ok(typeof bridge.authority === "number" && (bridge.authority as number) > 0,
      "linked-to concept should carry positive authority");

    const sources = records(root, "source-index.jsonl");
    const alpha = sources.find((s) => s.title === "Alpha Source Note")!;
    assert.ok(typeof alpha.hub === "number" && (alpha.hub as number) > 0,
      "outlinking source should carry positive hub score");

    // The concept is pointed at by both hubs; the beta source by one.
    const beta = sources.find((s) => s.title === "Beta Source Note")!;
    assert.ok((bridge.authority as number) > ((beta.authority as number) ?? 0),
      "two-hub concept should out-rank one-hub source on authority");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("index run on a linkless vault emits records without hub/authority keys", () => {
  const root = makeVault();
  try {
    // Strip the wikilinks so the graph is empty.
    for (const f of ["Alpha Source Note", "Beta Source Note"]) {
      writeFileSync(join(root, "02 - Research", "Alpha", `${f}.md`),
        `---\ntags: [paper]\ncreated: '2026-01-01'\n---\n\n# ${f}\n\nNo links here.\n`);
    }
    writeFileSync(join(root, "03 - Concepts", "Shared Bridge Concept.md"),
      "---\ntags: [concept]\ncreated: '2026-01-01'\n---\n\n# Shared Bridge Concept\n\nA real definition here.\n");
    execFileSync(process.execPath, ["--import", "tsx", CLI, "--vault", root], { encoding: "utf-8" });
    for (const rec of [...records(root, "source-index.jsonl"), ...records(root, "concept-index.jsonl")]) {
      assert.ok(!("hub" in rec) && !("authority" in rec),
        `linkless record ${rec.title ?? rec.name} must omit hub/authority`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
