/**
 * connectPool's kind-weighted seeding on an invented vault.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote } from "../index/parse.ts";
import { buildIndex, type IndexNote } from "../index/model.ts";
import { serializeIndex } from "../index/layout.ts";
import { VaultIndex, type IndexPorts } from "../index/load.ts";
import { connectPool } from "./connect.ts";
import type { DomainMap } from "./scope.ts";

const DOMAINS: DomainMap = { alpha: { path: "Research/Alpha", scope: "public" } };
const OPTS = { structure: { concepts: "Concepts" }, domainPaths: ["Research/Alpha"] };
const VAULT: Record<string, string> = {
  // A source that matches the query and links nowhere.
  "Research/Alpha/Kestrel Report.md": "# Kestrel Report\n\nStandalone.\n",
  // A concept that matches the query, cited by a source that does not.
  "Concepts/Kestrel Method.md": "# Kestrel Method\n\nA concept.\n",
  "Research/Alpha/Lantern Study.md": "# Lantern Study\n\nApplies [[Kestrel Method]].\n",
};

async function view() {
  const notes: IndexNote[] = Object.entries(VAULT).map(([rel, text]) => ({ rel, parsed: parseNote(rel, text, OPTS), mt: 1, sz: text.length, stub: false }));
  const files = new Map(serializeIndex(buildIndex(notes, { domains: DOMAINS, version: 1, builtAt: "t" }), { version: 1, builtAt: "t" }));
  const ports: IndexPorts = {
    read: async (rel) => files.get(rel) ?? null,
    head: async (rel, n) => files.get(rel)?.slice(0, n) ?? null,
    size: async (rel) => files.get(rel)?.length ?? null,
    append: async () => {},
    now: () => 0,
  };
  const idx = new VaultIndex(ports, DOMAINS);
  await idx.load();
  const cards = await idx.cards([0, 1, 2, 3, 4, 5]);
  return { v: idx.view!, kindOf: (id: number) => cards.get(id)?.k };
}

test("a concept seed outweighs a source seed when docSeed < 1, pulling in what cites it", async () => {
  const { v, kindOf } = await view();
  const lantern = v.resolve("Lantern Study")!;
  const pprOf = (docSeed: number) => connectPool(v, "kestrel", { k: 10, kindOf, docSeed }).find((c) => c.id === lantern)?.ppr ?? 0;
  assert.ok(pprOf(0.05) > pprOf(1), `${pprOf(0.05)} vs ${pprOf(1)}`);
  // Without kindOf every seed is a document: docSeed scales them all alike.
  const flat = (docSeed: number) => connectPool(v, "kestrel", { k: 10, docSeed }).map((c) => c.id);
  assert.deepEqual(flat(0.05), flat(1));
});
