/**
 * Index model on an invented vault: one-way scope, sentinels, sealed shards,
 * stable ids, and the rule that nothing under graph/ names a private note.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote } from "./parse.ts";
import { buildIndex, shardFor, type IndexNote } from "./model.ts";
import { serializeIndex, P, peekManifestVersion } from "./layout.ts";
import { unpackCsr, outEdges, inEdges } from "../graph/csr.ts";
import type { DomainMap } from "../core/scope.ts";

const DOMAINS: DomainMap = {
  alpha: { path: "Research/Alpha", scope: "public" },
  gamma: { path: "Explorations/Gamma", scope: "private" },
  delta: { path: "Explorations/Delta", scope: "private", linkGroup: "dg" },
  epsilon: { path: "Explorations/Epsilon", scope: "private", linkGroup: "dg" },
};

const NOTES: Record<string, string> = {
  "Research/Alpha/Alpha Report.md":
    "---\nconcepts:\n  - \"[[Delta Idea]]\"\ntags: [paper]\n---\n# Alpha Report\n\nThe Alpha method reduces drift, per [[Delta Idea|the delta idea]]. See [[Gamma Secret Term]].\n",
  "Concepts/Delta Idea.md": "---\naliases: [DI]\nabstraction: a public concept about staged drift\n---\n# Delta Idea\n\nCited by [[Alpha Report]].\n",
  "Explorations/Gamma/Gamma Secret Term.md":
    "# Gamma Secret Term\n\nThe Gamma Secret Term builds on [[Delta Idea]] and [[Delta Hidden Note]].\n",
  "Explorations/Delta/Delta Hidden Note.md": "# Delta Hidden Note\n\nLinks [[Epsilon Hidden Note]].\n",
  "Explorations/Epsilon/Epsilon Hidden Note.md": "# Epsilon Hidden Note\n\nNothing here.\n",
  "Research/Alpha/Alpha Private Aside.md": "---\nscope: private\n---\n# Alpha Private Aside\n\nAbout [[Alpha Report]].\n",
};

function notes(extra: Record<string, string> = {}): IndexNote[] {
  return Object.entries({ ...NOTES, ...extra }).map(([rel, text]) => ({
    rel,
    parsed: parseNote(rel, text, { structure: { concepts: "Concepts" }, domainPaths: Object.values(DOMAINS).map((d) => d.path!) }),
    mt: 1,
    sz: text.length,
    stub: false,
  }));
}

const build = (extra?: Record<string, string>, prev?: Parameters<typeof buildIndex>[1]["prev"]) =>
  buildIndex(notes(extra), { domains: DOMAINS, version: 1, builtAt: "2026-01-01T00:00:00Z", prev });

const PRIVATE_TITLES = ["Gamma Secret Term", "Delta Hidden Note", "Epsilon Hidden Note", "Alpha Private Aside"];

test("shard comes from where a note lives, never from inbound links", () => {
  const r = build();
  assert.equal(r.shardOf.get("Concepts/Delta Idea.md"), "main", "public concept linked from a private note stays public");
  assert.equal(r.shardOf.get("Explorations/Gamma/Gamma Secret Term.md"), "gamma");
  assert.equal(r.shardOf.get("Explorations/Delta/Delta Hidden Note.md"), "dg", "linkGroup is the shard");
  assert.equal(r.shardOf.get("Explorations/Epsilon/Epsilon Hidden Note.md"), "dg");
  assert.equal(r.shardOf.get("Research/Alpha/Alpha Private Aside.md"), "loose", "note-level private in a public domain");
});

test("nothing under graph/ names, or counts towards, a private note", () => {
  const r = build();
  const files = serializeIndex(r, { version: 1, builtAt: "2026-01-01T00:00:00Z" });
  for (const [path, text] of files) {
    if (!path.startsWith("graph/")) continue;
    for (const t of PRIVATE_TITLES) {
      assert.ok(!text.includes(t), `${path} mentions ${t}`);
      assert.ok(!text.toLowerCase().includes(t.toLowerCase()), `${path} mentions ${t} (lowercase)`);
    }
    for (const d of ["gamma", "\"dg\"", "epsilon"]) assert.ok(!text.includes(d), `${path} names shard/domain ${d}`);
  }
  // The public card for Delta Idea counts only public links (Alpha Report ↔ Delta Idea).
  const delta = r.public.cards.find((c) => c.t === "Delta Idea")!;
  assert.deepEqual(delta.deg, [2, 1], "in: Alpha body+concept edges merged per kind = 2; out: Alpha Report");
  const alphaId = r.public.cards.find((c) => c.t === "Alpha Report")!.id;
  assert.ok(!r.public.cards.some((c) => c.nb.some((id) => !r.public.cards.find((x) => x.id === id))), "nb never names a non-public id");
  // Postings never carry an anchor term that only a link to a sealed target used.
  assert.ok(!r.public.postings.some((row) => row.t === "secret"), "no sealed anchor/title term in public postings");
  void alphaId;
});

test("public → private links point at the shard's sentinel; the shard keeps the real edge", () => {
  const r = build();
  const g = unpackCsr(r.public.csr);
  const alpha = r.public.cards.find((c) => c.t === "Alpha Report")!.id;
  const gammaSentinel = r.sentinels.get("gamma")!;
  assert.ok(outEdges(g, alpha).some((e) => e.id === gammaSentinel), "Alpha → sentinel(gamma)");
  assert.equal(outEdges(g, gammaSentinel).length, 0, "sentinels have no out-edges");
  const gamma = r.shards.get("gamma")!;
  const secret = gamma.cards[0].id;
  assert.deepEqual(gamma.inbound.map((t) => [t[0], t[1]]), [[alpha, secret]]);
  // Gamma → Delta Hidden Note crosses into another private shard: recorded as foreign.
  assert.equal(Object.values(gamma.foreign.nodes)[0], "dg");
  assert.equal(gamma.foreign.sentinels.dg, r.sentinels.get("dg"));
  // Private notes have no edges in the public graph at all.
  assert.equal(inEdges(g, secret).length + outEdges(g, secret).length, 0);
});

test("ids are stable across rebuilds and never reused", () => {
  const r1 = build();
  const prev = {
    nextId: r1.nextId,
    ids: new Map([...r1.public.files, ...[...r1.shards.values()].flatMap((s) => s.files)].map((f) => [f.p, f.id])),
    sentinels: r1.sentinels,
  };
  const { "Concepts/Delta Idea.md": _drop, ...rest } = NOTES;
  void _drop;
  const r2 = buildIndex(
    Object.entries({ ...rest, "Concepts/Zeta Term.md": "# Zeta Term\n" }).map(([rel, text]) => ({
      rel,
      parsed: parseNote(rel, text, { structure: { concepts: "Concepts" } }),
      mt: 1,
      sz: 1,
      stub: false,
    })),
    { domains: DOMAINS, version: 2, builtAt: "x", prev },
  );
  const id = (r: typeof r1, p: string) => r.public.files.find((f) => f.p === p)?.id;
  assert.equal(id(r2, "Research/Alpha/Alpha Report.md"), id(r1, "Research/Alpha/Alpha Report.md"));
  const zeta = id(r2, "Concepts/Zeta Term.md")!;
  assert.ok(zeta >= r1.nextId, "a new note gets a fresh id, not the deleted note's");
  assert.equal(r2.sentinels.get("gamma"), r1.sentinels.get("gamma"));
});

test("unresolved links are recorded per scope", () => {
  const r = build({ "Research/Alpha/Alpha Two.md": "# Alpha Two\n\nSee [[Beta Theory]].\n" });
  assert.ok(r.public.unresolved["beta theory"]?.length === 1);
});

test("quarantine: a folder that appears after the first index is sealed", () => {
  const opts = { domains: DOMAINS, knownLoose: new Set(["Journal"]), structureDirs: ["Concepts"] };
  assert.equal(shardFor("Journal/2026-01-01.md", undefined, opts), "main");
  assert.equal(shardFor("Newfolder/x.md", undefined, opts), "quarantine");
  assert.equal(shardFor("Concepts/Delta Idea.md", undefined, opts), "main");
  assert.equal(shardFor("Root Note.md", undefined, opts), "main");
});

test("manifest key order supports the head -c 256 version probe", () => {
  const files = serializeIndex(build(), { version: 7, builtAt: "2026-01-01T00:00:00Z" });
  const [path, text] = files[files.length - 1];
  assert.equal(path, P.manifest, "manifest written last");
  assert.deepEqual(peekManifestVersion(text.slice(0, 256)), { version: 7, journalSeq: 0 });
});
