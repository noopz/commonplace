/**
 * Tests for the ambient connection-surfacing pipeline.
 *
 * ALL FIXTURES HERE ARE INVENTED. This repo is public: no note title, concept
 * name, domain slug, path or body text below comes from any real vault. The
 * placeholders (`Alpha Lattice`, `Gamma Term`, domains `alpha`/`gamma`) exist
 * only to exercise code paths.
 *
 * The assertions are on the RECORDED PORT CALLS, not just on return values:
 * the cost behaviour (which model calls happen, and when) is the thing worth
 * locking down.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  runConnectionPass,
  resetIndexCache,
  ensureRecords,
  privateNames,
  MAX_FAILURES,
  MIN_TURN_GAP,
  LEX_STRONG_SCORE,
  PREEMPT_SCORE,
  PREEMPT_TURN_GAP,
  INDEX_TTL_MS,
  SESSION_KEY,
  VAULT_KEY_PREFIX,
  type Ports,
  type SessionState,
} from "./pipeline.js";
import type { Status } from "./status.js";

// ---------------------------------------------------------------------------
// Fixtures (invented)
// ---------------------------------------------------------------------------

const VAULT = "/fake/vault-alpha";
const PROJECT = "/fake/project-alpha";
const ALPHA_PATH = "concepts/alpha/Alpha Lattice.md";

/** Long enough to clear MIN_ANSWER_CHARS and carry >= 8 significant tokens. */
const ANSWER =
  "The alpha lattice folding technique reshapes the gamma tensor by walking " +
  "every vertex twice, first collapsing redundant edges and then rebalancing " +
  "the weights so that the resulting structure keeps its diagonal symmetry " +
  "intact. This differs from the older beta traversal, which rebalanced only " +
  "once and therefore drifted whenever the input was sparse or irregular.";

/** Long enough to clear MIN_ANSWER_CHARS but with a single distinct token. */
const THIN_ANSWER = "aaaa ".repeat(60);

/** Title tokens alpha+lattice both match the answer: 2 * 4 = 8 >= MIN_SEED_SCORE. */
const ALPHA_RECORD = {
  title: "Alpha Lattice",
  path: ALPHA_PATH,
  abstraction: "folding a lattice while preserving diagonal symmetry",
  tags: ["alpha"],
  authority: 0.5,
};

/** A second matchable note, for tests that need a candidate after the first is seen. */
const ALPHA_SIBLING_RECORD = {
  title: "Alpha Tensor Rebalancing",
  path: "concepts/alpha/Alpha Tensor Rebalancing.md",
  abstraction: "rebalancing weights in an alpha tensor after folding",
  tags: ["alpha"],
  authority: 0.3,
};

/** Shares no substantive token with ANSWER. */
const UNRELATED_RECORD = {
  title: "Gamma Term",
  path: "concepts/gamma/Gamma Term.md",
  abstraction: "an unrelated placeholder concept about quarterly ledgers",
  tags: ["gamma"],
  authority: 0.1,
};

/**
 * Scores past PREEMPT_SCORE: three title tokens (12) plus abstraction hits.
 * The shape of an answer that is discussing a note by name.
 */
const STRONG_RECORD = {
  title: "Diagonal Symmetry Rebalancing",
  path: "concepts/alpha/Diagonal Symmetry Rebalancing.md",
  abstraction: "rebalancing weights to preserve diagonal symmetry while folding",
  tags: ["alpha"],
  authority: 0.6,
};

const GAMMA_PATH = UNRELATED_RECORD.path;

/**
 * Matches only through its abstraction, never its title: three abstraction
 * tokens = 9, which clears MIN_SEED_SCORE (6) but not LEX_STRONG_SCORE (12).
 * This is the shape that should buy a graph walk rather than end the pass.
 */
const WEAK_RECORD = {
  title: "Zeta Ledger",
  path: "concepts/zeta/Zeta Ledger.md",
  abstraction: "collapsing redundant edges",
  tags: ["zeta"],
  authority: 0.2,
};

/** A private-domain note: never surfaceable, however the graph ranks it. */
const PRIVATE_PATH = "concepts/delta/Delta Ledger.md";
const PRIVATE_RECORD = {
  title: "Delta Ledger",
  path: PRIVATE_PATH,
  abstraction: "a placeholder note in a private domain",
  scope: "private",
  authority: 0.9,
};

const NOTE_BODY =
  "---\ntitle: Alpha Lattice\n---\n\n" +
  "The alpha lattice is a folding scheme that preserves diagonal symmetry by " +
  "rebalancing after every collapse step rather than once at the end. " +
  "Earlier experiments showed the single-pass variant drifting on sparse input.";

