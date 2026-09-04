/**
 * Scoring for the ambient-connection eval — pure, no I/O.
 *
 * WHY THIS EVAL EXISTS AT ALL
 * The connection pass cannot be measured the way `eval:retrieval` measures
 * seeding. Seeding is a pure function of the indexes, so it can be scored
 * offline; the connection pass is a chain of guards, a rate limit, a classify,
 * a subprocess walk and a judge, and only a real session exercises it. One
 * night's live log showed 20 passes, 0 surfaced — a number no unit test could
 * have produced, and one nobody could act on, because "the judge is too
 * strict" and "nothing was worth surfacing" look identical from outside.
 *
 * So the eval drives real sessions (`claude -p`, which does fire
 * `turn.complete`) and reads the trace log the pass writes. The value is not
 * the pass/fail count. It is WHERE a miss died: a miss at the seed, at the
 * rate limit, at the classify and at the judge are four different bugs with
 * four different fixes, and the stage histogram names which one you have.
 */

/** One line of `<vault>/.wiki/hook-log.jsonl`. */
export type LogLine = Record<string, unknown>;

/** What a gold case expects of the pass. */
export type Expect = "surface" | "silent";

export type GoldCase = {
  id: string;
  /** Fed to `claude -p` verbatim. */
  prompt: string;
  expect: Expect;
  /**
   * Vault-relative paths that would count as a correct surface. Optional even
   * for `expect: "surface"` — leaving it off scores "did anything surface"
   * without asserting which note, which is the honest setting when several
   * notes would be a fair answer.
   */
  notes?: string[];
};

/** Where a pass ended. Ordered by how far it got. */
export const STAGES = [
  "never-ran",
  "guard",
  "rate-limited",
  "off-topic",
  "no-candidates",
  "judged-not-relevant",
  "surfaced",
  "error",
] as const;
export type Stage = (typeof STAGES)[number];

export type PassObservation = {
  stage: Stage;
  /** Path the judge was actually paid for, when it got that far. */
  candidate: string;
  /** Which seed tier produced that candidate. */
  tier: string;
  /** Top lexical score this turn — the rate limit's and the walk's input. */
  score: number;
  /** True when the graph walk ran. */
  walked: boolean;
  /** Milliseconds from `pass:enter` to the last line of the pass. */
  ms: number;
};

export type CaseResult = {
  id: string;
  expect: Expect;
  observed: PassObservation;
  /** Did the run do what the gold case asked for? */
  correct: boolean;
  /** Surfaced, but not one of the expected notes. */
  wrongNote: boolean;
};

/**
 * Reduce the log lines produced by ONE session into a single observation.
 *
 * A session may log several passes (one per assistant turn); the eval sends a
 * single prompt, but a session can still emit more than one turn if the model
 * answers in stages. The LAST pass is the one that saw the full answer, so it
 * is the one scored.
 */
export function observePass(lines: readonly LogLine[]): PassObservation {
  const blank: PassObservation = {
    stage: "never-ran",
    candidate: "",
    tier: "",
    score: 0,
    walked: false,
    ms: 0,
  };
  // Split into passes on each `pass:enter`, and keep the last.
  const passes: LogLine[][] = [];
  for (const line of lines) {
    if (line.stage === "pass:enter") passes.push([line]);
    else if (passes.length) passes[passes.length - 1].push(line);
  }
  const pass = passes[passes.length - 1];
  if (!pass) return blank;

  const out: PassObservation = { ...blank, stage: "guard" };
  const at = (l: LogLine) => Date.parse(String(l.at ?? "")) || 0;
  out.ms = Math.max(0, at(pass[pass.length - 1]) - at(pass[0]));

  for (const line of pass) {
    const stage = String(line.stage ?? "");
    const outcome = String(line.outcome ?? "");

    if (stage === "seed:lexical") out.score = Number(line.score ?? 0);
    if (stage === "seed:graph") out.walked = true;
    if (stage === "judge:candidate") {
      out.candidate = String(line.path ?? "");
      out.tier = String(line.tier ?? "");
    }

    // Later stages overwrite earlier ones: the last thing that happened is
    // where the pass ended.
    if (stage === "skip:rate-limited") out.stage = "rate-limited";
    else if (stage === "skip:off-topic") out.stage = "off-topic";
    else if (stage === "skip:no-candidates") out.stage = "no-candidates";
    else if (stage.startsWith("skip:")) out.stage = "guard";

    if (outcome === "judged not relevant") out.stage = "judged-not-relevant";
    else if (outcome === "surfaced a connection") out.stage = "surfaced";
    else if (outcome === "error") out.stage = "error";
  }
  return out;
}

