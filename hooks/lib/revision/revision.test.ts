/**
 * Revision's pure pieces: frontmatter edges, statuses, the model-reply
 * parsers, and the trigger and runner against recording fakes. Invented notes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../index/yaml.ts";
import { edgeKey, fmEdges, locateClaim, statusLine } from "./edges.ts";
import { EMPTY_PROJECTION, statusesFor, type Projection } from "./projection.ts";
import { parseDetect, parsePropose, parseReview, parseVerify, parseEscalate, parseWording, parseWordingCheck } from "./review.ts";
import { runTrigger, type NoteInfo, type TriggerPorts } from "./trigger.ts";
import { runSteps, type RunnerPorts } from "./runner.ts";

test("fmEdges reads plain links, unquoted lists and mapping items with their claim", () => {
  const { data } = parseFrontmatter(
    [
      "---",
      "supersedes:",
      '  - note: "[[Alpha Study]]"',
      '    claim: "reaches 71% on the bench"',
      '    because: "the rerun found a leak"',
      "    kind: correction",
      '  - "[[Beta Study]]"',
      "bounds:",
      "  - note: \"[[Gamma Report]]\"",
      '    claim: "scales linearly"',
      '    within: "under 8 nodes"',
      "---",
      "body",
    ].join("\n"),
  );
  const sup = fmEdges(data.supersedes);
  assert.deepEqual(sup.map((e) => e.inner), ["Alpha Study", "Beta Study"]);
  assert.deepEqual(sup[0].rel, { claim: "reaches 71% on the bench", because: "the rerun found a leak", kind: "correction" });
  assert.equal(sup[1].rel, undefined);
  assert.equal(fmEdges(data.bounds)[0].rel?.within, "under 8 nodes");
  assert.deepEqual(fmEdges("see [[A]] and [[B|b]]").map((e) => e.inner), ["A", "B|b"]);
});

test("locateClaim needs exactly one whitespace-insensitive occurrence", () => {
  assert.deepEqual(locateClaim("One fact.  Two\nfacts.", "Two facts."), { at: 10 });
  assert.deepEqual(locateClaim("x y x y", "x y"), { error: "ambiguous" });
  assert.deepEqual(locateClaim("abc", "zzz"), { error: "missing" });
  assert.deepEqual(locateClaim("abc", "  "), { error: "empty" });
});

test("statusLine words each relation for what it is", () => {
  assert.match(statusLine({ relation: "supersedes", by: "New", rel: { claim: "c", because: "b" }, reviewed: true }), /^⚠ claim "c" corrected by \[\[New\]\]: b$/);
  assert.match(statusLine({ relation: "supersedes", by: "New", rel: { claim: "c", kind: "world-change", effective: "2026-03" }, reviewed: true }), /changed in \[\[New\]\] \(effective 2026-03\).*stays true for its period/);
  assert.match(statusLine({ relation: "bounds", by: "New", rel: { claim: "c", within: "small inputs" }, reviewed: true }), /supported within "small inputs"/);
  assert.match(statusLine({ relation: "withdrawsSupport", by: "New", rel: { claim: "c" }, reviewed: true }), /not shown false/);
  assert.match(statusLine({ relation: "contests", by: "New", reviewed: false }), /contested by \[\[New\]\] \(no reason recorded\).*\[unreviewed\]$/);
});

const proj = (p: Partial<Projection>): Projection => ({ ...EMPTY_PROJECTION, ...p });

test("statusesFor: manual shows every edge unreviewed; auto shows accepted and baseline only", () => {
  const edges = [
    { fromRel: "N1.md", fromTitle: "N1", relation: "supersedes" as const, rel: { claim: "c1" } },
    { fromRel: "N2.md", fromTitle: "N2", relation: "contests" as const, rel: { claim: "c2" } },
    { fromRel: "N3.md", fromTitle: "N3", relation: "bounds" as const, rel: { claim: "c3", within: "w" } },
  ];
  const manual = statusesFor("Old", [], edges, proj({}), () => undefined);
  assert.equal(manual.length, 3);
  assert.ok(manual.every((s) => !s.reviewed));

  const auto = proj({
    mode: "auto",
    autoScopes: ["main"],
    accepted: [{ key: edgeKey("N1.md", "supersedes", "Old", "c1"), from: "N1.md", relation: "supersedes", to: "Old", rel: { claim: "c1", because: "b" }, event: "e1", seq: 1, commit: "abc" }],
    baseline: [edgeKey("N2.md", "contests", "Old", "c2")],
  });
  const shown = statusesFor("Old", [], edges, auto, () => undefined);
  assert.deepEqual(shown.map((s) => [s.by, s.reviewed]), [["N1", true], ["N2", false]], "the unaccepted bounds candidate is hidden");
  assert.equal(shown[0].rel?.because, "b", "the accepted rel, not the file's, is shown");
});

test("statusesFor keeps an accepted edge whose frontmatter someone removed", () => {
  const auto = proj({
    mode: "auto",
    autoScopes: ["main"],
    accepted: [{ key: edgeKey("N1.md", "supersedes", "Old", "c1"), from: "N1.md", relation: "supersedes", to: "Old", rel: { claim: "c1" }, event: "e1", seq: 1, commit: "abc" }],
  });
  const shown = statusesFor("Old", [], [], auto, (rel) => (rel === "N1.md" ? "N1" : undefined));
  assert.deepEqual(shown.map((s) => [s.by, s.relation, s.reviewed]), [["N1", "supersedes", true]]);
  assert.deepEqual(statusesFor("Old", [], [], auto, () => undefined), [], "not when the newer note is gone");
});

test("parsers take JSON inside prose and refuse anything else", () => {
  assert.deepEqual(parseDetect('noise {"changed":[{"n":2,"why":"x"},{"n":9},{"n":2}]} tail', 3), [{ n: 2, why: "x" }]);
  assert.equal(parseDetect("no json", 3), null);
  assert.equal(parsePropose('{"claim":null}'), "none");
  assert.deepEqual(parsePropose('{"claim":" a b ","rationale":"r"}'), { claim: "a b", rationale: "r" });
  const r = parseReview('{"outcome":"bounded","within":"small n","because":"b","quotes_old":["q"],"quotes_new":[]}');
  assert.deepEqual(r, { verdict: "bounds", within: "small n", because: "b", quotesOld: ["q"], quotesNew: [] });
  assert.equal(parseReview('{"outcome":"world-change","effective":"next spring"}')?.effective, undefined, "an effective date must be a date");
  assert.equal(parseReview('{"outcome":"maybe"}'), null);
  assert.deepEqual(parseVerify('{"result":"confirmed","reason":"r"}'), { result: "confirmed", reason: "r" });
  assert.equal(parseVerify('{"result":"yes"}'), null);
  assert.equal(parseEscalate('{"outcome":"correction","grounded":true}')?.grounded, true);
  assert.equal(parseWording('{"would_flip":false,"because":""}'), null);
  assert.equal(parseWordingCheck('{"adds":false}'), false);
});

// ----------------------------------------------------------------- trigger

function triggerFake(notes: Record<string, NoteInfo & { text: string }>, replies: string[], over: Partial<TriggerPorts> = {}) {
  const calls: { models: string[]; proposed: Array<Record<string, unknown>>; logs: string[] } = { models: [], proposed: [], logs: [] };
  const ports: TriggerPorts = {
    info: async (rel) => notes[rel] ?? null,
    text: async (rel) => notes[rel]?.text ?? null,
    neighbours: async () => [],
    search: async () => [],
    complete: async (req) => {
      calls.models.push(req.model);
      return replies.shift() ?? null;
    },
    propose: async (p) => {
      calls.proposed.push(p);
      return { status: "proposed" };
    },
    log: (stage) => calls.logs.push(stage),
    random: () => 0.99,
    ...over,
  };
  return { ports, calls };
}

const note = (rel: string, kind = "source", shard = "main"): NoteInfo & { text: string } => ({
  rel,
  title: rel.replace(/\.md$/, ""),
  abstraction: `about ${rel}`,
  kind,
  shard,
  text: `text of ${rel}`,
});

test("trigger: a detected change gets an exact-claim proposal over the pooled notes", async () => {
  const { ports, calls } = triggerFake(
    { "New.md": note("New.md"), "Old.md": note("Old.md"), "Hub.md": note("Hub.md", "moc") },
    ['{"changed":[{"n":1,"why":"newer numbers"}]}', '{"claim":"the old figure","rationale":"r"}'],
  );
  const res = await runTrigger(ports, { written: ["New.md"], reads: ["Old.md", "Hub.md"] });
  assert.deepEqual(res, { examined: 1, pool: 1, truncated: false, changed: 1, proposed: 1 });
  assert.deepEqual(calls.models, ["haiku", "sonnet"]);
  assert.equal(calls.proposed[0].old, "Old.md");
  assert.equal(calls.proposed[0].claim, "the old figure");
});

test("trigger: a public note never pools a private one, and summaries are not triggered", async () => {
  const { ports, calls } = triggerFake(
    { "New.md": note("New.md"), "Secret.md": note("Secret.md", "source", "gamma"), "Concept.md": note("Concept.md", "concept") },
    [],
  );
  const res = await runTrigger(ports, { written: ["New.md", "Concept.md"], reads: ["Secret.md"] });
  assert.equal(res.pool, 0);
  assert.deepEqual(calls.models, [], "no model call over an empty pool");
  assert.ok(calls.logs.includes("revision:pool-empty") && calls.logs.includes("revision:skip"));
});

test("trigger: the audit re-asks a sampled 'nothing changed' and proposes what it finds", async () => {
  const { ports, calls } = triggerFake(
    { "New.md": note("New.md"), "Old.md": note("Old.md") },
    ['{"changed":[]}', '{"changed":[{"n":1,"why":"missed"}]}', '{"claim":"c","rationale":"r"}'],
    { random: () => 0 },
  );
  const res = await runTrigger(ports, { written: ["New.md"], reads: ["Old.md"] });
  assert.deepEqual(calls.models, ["haiku", "sonnet", "sonnet"]);
  assert.equal(res.proposed, 1);
  assert.ok(calls.logs.includes("revision:audit"));
});

// ------------------------------------------------------------------ runner

function runnerFake(packets: Array<Record<string, unknown>>, replies: string[]) {
  const recorded: Array<{ args: string[]; body?: Record<string, unknown> }> = [];
  const accepted: string[] = [];
  const ports: RunnerPorts = {
    cli: async (args, body) => {
      recorded.push({ args, body });
      if (args[0] === "next") return packets.shift() ?? { none: true };
      if (args[0] === "accept") return { status: "accepted", accept: "ev1", commit: "c0ffee", stale: 0 };
      return { ok: true };
    },
    complete: async () => replies.shift() ?? null,
    log: () => {},
    onAccepted: (a) => accepted.push(a.accept),
  };
  return { ports, recorded, accepted };
}

const side = { older: { title: "Old", rel: "Old.md" }, newer: { title: "New", rel: "New.md" }, claim: "c" };

test("runner: review → verify → because → accept, each recorded through the CLI", async () => {
  const { ports, recorded, accepted } = runnerFake(
    [
      { proposal: "p1", stage: "review", ...side, olderText: "o", newerText: "n" },
      { proposal: "p1", stage: "verify", ...side, decision: "correction", olderArtifact: { hash: "h1", passages: [{ locator: "chars 0-9", text: "t" }] }, newerArtifact: null },
      { proposal: "p1", stage: "because", ...side, decision: "correction", confirmed: "x", draft: "d" },
      { proposal: "p1", stage: "accept", ...side },
    ],
    ['{"outcome":"correction","because":"b","quotes_old":["c"],"quotes_new":["n"]}', '{"result":"confirmed","reason":"r"}', '{"would_flip":false,"because":"final"}', '{"adds":false}'],
  );
  const n = await runSteps(ports);
  assert.equal(n, 4);
  const records = recorded.filter((r) => r.args[0] === "record");
  assert.deepEqual(records.map((r) => r.args[4]), ["review", "verify", "because"]);
  assert.equal(records[1].body?.result, "confirmed");
  assert.deepEqual(records[1].body?.evidence, [{ note: "Old.md", artifact: "h1", locator: "chars 0-9" }]);
  assert.equal(records[2].body?.text, "final");
  assert.deepEqual(accepted, ["ev1"]);
});

test("runner: unreachable sources abstain without a model call; wording that adds facts is dropped", async () => {
  const { ports, recorded } = runnerFake(
    [
      { proposal: "p1", stage: "verify", ...side, olderArtifact: null, newerArtifact: null },
      { proposal: "p2", stage: "because", ...side, confirmed: "x", draft: "the reviewer's draft" },
    ],
    ['{"would_flip":false,"because":"adds a number: 42"}', '{"adds":true}'],
  );
  await runSteps(ports);
  const records = recorded.filter((r) => r.args[0] === "record");
  assert.equal(records[0].body?.result, "abstain");
  assert.equal(records[1].body?.text, "the reviewer's draft");
  assert.equal(records[1].body?.checked, false);
});

test("runner: no answer is not a verdict, and a step that comes back unchanged stops the run", async () => {
  const a = runnerFake([{ proposal: "p1", stage: "review", ...side }], []);
  assert.equal(await runSteps(a.ports), 0);
  assert.equal(a.recorded.filter((r) => r.args[0] === "record").length, 0);
  const pk = { proposal: "p1", stage: "verify", ...side, olderArtifact: null, newerArtifact: null };
  const b = runnerFake([pk, pk, pk], []);
  assert.equal(await runSteps(b.ports), 1);
});