const VERDICT = "Records the earlier drift finding that motivated double rebalancing.";

/** Stdout in the shape `commonplace connect --json` prints. */
function connectJson(cands: { path: string; title: string }[]): string {
  return JSON.stringify({
    query: "q",
    k: cands.length,
    candidates: cands.map((c, i) => ({
      ...c,
      kind: "concept",
      abstraction: null,
      ppr: 0.09 - i * 0.01,
      lex: 0,
      score: 1.2 - i * 0.1,
    })),
  });
}

function jsonl(recs: object[]): string {
  return recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function initialStatus(): Status {
  return {
    phase: "idle",
    sources: 0,
    concepts: 0,
    surfaced: 0,
    lastOutcome: "",
    lastError: "",
    paused: false,
    visible: false,
  };
}

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------

type Call = { name: keyof Ports; args: unknown[] };

type Fake = {
  ports: Ports;
  calls: Call[];
  traces: { stage: string; detail: Record<string, unknown> }[];
  store: Map<string, unknown>;
  /** Mutable knobs, read at call time. */
  session: string;
  turn: number;
  clock: number;
  classifyResult: string;
  completeResult: string;
  indexRecords: object[];
  noteBody: string;
  /** Raw stdout the fake `commonplace connect` returns. "" = no graph opinion. */
  connectResult: string;
  /** Port names that should throw when called. */
  throwing: Set<keyof Ports>;
  status: Status;
  count(name: keyof Ports): number;
  sessionRecord(): SessionState | undefined;
  reset(): void;
};

function makeFake(): Fake {
  const fake = {
    calls: [] as Call[],
    traces: [] as { stage: string; detail: Record<string, unknown> }[],
    store: new Map<string, unknown>(),
    session: "session-one",
    turn: 1,
    clock: 1_000_000,
    classifyResult: "technical-substance",
    completeResult: VERDICT,
    indexRecords: [ALPHA_RECORD, UNRELATED_RECORD] as object[],
    noteBody: NOTE_BODY,
    connectResult: "",
    throwing: new Set<keyof Ports>(),
    status: initialStatus(),
  } as Fake;

  const rec = (name: keyof Ports, ...args: unknown[]) => {
    fake.calls.push({ name, args });
    if (fake.throwing.has(name)) throw new Error(`boom:${name}`);
  };

  fake.ports = {
    sessionId: async () => {
      rec("sessionId");
      return fake.session;
    },
    turnCount: async () => {
      rec("turnCount");
      return fake.turn;
    },
    cwd: async () => {
      rec("cwd");
      return PROJECT;
    },
    getState: async (key) => {
      rec("getState", key);
      return fake.store.get(key);
    },
    setState: async (key, value) => {
      rec("setState", key, value);
      fake.store.set(key, value);
    },
    readText: async (path): Promise<string> => {
      rec("readText", path);
      if (path.endsWith("/.wiki/concept-index.jsonl")) return jsonl(fake.indexRecords);
      if (path.endsWith("/.wiki/source-index.jsonl")) return "";
      return fake.noteBody;
    },
    runCommand: async (argv) => {
      rec("runCommand", argv.join(" "));
      if (argv.join(" ") === "vault-path") return VAULT;
      if (argv[0] === "connect") return fake.connectResult;
      return "";
    },
    classify: async (text, labels) => {
      rec("classify", text, labels);
      return fake.classifyResult;
    },
    complete: async (req) => {
      rec("complete", req);
      return fake.completeResult;
    },
    now: () => {
      rec("now");
      return fake.clock;
    },
    status: () => fake.status,
    trace: (stage, detail = {}) => {
      // Deliberately NOT recorded in `calls`: trace is free bookkeeping, and
      // the "touches no port at all" assertions are about SPEND. Kept in its
      // own list so tests can assert the pass says why it declined.
      fake.traces.push({ stage, detail });
    },
    note: (outcome, extra = {}) => {
      rec("note", outcome, extra);
      fake.status = { ...fake.status, lastOutcome: outcome, visible: true, ...extra };
    },
  };

  fake.count = (name) => fake.calls.filter((c) => c.name === name).length;
  fake.sessionRecord = () => fake.store.get(SESSION_KEY) as SessionState | undefined;
  fake.reset = () => {
    fake.calls.length = 0;
    fake.traces.length = 0;
  };
  return fake;
}

const answerInput = (answer = ANSWER) => ({ answer, reason: "answer", aborted: false });

/** Names of ports that spend money or time — the ones the guards protect. */
const EXPENSIVE: (keyof Ports)[] = ["runCommand", "readText", "classify", "complete"];

function assertNoExpensiveCalls(fake: Fake, msg?: string) {
  for (const name of EXPENSIVE) {
    assert.equal(fake.count(name), 0, `${msg ?? "expected no spend"}: ${name} was called`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runConnectionPass", () => {
  let fake: Fake;

  beforeEach(() => {
    resetIndexCache();
    fake = makeFake();
  });

  // -- Free guards ---------------------------------------------------------

  test("non-answer reasons and aborted turns touch no port at all", async () => {
    assert.equal(
      await runConnectionPass(fake.ports, { answer: ANSWER, reason: "tool", aborted: false }),
      null,
    );
    assert.equal(
      await runConnectionPass(fake.ports, { answer: ANSWER, reason: "answer", aborted: true }),
      null,
    );
    assert.equal(fake.calls.length, 0);
  });

  test("a short answer touches no port at all", async () => {
    assert.equal(await runConnectionPass(fake.ports, answerInput("tiny")), null);
    assert.equal(fake.calls.length, 0);
  });

  test("the token-count guard runs before the session or vault is resolved", async () => {
    assert.equal(await runConnectionPass(fake.ports, answerInput(THIN_ANSWER)), null);
    // Not even sessionId: the guard is meant to be entirely free.
    assert.equal(fake.calls.length, 0);
  });

  // -- Happy path ----------------------------------------------------------

  test("full path: classify, read the note, judge, surface, bank the turn", async () => {
    const out = await runConnectionPass(fake.ports, answerInput());
    assert.deepEqual(out, { text: `⟡ vault · [[Alpha Lattice]] — ${VERDICT}` });

    // Order of spend: vault resolve, two index reads, classify, note read, judge.
    const spend = fake.calls
      .filter((c) => EXPENSIVE.includes(c.name))
      .map((c) => `${c.name}:${String(c.args[0]).split("/").pop()}`);
    assert.deepEqual(spend, [
      "runCommand:vault-path",
      "readText:concept-index.jsonl",
      "readText:source-index.jsonl",
      `classify:${ANSWER.slice(0, 800).split("/").pop()}`,
      "readText:Alpha Lattice.md",
      "complete:[object Object]",
    ]);

    // The judge saw the note body with frontmatter stripped.
    const req = fake.calls.find((c) => c.name === "complete")!.args[0] as { prompt: string };
    assert.ok(req.prompt.includes('VAULT NOTE "Alpha Lattice"'));
    assert.ok(!req.prompt.includes("title: Alpha Lattice"));

    // Vault path persisted under the project-keyed key.
    assert.equal(fake.store.get(`${VAULT_KEY_PREFIX}${PROJECT}`), VAULT);

    // Session record: correct id, turn banked, note remembered, breaker clear.
    assert.deepEqual(fake.sessionRecord(), {
      id: "session-one",
      lastTurn: 1,
      failures: 0,
      seen: [ALPHA_PATH],
    });
    assert.equal(fake.status.surfaced, 1);
    assert.equal(fake.status.lastOutcome, "surfaced a connection");
  });

  test("a cached vault path skips the 7s resolve", async () => {
    fake.store.set(`${VAULT_KEY_PREFIX}${PROJECT}`, VAULT);
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.count("runCommand"), 0);
    assert.equal(fake.count("complete"), 1);
  });

  // -- Circuit breaker -----------------------------------------------------

  test("breaker trips after MAX_FAILURES thrown errors within one session", async () => {
    fake.throwing.add("complete");

    for (let i = 1; i <= MAX_FAILURES; i++) {
      fake.turn = i * MIN_TURN_GAP;
      fake.reset();
      assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
      assert.equal(fake.count("complete"), 1, `attempt ${i} should reach the judge`);
      const recd = fake.sessionRecord();
      assert.equal(recd?.id, "session-one", "failure record carries the CURRENT session id");
      assert.equal(recd?.failures, i, "failures accumulate across thrown errors");
    }
    assert.equal(fake.status.paused, true);

    // Next turn: paused, re-announced, and nothing expensive runs.
    fake.turn = (MAX_FAILURES + 1) * MIN_TURN_GAP;
    fake.reset();
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    assertNoExpensiveCalls(fake, "tripped breaker must not spend");
    assert.equal(fake.count("turnCount"), 0, "breaker check precedes the rate limit");
    const paused = fake.calls.find((c) => c.name === "note");
    assert.equal(paused?.args[0], "paused");
    assert.deepEqual(paused?.args[1], { paused: true, phase: "warn" });
  });

  test("breaker does not trip when the errors span different session ids", async () => {
    fake.throwing.add("complete");

    for (let i = 1; i <= MAX_FAILURES + 1; i++) {
      fake.session = `session-${i}`;
      fake.turn = 1;
      fake.reset();
      await runConnectionPass(fake.ports, answerInput());
      assert.equal(fake.count("complete"), 1, `session ${i} still attempts`);
      assert.deepEqual(fake.sessionRecord(), {
        id: `session-${i}`,
        lastTurn: -999,
        failures: 1,
        seen: [],
      });
    }
    assert.equal(fake.status.paused, false);
  });

  test("a stale record from a previous session does not reset the counter forever", async () => {
    // The real bug: the catch block wrote the failure under the PREVIOUS
    // session's id, so the next turn saw a mismatch, rebound to failures: 0,
    // and the breaker could never trip. Seed the store with such a stale
    // record and check the counter climbs under the new id.
    fake.store.set(SESSION_KEY, {
      id: "session-stale",
      lastTurn: 7,
      failures: MAX_FAILURES - 1,
      seen: ["concepts/gamma/Gamma Term.md"],
    });
    fake.session = "session-new";
    fake.throwing.add("complete");

    fake.turn = 1;
    await runConnectionPass(fake.ports, answerInput());
    // Not inherited from the stale record — and not lost either.
    assert.deepEqual(fake.sessionRecord(), {
      id: "session-new",
      lastTurn: -999,
      failures: 1,
      seen: [],
    });

    fake.turn = 2;
    fake.reset();
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.count("complete"), 1);
    assert.equal(fake.sessionRecord()?.failures, 2, "second error accumulates, not resets");

    fake.turn = 3;
    fake.reset();
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.sessionRecord()?.failures, 3);
    assert.equal(fake.status.paused, true);

    fake.turn = 4;
    fake.reset();
    await runConnectionPass(fake.ports, answerInput());
    assertNoExpensiveCalls(fake, "breaker should now be tripped");
  });

  test("a new session clears a paused band from module scope", async () => {
    fake.status = { ...initialStatus(), paused: true, lastError: "old", phase: "warn" };
    fake.store.set(SESSION_KEY, { id: "session-old", failures: MAX_FAILURES, seen: [] });
    fake.session = "session-fresh";
    await runConnectionPass(fake.ports, answerInput());
    const clear = fake.calls.find((c) => c.name === "note");
    assert.equal(clear?.args[0], "");
    assert.deepEqual(clear?.args[1], {
      paused: false,
      lastError: "",
      phase: "idle",
      visible: false,
    });
    // And the feature actually resumed.
    assert.equal(fake.count("complete"), 1);
  });

  test("an empty vault-path resolution counts as a failure under the right id", async () => {
    fake.ports.runCommand = async (cmd) => {
      fake.calls.push({ name: "runCommand", args: [cmd] });
      return "   ";
    };
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    assert.equal(fake.count("readText"), 0);
    assert.deepEqual(fake.sessionRecord(), {
      id: "session-one",
      lastTurn: -999,
      failures: 1,
      seen: [],
    });
    assert.equal(fake.status.lastError, "commonplace vault-path returned nothing");
  });

  test("an unparseable index counts as a failure and is not cached", async () => {
    fake.indexRecords = [];
    for (let i = 1; i <= MAX_FAILURES; i++) {
      fake.turn = i;
      fake.reset();
      await runConnectionPass(fake.ports, answerInput());
      assert.equal(fake.count("readText"), 2, "re-read each turn: nothing was cached");
      assert.equal(fake.sessionRecord()?.failures, i);
    }
    assert.equal(fake.status.paused, true);
  });

  // -- Rate limit ----------------------------------------------------------

  test("rate limit blocks a second expensive attempt within MIN_TURN_GAP turns", async () => {
    fake.turn = 1;
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.count("classify"), 1);

    for (let t = 2; t < 1 + MIN_TURN_GAP; t++) {
      fake.turn = t;
      fake.reset();
      assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
      assertNoExpensiveCalls(fake, `turn ${t} inside the gap`);
    }

    // The first attempt surfaced Alpha Lattice, so it is in the seen-set;
    // give the gap-elapsed attempt a fresh candidate to spend on.
    fake.indexRecords = [ALPHA_RECORD, ALPHA_SIBLING_RECORD, UNRELATED_RECORD];
    fake.clock += INDEX_TTL_MS + 1;
    fake.turn = 1 + MIN_TURN_GAP;
    fake.reset();
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.count("classify"), 1, "gap elapsed: attempt again");
  });

  test("rate limit is per session: turnCount restarting at 1 does not starve a new session", async () => {
    fake.turn = 9;
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.sessionRecord()?.lastTurn, 9);

    fake.session = "session-two";
    fake.turn = 1;
    fake.reset();
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.count("classify"), 1, "stored lastTurn: 9 must not apply to a new session");
  });

  test("a classify rejection still banks the turn", async () => {
    fake.classifyResult = "routine-coding-chatter";
    fake.turn = 1;
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    assert.equal(fake.count("classify"), 1);
    assert.equal(fake.count("complete"), 0, "judge never runs after a classify rejection");
    // Note read is the third readText; only the two index reads should exist.
    assert.equal(fake.count("readText"), 2);
    assert.deepEqual(fake.sessionRecord(), {
      id: "session-one",
      lastTurn: 1,
      failures: 0,
      seen: [],
    });

    fake.turn = 2;
    fake.reset();
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.count("classify"), 0, "classify spend is bounded by the rate limit");
  });

  test("a judged SKIP banks the turn and remembers the note", async () => {
    fake.completeResult = "SKIP";
    fake.turn = 1;
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    assert.deepEqual(fake.sessionRecord(), {
      id: "session-one",
      lastTurn: 1,
      failures: 0,
      seen: [ALPHA_PATH],
    });
    fake.turn = 2;
    fake.reset();
    await runConnectionPass(fake.ports, answerInput());
    assertNoExpensiveCalls(fake, "inside the gap after a SKIP");
  });

  // -- Seen-set ------------------------------------------------------------

  test("the seen-set prevents re-judging the same note within a session", async () => {
    fake.completeResult = "SKIP";
    fake.turn = 1;
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.count("complete"), 1);

    fake.turn = 1 + MIN_TURN_GAP;
    fake.reset();
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    assert.equal(fake.count("complete"), 0, "the judge is not paid twice for one note");
    assert.equal(
      fake.calls.filter((c) => c.name === "readText" && String(c.args[0]).endsWith(".md")).length,
      0,
      "the note itself is not re-read",
    );
    assert.equal(fake.calls.find((c) => c.name === "note")?.args[0], "no candidates");
  });

  test("a rate-limited turn still spends nothing", async () => {
    // The limiter moved BEHIND the vault resolve and the index load so it can
    // see the seed score. Both are cached and free; what must stay true is
    // that a skipped turn costs no model call and no subprocess.
    fake.turn = 1;
    await runConnectionPass(fake.ports, answerInput());
    fake.turn = 2;
    fake.reset();
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    assertNoExpensiveCalls(fake, "inside the gap");
    assert.ok(
      fake.traces.some((t) => t.stage === "skip:rate-limited"),
      "and it says so",
    );
  });

  test("an exceptionally strong hit preempts the ordinary gap", async () => {
    // The live failure this fixes: the limiter ran before the seed, so it
    // spent the budget on whichever turn arrived first. A throwaway turn took
    // the slot, and the turn the vault genuinely covered was skipped without
    // the pass ever looking at it.
    fake.completeResult = "SKIP";
    fake.turn = 1;
    await runConnectionPass(fake.ports, answerInput());

    // A different strong note, so the preempting turn has unseen evidence.
    fake.indexRecords = [ALPHA_SIBLING_RECORD, STRONG_RECORD, UNRELATED_RECORD];
    fake.clock += INDEX_TTL_MS + 1;
    fake.turn = 1 + PREEMPT_TURN_GAP;
    fake.reset();
    await runConnectionPass(fake.ports, answerInput());

    assert.ok(
      fake.traces.some((t) => t.stage === "rate:preempted"),
      "a strong unseen hit runs inside the ordinary gap",
    );
    assert.equal(fake.count("complete"), 1, "and it reaches the judge");
  });

  test("preempting never means twice in a row", async () => {
    fake.completeResult = "SKIP";
    fake.indexRecords = [STRONG_RECORD, UNRELATED_RECORD];
    fake.turn = 1;
    await runConnectionPass(fake.ports, answerInput());

    fake.indexRecords = [ALPHA_RECORD, STRONG_RECORD, UNRELATED_RECORD];
    fake.clock += INDEX_TTL_MS + 1;
    fake.turn = 2;
    fake.reset();
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    // readText is allowed here: the fixture expires the index cache, and an
    // index reload is free-ish work. What must not happen is SPEND.
    assert.equal(fake.count("classify"), 0, "no classify on the very next turn");
    assert.equal(fake.count("complete"), 0, "no judge on the very next turn");
    assert.equal(fake.count("runCommand"), 0, "no walk on the very next turn");
    assert.equal(
      fake.traces.find((t) => t.stage === "skip:rate-limited")?.detail.gap,
      PREEMPT_TURN_GAP,
      "blocked by the preempt gap, not the ordinary one",
    );
  });

  test("a strong hit already seen does not preempt", async () => {
    // Otherwise one sticky note dominates a session: it would preempt every
    // other turn forever while never being new evidence.
    fake.completeResult = "SKIP";
    fake.indexRecords = [STRONG_RECORD, UNRELATED_RECORD];
    fake.turn = 1;
    await runConnectionPass(fake.ports, answerInput());

    fake.turn = 1 + PREEMPT_TURN_GAP;
    fake.reset();
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    assertNoExpensiveCalls(fake, "the only strong hit is already judged");
  });

  test("the seen-set is session-scoped", async () => {
    fake.store.set(SESSION_KEY, { id: "session-old", lastTurn: 1, failures: 0, seen: [ALPHA_PATH] });
    fake.session = "session-new";
    fake.turn = 1;
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.count("complete"), 1, "a note seen last week is judgeable again today");
  });

  // -- Seed ----------------------------------------------------------------

  test("neither seed tier finds anything: no judge, and the turn is banked", async () => {
    fake.indexRecords = [UNRELATED_RECORD];
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    assert.equal(fake.count("complete"), 0, "the expensive judge is never reached");
    assert.equal(fake.count("readText"), 2, "only the two index reads");
    assert.equal(fake.status.lastOutcome, "no candidates");
    // The classify and the walk were both SPENT, so the rate limit has to
    // count this turn or a session that never seeds pays on every turn.
    assert.equal(fake.sessionRecord()?.lastTurn, fake.turn);
  });

  // -- Tier 2b: the graph seed --------------------------------------------

  test("the graph tier reaches a note with no lexical overlap at all", async () => {
    // The point of the tier: GAMMA_RECORD shares no token with the answer, so
    // `rankCandidates` cannot see it. PPR can.
    fake.indexRecords = [UNRELATED_RECORD];
    fake.connectResult = connectJson([{ path: GAMMA_PATH, title: "Gamma Term" }]);

    const out = await runConnectionPass(fake.ports, answerInput());
    assert.ok(out, "a graph-only candidate still reaches the judge");
    assert.match(out!.text, /Gamma Term/);
    assert.ok(
      fake.calls.some(
        (c) => c.name === "readText" && String(c.args[0]) === `${VAULT}/${GAMMA_PATH}`,
      ),
      "the note is READ before judging — a PPR score is not relevance either",
    );
  });

  test("a STRONG lexical hit skips the walk", async () => {
    // ALPHA_RECORD matches on title and abstraction, well past
    // LEX_STRONG_SCORE. ~400ms of subprocess that could not change the
    // outcome: only the top candidate is ever read.
    await runConnectionPass(fake.ports, answerInput());
    const top = fake.traces.find((t) => t.stage === "seed:lexical");
    assert.ok(Number(top?.detail.score) >= LEX_STRONG_SCORE, "fixture must be a strong hit");
    assert.equal(
      fake.calls.filter((c) => c.name === "runCommand" && String(c.args[0]).startsWith("connect")).length,
      0,
    );
  });

  test("a WEAK lexical hit buys a walk, and the graph candidate leads", async () => {
    // The bug this replaced: the walk was gated on the lexical tier being
    // EMPTY, which on a real vault never happens — MIN_SEED_SCORE is easy to
    // clear once there are a few hundred records, so the tier was dead code.
    fake.indexRecords = [WEAK_RECORD, UNRELATED_RECORD];
    fake.connectResult = connectJson([{ path: GAMMA_PATH, title: "Gamma Term" }]);

    const out = await runConnectionPass(fake.ports, answerInput());
    const seedTrace = fake.traces.find((t) => t.stage === "seed:lexical");
    assert.ok(Number(seedTrace?.detail.score) > 0, "the lexical tier did find something");
    assert.ok(Number(seedTrace?.detail.score) < LEX_STRONG_SCORE, "but not strongly");
    assert.ok(
      fake.traces.some((t) => t.stage === "seed:graph"),
      "a thin lexical hit must not end the pass",
    );
    // Preferring the thin lexical hit anyway would waste the walk.
    assert.equal(fake.traces.find((t) => t.stage === "judge:candidate")?.detail.tier, "graph");
    assert.match(out!.text, /Gamma Term/);
  });

  test("a graph candidate with no surfaceable index record is dropped", async () => {
    // `connect` ranks the whole vault with no scope filter and returns MOC
    // paths the pass never loads. Fail closed: no record, no surface.
    fake.indexRecords = [UNRELATED_RECORD, PRIVATE_RECORD];
    fake.connectResult = connectJson([
      { path: "00 - Maps/Some Map.md", title: "Some Map" },
      { path: PRIVATE_PATH, title: "Private Thing" },
    ]);
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    assert.equal(fake.count("complete"), 0, "nothing unvouched-for reaches the judge");
  });

  test("a broken graph walk is a shrug, not a circuit-breaker failure", async () => {
    fake.indexRecords = [UNRELATED_RECORD];
    fake.connectResult = "not json at all";
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    assert.equal(fake.sessionRecord()?.failures, 0, "an opinionless graph is not a failure");
    assert.equal(fake.status.paused, false);
  });

  test("a thin note body stops before the judge", async () => {
    fake.noteBody = "---\ntitle: Alpha Lattice\n---\nstub";
    assert.equal(await runConnectionPass(fake.ports, answerInput()), null);
    assert.equal(fake.count("classify"), 1);
    assert.equal(fake.count("complete"), 0);
  });

  // -- Error containment ---------------------------------------------------

  test("a thrown error from any port never propagates", async () => {
    const names: (keyof Ports)[] = [
      "sessionId",
      "turnCount",
      "cwd",
      "getState",
      "setState",
      "readText",
      "runCommand",
      "classify",
      "complete",
      "now",
      "note",
    ];
    for (const name of names) {
      resetIndexCache();
      const f = makeFake();
      f.throwing.add(name);
      let out: unknown = "unset";
      await assert.doesNotReject(async () => {
        out = await runConnectionPass(f.ports, answerInput());
      }, `${name} threw out of runConnectionPass`);
      assert.equal(out, null, `${name}: a failed pass surfaces nothing`);
    }
  });

  test("an error before the session is known writes no store record", async () => {
    fake.throwing.add("sessionId");
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.count("setState"), 0);
    // But the band still reports it.
    assert.equal(fake.status.lastError.startsWith("Error: boom:sessionId"), true);
  });

  test("a thrown error preserves lastTurn and seen from the current session", async () => {
    fake.store.set(SESSION_KEY, {
      id: "session-one",
      lastTurn: 1,
      failures: 0,
      seen: ["concepts/gamma/Gamma Term.md"],
    });
    fake.turn = 1 + MIN_TURN_GAP;
    fake.throwing.add("complete");
    await runConnectionPass(fake.ports, answerInput());
    assert.deepEqual(fake.sessionRecord(), {
      id: "session-one",
      lastTurn: 1,
      failures: 1,
      seen: ["concepts/gamma/Gamma Term.md"],
    });
  });

  // -- Index cache ---------------------------------------------------------

  test("the index cache is not re-read within its TTL", async () => {
    fake.turn = 1;
    await runConnectionPass(fake.ports, answerInput());
    assert.equal(fake.count("readText"), 3, "two index reads + the note");
    assert.equal(fake.status.concepts, 2);

    fake.clock += INDEX_TTL_MS - 1;
    fake.turn = 1 + MIN_TURN_GAP;
    fake.completeResult = "SKIP"; // keep the store's seen-set irrelevant to the read count
    fake.store.set(SESSION_KEY, { id: "session-one", lastTurn: 1, failures: 0, seen: [] });
    fake.reset();
    await runConnectionPass(fake.ports, answerInput());
    const indexReads = fake.calls.filter(
      (c) => c.name === "readText" && String(c.args[0]).includes("/.wiki/"),
    );
    assert.equal(indexReads.length, 0, "inside TTL: served from the module cache");
    assert.equal(fake.count("complete"), 1, "the cached records still yield a candidate");

    fake.clock += 2;
    fake.turn = 1 + 2 * MIN_TURN_GAP;
    fake.store.set(SESSION_KEY, { id: "session-one", lastTurn: 1, failures: 0, seen: [] });
    fake.reset();
    await runConnectionPass(fake.ports, answerInput());
    const rereads = fake.calls.filter(
      (c) => c.name === "readText" && String(c.args[0]).includes("/.wiki/"),
    );
    assert.equal(rereads.length, 2, "past TTL: both indexes re-read");
  });

  test("the index cache is keyed by vault path, so a vault switch re-reads", async () => {
    fake.turn = 1;
    await runConnectionPass(fake.ports, answerInput());

    // Same TTL window, different resolved vault for this project.
    fake.store.set(`${VAULT_KEY_PREFIX}${PROJECT}`, "/fake/vault-gamma");
    fake.store.set(SESSION_KEY, { id: "session-one", lastTurn: 1, failures: 0, seen: [] });
    fake.turn = 1 + MIN_TURN_GAP;
    fake.reset();
    await runConnectionPass(fake.ports, answerInput());
    const reads = fake.calls
      .filter((c) => c.name === "readText")
      .map((c) => String(c.args[0]));
    assert.ok(reads.includes("/fake/vault-gamma/.wiki/concept-index.jsonl"));
    assert.ok(reads.includes("/fake/vault-gamma/.wiki/source-index.jsonl"));
  });

  });