/** Score one observation against what the gold case asked for. */
export function scoreCase(gold: GoldCase, observed: PassObservation): CaseResult {
  const surfaced = observed.stage === "surfaced";
  const expected = gold.notes ?? [];
  // No expected list means "any surface counts" — see GoldCase.notes.
  const rightNote = expected.length === 0 || expected.includes(observed.candidate);

  return {
    id: gold.id,
    expect: gold.expect,
    observed,
    correct: gold.expect === "surface" ? surfaced && rightNote : !surfaced,
    wrongNote: surfaced && !rightNote,
  };
}

export type Summary = {
  total: number;
  correct: number;
  /** Expected a surface and got one, with the right note. */
  hits: number;
  /** Expected a surface and got nothing. */
  misses: number;
  /** Expected silence and got a line anyway — the expensive kind of wrong. */
  falsePositives: number;
  /** Surfaced something, but not a note the gold case named. */
  wrongNotes: number;
  /**
   * Where the MISSES died. This is the actionable half of the eval: a miss at
   * `judged-not-relevant` says the judge is the problem, a miss at
   * `no-candidates` says seeding is, and a miss at `rate-limited` says the
   * eval itself is contending for the budget.
   */
  missStages: Record<string, number>;
  /** Median pass duration in ms, over passes that actually ran. */
  medianMs: number;
};

export function summarize(results: readonly CaseResult[]): Summary {
  const missStages: Record<string, number> = {};
  let hits = 0;
  let misses = 0;
  let falsePositives = 0;
  let wrongNotes = 0;

  for (const r of results) {
    const surfaced = r.observed.stage === "surfaced";
    if (r.wrongNote) wrongNotes++;
    if (r.expect === "surface") {
      if (r.correct) hits++;
      else {
        misses++;
        missStages[r.observed.stage] = (missStages[r.observed.stage] ?? 0) + 1;
      }
    } else if (surfaced) {
      falsePositives++;
    }
  }

  const ran = results.map((r) => r.observed.ms).filter((m) => m > 0).sort((a, b) => a - b);

  return {
    total: results.length,
    correct: results.filter((r) => r.correct).length,
    hits,
    misses,
    falsePositives,
    wrongNotes,
    missStages,
    medianMs: ran.length ? ran[Math.floor(ran.length / 2)] : 0,
  };
}

/** Human-readable report. The stage histogram is the point; read that first. */
export function formatSummary(s: Summary, results: readonly CaseResult[]): string {
  const out: string[] = [];
  out.push(`${s.correct}/${s.total} correct   (median pass ${s.medianMs}ms)`);
  out.push(
    `  surfaced right: ${s.hits}   missed: ${s.misses}   ` +
      `false positives: ${s.falsePositives}   wrong note: ${s.wrongNotes}`,
  );
  if (s.misses > 0) {
    out.push("");
    out.push("  where the misses died:");
    for (const [stage, n] of Object.entries(s.missStages).sort((a, b) => b[1] - a[1])) {
      out.push(`    ${String(n).padStart(3)}  ${stage}`);
    }
  }
  out.push("");
  for (const r of results) {
    const mark = r.correct ? "ok  " : "MISS";
    const detail = r.observed.candidate
      ? ` -> ${r.observed.tier}: ${r.observed.candidate}`
      : "";
    out.push(
      `  ${mark} ${r.id.padEnd(20)} ${r.observed.stage.padEnd(20)}` +
        ` score=${String(r.observed.score).padStart(3)}${r.observed.walked ? " +walk" : ""}${detail}`,
    );
  }
  return out.join("\n");
}
