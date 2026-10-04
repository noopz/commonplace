import { test } from "node:test";
import assert from "node:assert/strict";
import {
  promptTokens,
  segmentShift,
  remember,
  freshSegment,
  pickPrimeCandidate,
  primeBlock,
  parsePrimeVerdict,
  PRIME_JUDGE_PROMPT,
  MIN_PROMPT_TOKENS,
} from "./prime.ts";
import { parseNote } from "../index/parse.ts";
import { buildIndex, type IndexNote } from "../index/model.ts";
import { serializeIndex } from "../index/layout.ts";
import { VaultIndex, type IndexPorts } from "../index/load.ts";
import { RANK_LINEAR } from "../index/postings.ts";

const T = (s: string) => promptTokens(s);

test("short prompts are neither compared nor stored", () => {
  assert.equal(segmentShift(freshSegment(), T("fix the typo")), null);
  assert.ok(T("calibrate the gamma sensor drift budget across staged rollout windows").length >= MIN_PROMPT_TOKENS);
});

test("first prompt starts a segment; an on-topic follow-up does not; a new topic does", () => {
  let s = freshSegment();
  const a = T("calibrate the gamma sensor drift budget across staged rollout windows");
  const first = segmentShift(s, a)!;
  assert.equal(first.shift, true);
  s = remember(s, a, first.shift);
  const b = T("now tighten the gamma sensor drift budget for the second rollout window");
  const follow = segmentShift(s, b)!;
  assert.equal(follow.shift, false, `overlap ${follow.overlap}`);
  s = remember({ ...s, touches: 1 }, b, follow.shift);
  assert.equal(s.touches, 1, "touches persist within a segment");
  const c = T("write a sourdough starter feeding schedule with hydration percentages and timings");
  const shift = segmentShift(s, c)!;
  assert.equal(shift.shift, true);
  assert.equal(remember(s, c, true).touches, 0, "a new segment resets the shared budget");
});

const info = (m: Record<number, Partial<{ stub: boolean; ret: boolean; kind: string }>>) => (id: number) =>
  m[id] ? { stub: false, ret: false, kind: "source", ...m[id] } : undefined;

test("candidate must be strong, clearly ahead, and not a stub, retired note, MOC or seen", () => {
  const hits = [
    { id: 1, score: 40, matched: ["gamma", "drift"] },
    { id: 2, score: 20, matched: ["gamma"] },
  ];
  const all = info({ 1: {}, 2: {} });
  assert.equal(pickPrimeCandidate(hits, all, new Set()).decision, "pick");
  assert.equal(pickPrimeCandidate(hits, info({ 1: { stub: true }, 2: {} }), new Set()).decision, "weak", "falls to the weak runner-up");
  assert.equal(pickPrimeCandidate(hits, info({ 1: { kind: "moc" }, 2: {} }), new Set()).decision, "weak");
  assert.equal(pickPrimeCandidate(hits, all, new Set([1])).decision, "weak");
  const close = [
    { id: 1, score: 40, matched: ["gamma", "drift"] },
    { id: 2, score: 38, matched: ["gamma", "drift"] },
  ];
  assert.equal(pickPrimeCandidate(close, all, new Set()).decision, "weak", "a close second is a region, not a note");
  const oneTerm = [{ id: 1, score: 40, matched: ["gamma"] }];
  assert.equal(pickPrimeCandidate(oneTerm, all, new Set()).decision, "weak");
  assert.equal(pickPrimeCandidate([], all, new Set()).decision, "none");
});

test("block carries the pointer, the why and the unverified caveat; judge prompt clips the task", () => {
  const b = primeBlock({ title: "Alpha Report", vault: "acme", domain: "alpha", abstraction: "staged calibration", why: "covers the drift budget", path: "Research/Alpha/Alpha Report.md" });
  assert.match(b, /^<commonplace-prime unverified="true">/);
  assert.match(b, /\[\[Alpha Report\]\] \(acme, alpha\)/);
  assert.match(b, /Unverified pointer/);
  assert.ok(PRIME_JUDGE_PROMPT("x".repeat(2000), { title: "A", abstraction: "b" }, "t").length < 900);
  assert.equal(parsePrimeVerdict("SKIP"), null);
  assert.equal(parsePrimeVerdict("It records the drift budget this task must set."), "It records the drift budget this task must set.");
});

