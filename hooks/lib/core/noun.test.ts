/**
 * `$.commonplace` method logic against an invented vault, including the
 * plan §4.5 adversarial scope cases. Recording fake Ports throughout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote } from "../index/parse.ts";
import { buildIndex, type IndexNote } from "../index/model.ts";
import { serializeIndex } from "../index/layout.ts";
import { VaultIndex, type IndexPorts } from "../index/load.ts";
import * as noun from "./noun.ts";
import { formatSearch, formatNote, formatLinks, formatPath, formatNeighbourhood, unreadContext } from "../tools/format.ts";
import type { DomainMap } from "./scope.ts";

const DOMAINS: DomainMap = {
  alpha: { path: "Research/Alpha", scope: "public" },
  gamma: { path: "Explorations/Gamma", scope: "private" },
};
const OPTS = { structure: { concepts: "Concepts" }, domainPaths: ["Research/Alpha", "Explorations/Gamma"] };

const VAULT: Record<string, string> = {
  "Research/Alpha/Alpha Report.md":
    "---\nabstraction: staged calibration reduces drift\n---\n# Alpha Report\n\n## Findings\n\nStaged calibration reduces drift, per [[Delta Idea]]. See [[Gamma Term]] and [[Beta Theory]].\n",
  "Research/Alpha/Beta Theory.md": "# Beta Theory\n\nBeta theory extends [[Delta Idea]].\n",
  "Concepts/Delta Idea.md": "---\nabstraction: a drift budget concept\n---\n# Delta Idea\n\nCited widely.\n",
  "Concepts/Epsilon Note.md": "# Epsilon Note\n\nOnly reachable through [[Gamma Term]].\n",
  "Explorations/Gamma/Gamma Term.md": "# Gamma Term\n\nThe gamma term relies on [[Delta Idea]] and [[Epsilon Note]].\n",
};

function setup() {
  const notes: IndexNote[] = Object.entries(VAULT).map(([rel, text]) => ({
    rel,
    parsed: parseNote(rel, text, OPTS),
    mt: 1,
    sz: text.length,
    stub: false,
  }));
  const r = buildIndex(notes, { domains: DOMAINS, version: 1, builtAt: "t" });
  const files = new Map(serializeIndex(r, { version: 1, builtAt: "t" }));
  const reads: string[] = [];
  const ports: IndexPorts = {
    read: async (rel) => {
      reads.push(rel);
      return files.get(rel) ?? null;
    },
    head: async (rel, n) => files.get(rel)?.slice(0, n) ?? null,
    size: async (rel) => files.get(rel)?.length ?? null,
    append: async () => {},
    now: () => 0,
  };
  const index = new VaultIndex(ports, DOMAINS);
  const open = new Set<string>();
  const noteReads: string[] = [];
  const ctx = (): noun.NounCtx => ({
    vaultId: "alpha-vault",
    index,
    domains: DOMAINS,
    open,
    sealedNames: open.has("gamma") ? [] : ["Gamma Term"],
    readNote: async (rel) => {
      noteReads.push(rel);
      return VAULT[rel] ?? null;
    },
    now: () => 0,
  });
  return { index, ctx, open, reads, noteReads };
}

test("1/2: a sealed note is absent from search and reads like a missing one", async () => {
  const { index, ctx, reads, noteReads } = setup();
  await index.load();
  const s = await noun.search(ctx(), { query: "gamma term" });
  assert.ok(!("error" in s));
  assert.ok(!s.hits.some((h) => h.title === "Gamma Term"));
  assert.ok(!formatSearch(s, "gamma term").includes("Gamma Term"));
  const byTitle = await noun.note(ctx(), { ref: "Gamma Term" });
  const byPath = await noun.note(ctx(), { ref: "Explorations/Gamma/Gamma Term.md" });
  const missing = await noun.note(ctx(), { ref: "Nothing Here" });
  assert.deepEqual(byTitle, { error: 'No vault note matches "Gamma Term".' });
  assert.equal((byPath as { error: string }).error.replace(/".*"/, '"x"'), (missing as { error: string }).error.replace(/".*"/, '"x"'));
  assert.ok(!reads.some((r) => r.startsWith("sealed/")));
  assert.ok(!noteReads.some((r) => r.includes("Gamma")));
});

test("3/16: links omit sealed edges; pointer text masks the sealed title", async () => {
  const { index, ctx } = setup();
  await index.load();
  const r = await noun.links(ctx(), { note: "Alpha Report" });
  assert.ok(!("error" in r));
  assert.deepEqual(r.links.map((l) => l.to.title).sort(), ["Beta Theory", "Delta Idea"]);
  const text = formatLinks(r, "both");
  assert.ok(!text.includes("Gamma"), text);
  const beta = r.links.find((l) => l.to.title === "Beta Theory")!;
  assert.match(beta.why, /\[\[…\]\]/, "sealed wikilink masked in the shared sentence");
  assert.equal(beta.heading, "## Findings");
});

test("4: a path that only exists through a sealed note is null", async () => {
  const { index, ctx, open } = setup();
  await index.load();
  const sealed = await noun.path(ctx(), { from: "Alpha Report", to: "Epsilon Note" });
  assert.deepEqual(sealed && "path" in sealed ? sealed.path : "err", null);
  open.add("gamma");
  await index.openShard("gamma");
  const opened = await noun.path(ctx(), { from: "Alpha Report", to: "Epsilon Note" });
  assert.ok(!("error" in opened) && opened.path);
  assert.match(formatPath(opened, "a", "b", 4), /\[\[Gamma Term\]\]/);
});

test("5: neighbourhood never contains a sentinel or a sealed note", async () => {
  const { index, ctx } = setup();
  await index.load();
  const r = await noun.neighbourhood(ctx(), { seeds: ["Alpha Report"] });
  assert.ok(!("error" in r));
  assert.ok(r.pool.length > 0);
  assert.ok(!r.pool.some((p) => p.card.title === "Gamma Term"));
  assert.ok(!formatNeighbourhood(r, ["Alpha Report"]).includes("Gamma"));
});

test("8: a sealed domain filter answers like a nonexistent one", async () => {
  const { index, ctx } = setup();
  await index.load();
  assert.deepEqual(await noun.search(ctx(), { query: "x", domain: "gamma" }), { error: "No such domain" });
  assert.deepEqual(await noun.search(ctx(), { query: "x", domain: "nonexistent" }), { error: "No such domain" });
  const domains = await noun.list(ctx(), { what: "domains" });
  assert.ok(!JSON.stringify(domains).includes("gamma"));
});

test("10: a public concept linked from a private note stays visible; its backlinks show only public notes", async () => {
  const { index, ctx, open } = setup();
  await index.load();
  const sealed = await noun.links(ctx(), { note: "Delta Idea", direction: "in" });
  assert.ok(!("error" in sealed));
  assert.deepEqual(sealed.links.map((l) => l.from.title).sort(), ["Alpha Report", "Beta Theory"]);
  open.add("gamma");
  await index.openShard("gamma");
  const opened = await noun.links(ctx(), { note: "Delta Idea", direction: "in" });
  assert.ok(!("error" in opened));
  assert.deepEqual(opened.links.map((l) => l.from.title).sort(), ["Alpha Report", "Beta Theory", "Gamma Term"]);
  assert.ok(opened.links.find((l) => l.from.title === "Gamma Term")!.from.isPrivate);
});

test("note: body masked, links capped and formatted, unread hint", async () => {
  const { index, ctx } = setup();
  await index.load();
  const n = await noun.note(ctx(), { ref: "Alpha Report" });
  assert.ok(!("error" in n));
  assert.ok(!n.text.includes("Gamma Term"), "body masks the sealed link");
  const text = formatNote(n);
  assert.match(text, /Outgoing \(2, showing 2\)/);
  assert.match(text, /Incoming: none/);
  assert.match(unreadContext(n) ?? "", /\[\[Delta Idea\]\]/);
});

test("search output carries no numeric score", async () => {
  const { index, ctx } = setup();
  await index.load();
  const s = await noun.search(ctx(), { query: "drift calibration" });
  assert.ok(!("error" in s));
  const text = formatSearch(s, "drift calibration");
  assert.ok(!/\d+\.\d+/.test(text), text);
  assert.equal(s.hits[0].title, "Alpha Report");
});

test("path draws a hop walked against its link as ←kind— and ends at the target", async () => {
  const { index, ctx } = setup();
  await index.load();
  const r = await noun.path(ctx(), { from: "Beta Theory", to: "Alpha Report" });
  assert.ok(!("error" in r) && r.path);
  const text = formatPath(r, "Beta Theory", "Alpha Report", 4);
  assert.match(text, /^Path \[\[Beta Theory\]\] → \[\[Alpha Report\]\]/);
  assert.match(text, /←body— \[\[Alpha Report\]\]/);
});