// ---------------------------------------------------------------------------
// ensureRecords / privateNames — the deterministic loader behind the leak guard
// ---------------------------------------------------------------------------

describe("ensureRecords", () => {
  beforeEach(() => resetIndexCache());

  const CONCEPTS = '{"name":"Gamma Term","path":"c/Gamma Term.md","scope":"private"}\n';
  const SOURCES = '{"title":"Acme Report","path":"s/Acme Report.md","scope":"public"}\n';

  function reader(log: string[], concepts = CONCEPTS, sources = SOURCES) {
    return async (path: string): Promise<string> => {
      log.push(path);
      return path.includes("concept") ? concepts : sources;
    };
  }

  test("reads both indexes once and serves the rest from cache", async () => {
    const log: string[] = [];
    const first = await ensureRecords("/v", reader(log), () => 1000);
    assert.equal(first.length, 2);
    assert.equal(log.length, 2);

    // Same vault, inside the TTL: no further reads. This is the property the
    // leak guard depends on — it runs on every Write outside the vault.
    const second = await ensureRecords("/v", reader(log), () => 1000 + INDEX_TTL_MS - 1);
    assert.equal(log.length, 2);
    assert.deepEqual(second, first);
  });

  test("re-reads once the TTL lapses and when the vault changes", async () => {
    const log: string[] = [];
    await ensureRecords("/v", reader(log), () => 1000);
    await ensureRecords("/v", reader(log), () => 1000 + INDEX_TTL_MS + 1);
    assert.equal(log.length, 4);
    await ensureRecords("/other", reader(log), () => 1000 + INDEX_TTL_MS + 1);
    assert.equal(log.length, 6);
  });

  test("returns [] rather than throwing on an empty path, empty index, or a throwing reader", async () => {
    // A guard that throws would block a legitimate Write, so every failure
    // here has to be silence, not an exception.
    assert.deepEqual(await ensureRecords("", reader([]), () => 1), []);
    assert.deepEqual(await ensureRecords("/v", reader([], "", ""), () => 1), []);
    assert.deepEqual(
      await ensureRecords("/v", async () => { throw new Error("no"); }, () => 1),
      [],
    );
  });

  test("a failed load does not poison the cache", async () => {
    const log: string[] = [];
    await ensureRecords("/v", async () => { throw new Error("no"); }, () => 1000);
    const recovered = await ensureRecords("/v", reader(log), () => 1000);
    assert.equal(recovered.length, 2);
  });
});