// ---------------------------------------------------------------------------
// Sync lane over an invented vault (plan §8.6 CI fixture): three prompts that
// should yield a candidate, three that must not.
// ---------------------------------------------------------------------------

const DOMAINS = { alpha: { path: "Research/Alpha", scope: "public" as const }, gamma: { path: "Research/Gamma", scope: "private" as const } };
const NOTES: Record<string, string> = {
  "Research/Alpha/Kestrel Calibration Protocol.md": "---\nabstraction: staged kestrel sensor calibration with drift budgets\n---\n# Kestrel Calibration Protocol\n",
  "Research/Alpha/Marble Queue Sharding.md": "---\nabstraction: sharding marble queues by tenant to bound tail latency\n---\n# Marble Queue Sharding\n",
  "Research/Alpha/Lantern Cache Eviction.md": "---\nabstraction: lantern cache eviction under bursty read amplification\n---\n# Lantern Cache Eviction\n",
  "Research/Alpha/Sensor Overview.md": "---\nabstraction: general notes on sensors\n---\n# Sensor Overview\n",
  "Research/Alpha/Queue Overview.md": "---\nabstraction: general notes on queues\n---\n# Queue Overview\n",
  "Research/Gamma/Gamma Orchard Ledger.md": "---\nabstraction: orchard ledger reconciliation for gamma harvest\n---\n# Gamma Orchard Ledger\n",
};
for (let i = 0; i < 30; i++) NOTES[`Research/Alpha/Filler ${i}.md`] = `---\nabstraction: filler topic number ${i} about pottery glazes\n---\n# Filler ${i}\n`;

async function syncLane() {
  const notes: IndexNote[] = Object.entries(NOTES).map(([rel, text]) => ({ rel, parsed: parseNote(rel, text, {}), mt: 1, sz: text.length, stub: false }));
  const r = buildIndex(notes, { domains: DOMAINS, version: 1, builtAt: "t" });
  const files = new Map(serializeIndex(r, { version: 1, builtAt: "t" }));
  const ports: IndexPorts = {
    read: async (rel) => files.get(rel) ?? null,
    head: async (rel, n) => files.get(rel)?.slice(0, n) ?? null,
    size: async (rel) => files.get(rel)?.length ?? null,
    append: async () => {},
    now: () => 0,
  };
  const idx = new VaultIndex(ports, DOMAINS);
  await idx.load();
  return async (prompt: string) => {
    const hits = idx.view!.search(prompt, { limit: 8, rank: RANK_LINEAR }); // as register.tsx
    const cards = await idx.cards(hits.map((h) => h.id));
    const pick = pickPrimeCandidate(hits, (id) => {
      const c = cards.get(id);
      return c ? { stub: c.stub, ret: c.ret, kind: c.k } : undefined;
    }, new Set());
    return pick.decision === "pick" ? cards.get(pick.hit.id)!.t : null;
  };
}

test("fixture: specific prompts prime their note; adjacent, generic and sealed ones do not", async () => {
  const lane = await syncLane();
  assert.equal(await lane("set up the kestrel calibration protocol with a drift budget for the new sensors"), "Kestrel Calibration Protocol");
  assert.equal(await lane("plan marble queue sharding per tenant so tail latency stays bounded"), "Marble Queue Sharding");
  assert.equal(await lane("tune lantern cache eviction for bursty read amplification"), "Lantern Cache Eviction");
  assert.equal(await lane("write a short poem about sensors and queues in general"), null, "adjacent vocabulary");
  assert.equal(await lane("summarise this meeting transcript into action items for the team"), null, "nothing in the vault");
  assert.equal(await lane("reconcile the gamma orchard ledger for this harvest"), null, "sealed domain");
});
