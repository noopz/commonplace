/**
 * The module-side loader over recording fake Ports: lazy loading, the
 * closed-shard rule, shard splicing, journal replay, and patch == rebuild on
 * invented notes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote } from "./parse.ts";
import { buildIndex, type IndexNote } from "./model.ts";
import { serializeIndex, P } from "./layout.ts";
import { VaultIndex, type IndexPorts } from "./load.ts";
import { journalNote } from "./journal.ts";
import type { DomainMap } from "../core/scope.ts";
import { pushPpr } from "../graph/walk.ts";

const DOMAINS: DomainMap = {
  alpha: { path: "Research/Alpha", scope: "public" },
  gamma: { path: "Explorations/Gamma", scope: "private" },
};
const OPTS = { structure: { concepts: "Concepts" }, domainPaths: ["Research/Alpha", "Explorations/Gamma"] };

const BASE: Record<string, string> = {
  "Research/Alpha/Alpha Report.md": "# Alpha Report\n\nStaged calibration reduces drift, per [[Delta Idea]]. Also [[Gamma Term]].\n",
  "Research/Alpha/Beta Theory.md": "---\naliases: [BT]\n---\n# Beta Theory\n\nBeta builds on [[Delta Idea]] and waits on [[Omega Concept]].\n",
  "Concepts/Delta Idea.md": "---\nabstraction: staged drift budget\n---\n# Delta Idea\n\nA concept.\n",
  "Explorations/Gamma/Gamma Term.md": "# Gamma Term\n\nGamma relies on [[Delta Idea]].\n",
};

function art(vault: Record<string, string>, version = 1) {
  const notes: IndexNote[] = Object.entries(vault).map(([rel, text]) => ({
    rel,
    parsed: parseNote(rel, text, OPTS),
    mt: 1,
    sz: text.length,
    stub: false,
  }));
  const r = buildIndex(notes, { domains: DOMAINS, version, builtAt: "t" });
  return new Map(serializeIndex(r, { version, builtAt: "t" }));
}

function fakePorts(files: Map<string, string>) {
  const reads: string[] = [];
  let clock = 0;
  const ports: IndexPorts & { reads: string[]; tick: (ms: number) => void } = {
    reads,
    tick: (ms) => {
      clock += ms;
    },
    read: async (rel) => {
      reads.push(rel);
      return files.get(rel) ?? null;
    },
    head: async (rel, n) => {
      reads.push(`head:${rel}`);
      return files.get(rel)?.slice(0, n) ?? null;
    },
    size: async (rel) => (files.has(rel) ? new TextEncoder().encode(files.get(rel)!).length : null),
    append: async (rel, line) => {
      files.set(rel, (files.get(rel) ?? "") + line + "\n");
    },
    now: () => clock,
  };
  return ports;
}

const titlesOf = async (idx: VaultIndex, ids: number[]) =>
  [...(await idx.cards(ids)).values()].map((c) => c.t).sort();

async function linkTitles(idx: VaultIndex, ref: string, dir: "out" | "in" | "both" = "both") {
  const v = idx.view!;
  const id = v.resolve(ref)!;
  const ids = v.links(id, dir).map((l) => l.id);
  return titlesOf(idx, ids);
}

test("loads public artefacts only; a closed shard is never read", async () => {
  const ports = fakePorts(art(BASE));
  const idx = new VaultIndex(ports, DOMAINS);
  assert.equal(await idx.load(), "ready");
  assert.deepEqual(await linkTitles(idx, "Delta Idea", "in"), ["Alpha Report", "Beta Theory"]);
  assert.equal(idx.view!.resolve("Gamma Term"), null, "sealed note does not resolve");
  assert.deepEqual(idx.view!.search("gamma").map((h) => h.id), []);
  assert.ok(!ports.reads.some((r) => r.startsWith("sealed/")), `read sealed: ${ports.reads.filter((r) => r.startsWith("sealed/"))}`);
});

test("a manifest cut at other chunk sizes loads as absent, so the caller rebuilds", async () => {
  for (const field of ["cardsPer", "linkctxPer"] as const) {
    const files = art(BASE);
    const m = JSON.parse(files.get(P.manifest)!);
    m.chunks[field] += 1;
    files.set(P.manifest, JSON.stringify(m));
    assert.equal(await new VaultIndex(fakePorts(files), DOMAINS).load(), "absent", field);
  }
  const old = art(BASE);
  const m = JSON.parse(old.get(P.manifest)!);
  delete m.chunks.cardsPer;
  old.set(P.manifest, JSON.stringify(m));
  assert.equal(await new VaultIndex(fakePorts(old), DOMAINS).load(), "absent", "a pre-chunk-size manifest");
});

test("a manifest cut with another postings term shape loads as absent", async () => {
  const files = art(BASE);
  const m = JSON.parse(files.get(P.manifest)!);
  m.terms = "stem=none;phr=0;w=4,4,3,2,1";
  files.set(P.manifest, JSON.stringify(m));
  assert.equal(await new VaultIndex(fakePorts(files), DOMAINS).load(), "absent");
  const old = art(BASE);
  const m2 = JSON.parse(old.get(P.manifest)!);
  delete m2.terms;
  old.set(P.manifest, JSON.stringify(m2));
  assert.equal(await new VaultIndex(fakePorts(old), DOMAINS).load(), "absent", "a pre-terms manifest");
});

test("opening a shard splices its notes and the public→private edges", async () => {
  const ports = fakePorts(art(BASE));
  const idx = new VaultIndex(ports, DOMAINS);
  await idx.load();
  assert.ok(await idx.openShard("gamma"));
  assert.deepEqual(await linkTitles(idx, "Delta Idea", "in"), ["Alpha Report", "Beta Theory", "Gamma Term"]);
  assert.deepEqual(await linkTitles(idx, "Alpha Report", "out"), ["Delta Idea", "Gamma Term"]);
  idx.closeShard("gamma");
  assert.deepEqual(await linkTitles(idx, "Alpha Report", "out"), ["Delta Idea"], "sentinel edge is never listed");
});

test("walks absorb at the sentinel while the shard is sealed", async () => {
  const idx = new VaultIndex(fakePorts(art(BASE)), DOMAINS);
  await idx.load();
  const v = idx.view!;
  const res = pushPpr(v, new Map([[v.resolve("Alpha Report")!, 1]]), { blocked: v.sentinels });
  let sum = res.absorbed + res.residual;
  for (const p of res.p.values()) sum += p;
  assert.ok(Math.abs(sum - 1) < 1e-6);
  assert.ok(res.absorbed > 0);
  for (const s of v.sentinels) assert.ok(!res.p.has(s));
});

async function patchedEqualsRebuild(edit: Record<string, string | null>) {
  const files = art(BASE);
  const idx = new VaultIndex(fakePorts(files), DOMAINS, "t1");
  await idx.load();
  for (const [rel, text] of Object.entries(edit)) {
    await idx.patch(rel, text === null ? null : journalNote(parseNote(rel, text, OPTS), false), { mt: 2, sz: 1, shard: "main" });
  }
  const after: Record<string, string> = { ...BASE };
  for (const [rel, text] of Object.entries(edit)) {
    if (text === null) delete after[rel];
    else after[rel] = text;
  }
  const fresh = new VaultIndex(fakePorts(art(after)), DOMAINS);
  await fresh.load();
  for (const rel of Object.keys(after)) {
    if (rel.startsWith("Explorations/")) continue;
    const title = rel.split("/").pop()!.replace(/\.md$/, "");
    assert.deepEqual(await linkTitles(idx, title), await linkTitles(fresh, title), `links of ${title}`);
  }
  // A second session replaying the journal sees the same graph.
  const replayer = new VaultIndex(fakePorts(files), DOMAINS, "t2");
  await replayer.load();
  for (const rel of Object.keys(after)) {
    if (rel.startsWith("Explorations/")) continue;
    const title = rel.split("/").pop()!.replace(/\.md$/, "");
    assert.deepEqual(await linkTitles(replayer, title), await linkTitles(fresh, title), `replayed links of ${title}`);
  }
  return { idx, fresh };
}

test("patch == rebuild: modify a note's links", async () => {
  await patchedEqualsRebuild({
    "Research/Alpha/Alpha Report.md": "# Alpha Report\n\nNow cites [[Beta Theory]] instead.\n",
  });
});

test("patch == rebuild: add a note that claims an unresolved key", async () => {
  const { idx } = await patchedEqualsRebuild({ "Concepts/Omega Concept.md": "# Omega Concept\n\nNew.\n" });
  assert.deepEqual(await linkTitles(idx, "Omega Concept", "in"), ["Beta Theory"]);
  assert.equal(idx.view!.search("omega")[0]?.id, idx.view!.resolve("Omega Concept"));
});

test("patch == rebuild: delete a note", async () => {
  const { idx } = await patchedEqualsRebuild({ "Concepts/Delta Idea.md": null });
  assert.equal(idx.view!.resolve("Delta Idea"), null);
  assert.deepEqual(idx.view!.search("drift budget").map((h) => h.id), []);
});

test("patch == rebuild: alias added", async () => {
  await patchedEqualsRebuild({
    "Concepts/Delta Idea.md": "---\naliases: [Omega Concept]\n---\n# Delta Idea\n\nA concept.\n",
  });
});

test("version change reloads; journal growth replays; checks are rate-limited", async () => {
  const files = art(BASE);
  const ports = fakePorts(files);
  const idx = new VaultIndex(ports, DOMAINS, "a");
  await idx.load();
  // Another session appends a patch.
  const other = new VaultIndex(fakePorts(files), DOMAINS, "b");
  await other.load();
  await other.patch("Concepts/Omega Concept.md", journalNote(parseNote("Concepts/Omega Concept.md", "# Omega Concept\n", OPTS), false), { mt: 1, sz: 1, shard: "main" });
  await idx.ensureFresh();
  assert.equal(idx.view!.resolve("Omega Concept"), null, "within FRESH_MS: not checked yet");
  ports.tick(6000);
  await idx.ensureFresh();
  assert.notEqual(idx.view!.resolve("Omega Concept"), null, "replayed the other session's line");
  // A rebuild (new version) reloads and drops the compacted journal lines.
  for (const [k, v] of art({ ...BASE, "Concepts/Omega Concept.md": "# Omega Concept\n" }, 2)) files.set(k, v);
  ports.tick(6000);
  await idx.ensureFresh();
  assert.equal(idx.manifest!.version, 2);
  assert.notEqual(idx.view!.resolve("Omega Concept"), null);
  assert.equal(idx.view!.patchCount(), 0);
});

test("a private-shard patch is journaled only under sealed/", async () => {
  const files = art(BASE);
  const idx = new VaultIndex(fakePorts(files), DOMAINS);
  await idx.load();
  await idx.openShard("gamma");
  await idx.patch("Explorations/Gamma/Gamma Term.md", journalNote(parseNote("x.md", "# Gamma Term\n\nEdited [[Beta Theory]].\n", OPTS), false), { mt: 1, sz: 1, shard: "gamma" });
  assert.ok(!(files.get(P.journal) ?? "").includes("Gamma"));
  assert.ok((files.get(P.shardJournal("gamma")) ?? "").includes("Gamma Term"));
});

test("a manifest cut under an older card schema loads as absent", async () => {
  const files = art(BASE);
  const m = JSON.parse(files.get(P.manifest)!);
  m.schema = 2;
  files.set(P.manifest, JSON.stringify(m));
  assert.equal(await new VaultIndex(fakePorts(files), DOMAINS).load(), "absent", "schema-2 cards still carry a path");
});