describe("privateNames", () => {
  test("returns private source titles AND private concept names", () => {
    // Concept records carried no scope at all before v1.57.2, so this used to
    // return source titles only — while the rule it serves is about concept
    // names specifically.
    assert.deepEqual(
      privateNames([
        { title: "Acme Report", scope: "private" },
        { name: "Gamma Term", scope: "private" },
        { title: "Public Paper", scope: "public" },
        { name: "Open Term" },
      ]),
      ["Acme Report", "Gamma Term"],
    );
  });

  test("drops records whose title and name are both missing", () => {
    assert.deepEqual(privateNames([{ scope: "private" }, { scope: "private", title: "" }]), []);
  });
});

describe("every decline says why", () => {
  // The property this exists to protect: a pass that declines silently is
  // indistinguishable from a broken one. Diagnosing that cost this branch
  // several rounds of guessing from nothing but a 25ms hook duration.

  test("a non-answer turn traces its reason", async () => {
    const fake = makeFake();
    await runConnectionPass(fake.ports, { answer: ANSWER, reason: "aborted", aborted: true });
    assert.deepEqual(fake.traces.map((t) => t.stage), ["pass:enter", "skip:not-an-answer"]);
  });

  test("a short answer traces the length it wanted", async () => {
    const fake = makeFake();
    await runConnectionPass(fake.ports, { answer: "too short", reason: "answer", aborted: false });
    const skip = fake.traces.find((t) => t.stage === "skip:answer-too-short");
    assert.ok(skip);
    assert.equal(skip.detail.chars, "too short".length);
  });

  test("the rate limit records the turns it compared", async () => {
    const fake = makeFake();
    fake.store.set(SESSION_KEY, { id: "session-one", lastTurn: 10, failures: 0, seen: [] });
    fake.turn = 11;
    await runConnectionPass(fake.ports, { answer: ANSWER, reason: "answer", aborted: false });
    const skip = fake.traces.find((t) => t.stage === "skip:rate-limited");
    assert.ok(skip, "a rate-limited turn must not decline silently");
    assert.equal(skip.detail.turnCount, 11);
    assert.equal(skip.detail.lastTurn, 10);
  });

  test("the pass always traces that it ran, even when it declines instantly", async () => {
    const fake = makeFake();
    await runConnectionPass(fake.ports, { answer: "", reason: "answer", aborted: false });
    assert.equal(fake.traces[0].stage, "pass:enter");
  });
});
