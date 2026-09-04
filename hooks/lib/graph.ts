/**
 * Graph seeding for the ambient connection pass.
 *
 * WHY THIS EXISTS
 * The lexical seed in `seed.ts` can only ever reach a note that shares a
 * literal string with the answer. CLAUDE.md's own motivating example is the
 * case it structurally cannot reach: a note bearing on the discussion with
 * zero shared vocabulary. `commonplace connect` ranks by
 * `norm(PPR) + lambda * norm(lexical)` over the content graph, so a note two
 * hops from a lexically-matched neighbour surfaces on graph proximity alone.
 *
 * It is still a SEED, not an answer. The pass reads the note and asks a model
 * before anything reaches the user — the graph changes which notes are worth
 * reading, never whether they are relevant.
 *
 * PURE: no `$`, no I/O. `pipeline.ts` runs the command through its
 * `runCommand` port and hands the stdout here.
 */

/*
 * WHEN THIS TIER RUNS, and why it is not "when the lexical tier finds nothing".
 *
 * It was, for exactly one version, and that made it dead code. On a 637-record
 * vault `rankCandidates` returns its full four candidates for ANY technical
 * answer — measured across five live probes including sourdough fermentation
 * and bicycle derailleurs, none of which the vault contains a word about. A
 * MIN_SEED_SCORE of 6 is simply easy to clear once there are enough records.
 * "Did anything match" is not a signal on a vault of this size.
 *
 * So the gate is the STRENGTH of the lexical evidence (LEX_STRONG_SCORE in the
 * pipeline), and when the walk runs because that evidence was thin, the graph's
 * candidate is preferred over the thin lexical one.
 *
 * That threshold is not the thing CLAUDE.md's "No RAG" section forbids. It
 * decides whether to WIDEN the search, never whether a note is relevant — the
 * failure mode being guarded against is a lexical score standing in for a
 * relevance judgement, and this does the opposite: a weak score buys a second
 * opinion instead of ending the pass.
 *
 * WHAT IT COSTS. `connect` ALWAYS returns k candidates; there is no "no
 * opinion" signal, and the score is normalised so the top one scores ~1.25
 * whether the pool is excellent or nonsense. Every walk therefore ends in a
 * note read and a judge call, and the judge will usually answer SKIP. That is
 * the doctrine working — "grep finds, reading connects". The judge is the
 * authority; the rate limit bounds how often it is asked.
 */

/** How many graph candidates to ask for. Small: only the top one is read. */
export const CONNECT_K = 6;

/** Max query chars sent as argv. Matches the pass's ANSWER_EXCERPT. */
export const CONNECT_QUERY_CHARS = 1500;

/** A candidate in the shape the pass consumes, from either seed tier. */
export type SeedCandidate = {
  path: string;
  label: string;
  /** Which tier produced it — carried into the trace, not shown to the user. */
  tier: "lexical" | "graph";
};

/**
 * argv for the graph seed.
 *
 * Newlines are flattened: the query crosses an argv boundary, and a multi-line
 * argument is legal but makes the trace unreadable when it is echoed back.
 */
export function connectArgv(query: string, k: number = CONNECT_K): string[] {
  const q = String(query ?? "")
    .slice(0, CONNECT_QUERY_CHARS)
    .replace(/\s+/g, " ")
    .trim();
  return ["connect", "--query", q, "--k", String(k), "--json"];
}

/**
 * Parse `commonplace connect --json` stdout into candidates.
 *
 * Returns [] on anything unexpected. A seed tier that throws would take the
 * whole pass down through the circuit breaker, which is far too loud a failure
 * for "the graph had no opinion".
 */
export function parseConnectOutput(
  stdout: string,
): { path: string; label: string; ppr: number; lex: number; score: number }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(stdout ?? ""));
  } catch {
    return [];
  }
  const list = (parsed as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const c = raw as Record<string, unknown>;
    const path = String(c?.path ?? "");
    const label = String(c?.title ?? "");
    if (!path || !label) continue;
    out.push({
      path,
      label,
      ppr: Number(c?.ppr ?? 0),
      lex: Number(c?.lex ?? 0),
      score: Number(c?.score ?? 0),
    });
  }
  return out;
}

/** One tier's ranked output, in the order the caller wants it considered. */
export type SeedTier = {
  tier: SeedCandidate["tier"];
  candidates: readonly { path: string; label: string }[];
};

/**
 * Flatten the seed tiers into one ordered candidate list.
 *
 * ORDER IS THE CALLER'S DECISION and it is not always lexical-first. The graph
 * tier only runs when the lexical evidence was thin (see LEX_STRONG_SCORE in
 * the pipeline), and in exactly that case preferring the thin lexical hit would
 * defeat the point of having walked at all. When the lexical hit is strong the
 * walk never happens, so lexical-first is the only order that arises there.
 *
 * `surfaceable` is consulted for EVERY tier and is fail-closed. `connect` ranks
 * the whole vault with no privacy filter of its own and returns MOC paths that
 * the pass never loads into `records`, so a path this predicate cannot vouch
 * for is dropped rather than surfaced. That is the only thing standing between
 * a private-domain note and an unbidden line on screen.
 */
export function mergeSeeds(
  tiers: readonly SeedTier[],
  surfaceable: (path: string) => boolean,
  seen: readonly string[],
  limit: number,
): SeedCandidate[] {
  const out: SeedCandidate[] = [];
  const taken = new Set<string>();
  for (const { tier, candidates } of tiers) {
    for (const c of candidates) {
      if (!c.path || taken.has(c.path)) continue;
      if (seen.includes(c.path)) continue;
      if (!surfaceable(c.path)) continue;
      taken.add(c.path);
      out.push({ path: c.path, label: c.label, tier });
    }
  }
  return out.slice(0, limit);
}
