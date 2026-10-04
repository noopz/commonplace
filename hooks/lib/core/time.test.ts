/**
 * Note age and status on an invented vault: both clocks on cards, and
 * superseded/contested labels read from incoming `supersedes:`/`contests:`
 * links — never from age, and never naming a sealed note.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote, normDate } from "../index/parse.ts";
import { buildIndex, type IndexNote } from "../index/model.ts";
import { serializeIndex } from "../index/layout.ts";
import { VaultIndex, type IndexPorts } from "../index/load.ts";
import * as noun from "./noun.ts";
import { formatSearch, formatNote, timeLines } from "../tools/format.ts";
import type { DomainMap } from "./scope.ts";

const DOMAINS: DomainMap = {
  alpha: { path: "Research/Alpha", scope: "public" },
  gamma: { path: "Explorations/Gamma", scope: "private" },
};
const OPTS = { structure: { concepts: "Concepts" }, domainPaths: ["Research/Alpha", "Explorations/Gamma"] };

const VAULT: Record<string, string> = {
  // An old source, still the one others build on.
  "Research/Alpha/Kestrel Survey.md":
    "---\ncreated: 2026-01-05\npublished: '2019-03'\n---\n# Kestrel Survey\n\nThe kestrel ledger method, surveyed.\n",
  // A newer source, overturned by a later one.
  "Research/Alpha/Kestrel Ledger Result.md":
    "---\ncreated: 2026-02-10\npublished: 2025-11-02\n---\n# Kestrel Ledger Result\n\nA kestrel ledger result.\n",
  "Research/Alpha/Kestrel Ledger Revisited.md":
    "---\ncreated: 2026-06-01\npublished: '2026-05'\nsupersedes:\n  - '[[Kestrel Ledger Result]]'\ncontests:\n  - '[[Kestrel Survey]]'\n---\n# Kestrel Ledger Revisited\n\nOverturns the kestrel ledger result.\n",
  // A sealed note that also contests the survey: must never be named.
  "Explorations/Gamma/Gamma Kestrel Doubt.md":
    "---\ncontests:\n  - '[[Kestrel Survey]]'\n---\n# Gamma Kestrel Doubt\n\nDoubts the kestrel survey.\n",
};

function setup() {
  const notes: IndexNote[] = Object.entries(VAULT).map(([rel, text]) => ({ rel, parsed: parseNote(rel, text, OPTS), mt: 1, sz: text.length, stub: false }));
  const files = new Map(serializeIndex(buildIndex(notes, { domains: DOMAINS, version: 1, builtAt: "t" }), { version: 1, builtAt: "t" }));
  const ports: IndexPorts = {
    read: async (rel) => files.get(rel) ?? null,
    head: async (rel, n) => files.get(rel)?.slice(0, n) ?? null,
    size: async (rel) => files.get(rel)?.length ?? null,
    append: async () => {},
    now: () => 0,
  };
  const index = new VaultIndex(ports, DOMAINS);
  const ctx = (): noun.NounCtx => ({
    vaultId: "v",
    index,
    domains: DOMAINS,
    open: new Set<string>(),
    sealedNames: ["Gamma Kestrel Doubt"],
    readNote: async (rel) => VAULT[rel] ?? null,
    now: () => 0,
  });
  return { index, ctx };
}

test("normDate: Date objects, ISO strings and partial dates land on the same text", () => {
  assert.equal(normDate(new Date("2025-11-02T00:00:00Z")), "2025-11-02");
  assert.equal(normDate("2025-03-28T17:07"), "2025-03-28");
  assert.equal(normDate("2019-03"), "2019-03");
  assert.equal(normDate(2019), "2019");
  assert.equal(normDate("sometime"), undefined);
  assert.equal(normDate(undefined), undefined);
  const p = parseNote("Research/Alpha/X.md", "---\ndate: 2024-06-01\ncreated: 2026-01-01\n---\n# X\n", OPTS);
  assert.equal(p.published, "2024-06-01", "`date:` stands in for `published:`");
  assert.equal(p.created, "2026-01-01");
});

test("search pointers carry both clocks and the status; age alone never labels a note", async () => {
  const { index, ctx } = setup();
  await index.load();
  const s = await noun.search(ctx(), { query: "kestrel ledger" });
  assert.ok(!("error" in s));
  const by = (t: string) => s.hits.find((h) => h.title === t)!;
  assert.equal(by("Kestrel Survey").published, "2019-03");
  assert.equal(by("Kestrel Survey").added, "2026-01-05");
  assert.deepEqual(by("Kestrel Ledger Result").supersededBy, ["Kestrel Ledger Revisited"]);
  assert.equal(by("Kestrel Ledger Result").contestedBy, undefined);
  assert.equal(by("Kestrel Survey").supersededBy, undefined, "the 2019 survey is old, not superseded");
  assert.deepEqual(by("Kestrel Survey").contestedBy, ["Kestrel Ledger Revisited"], "the sealed doubter is not named");
  assert.equal(by("Kestrel Ledger Revisited").supersededBy, undefined);
  const text = formatSearch(s, "kestrel ledger");
  assert.match(text, /published 2019-03 · added 2026-01-05/);
  assert.match(text, /⚠ superseded by \[\[Kestrel Ledger Revisited\]\]/);
  assert.ok(!text.includes("Gamma"), text);
});

test("vault_note heads the note with its clocks and status", async () => {
  const { index, ctx } = setup();
  await index.load();
  const n = await noun.note(ctx(), { ref: "Kestrel Ledger Result" });
  assert.ok(!("error" in n));
  const text = formatNote(n);
  assert.match(text.split("\n").slice(0, 3).join("\n"), /published 2025-11-02 · added 2026-02-10\n⚠ superseded by \[\[Kestrel Ledger Revisited\]\]/);
});

test("timeLines: nothing to say means no lines", () => {
  const bare = { id: 1, vault: "v", path: "a.md", title: "A", kind: "source" as const, domain: "", abstraction: "", inDegree: 0, outDegree: 0, tags: [], isStub: false, isRetired: false };
  assert.deepEqual(timeLines(bare), []);
  assert.deepEqual(timeLines({ ...bare, published: "2020" }), ["published 2020"]);
});

test("cards carry no path; search and note take it from the view", async () => {
  const { index, ctx } = setup();
  await index.load();
  const s = await noun.search(ctx(), { query: "kestrel ledger" });
  assert.ok(!("error" in s));
  for (const h of s.hits) assert.equal(h.path, `Research/Alpha/${h.title}.md`);
  const n = await noun.note(ctx(), { ref: "Kestrel Survey" });
  assert.ok(!("error" in n));
  assert.equal(n.card.path, "Research/Alpha/Kestrel Survey.md");
});
