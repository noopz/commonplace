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
 * WHAT THIS TIER COSTS, stated plainly because it is not obvious.
 *
 * `connect` ALWAYS returns k candidates. There is no "no opinion" signal: the
 * score is normalised, so the top candidate scores ~1.25 whether the pool is
 * excellent or nonsense. On an off-topic query it will happily rank a note
 * that shares one incidental word. So on every turn where the free tier misses
 * — turns that used to end for free — this tier now spends a note read and a
 * judge call, and the judge will usually answer SKIP.
 *
 * That is deliberate and it is the doctrine, not a workaround: "grep finds,
 * reading connects". Nothing about a PPR score is a relevance judgement, so
 * there is no threshold to tune here that would not just be lexical gating
 * wearing a graph costume — and lexical gating is exactly what this tier
 * exists to get past. The judge is the authority; the rate limit bounds how
 * often it is asked.
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

/**
 * Merge the two seed tiers into one ordered candidate list.
 *
 * Lexical first: when both tiers agree on a note, the lexical tier's evidence
 * is the stronger of the two (the answer literally discusses it), and the
 * graph tier's job is to ADD reach, not to reorder. Then graph candidates in
 * their own ranked order.
 *
 * `surfaceable` is consulted for BOTH tiers and is fail-closed. `connect`
 * ranks the whole vault with no privacy filter of its own and returns MOC
 * paths that the pass never loads into `records`, so a path this predicate
 * cannot vouch for is dropped rather than surfaced. That is the only thing
 * standing between a private-domain note and an unbidden line on screen.
 */
export function mergeSeeds(
  lexical: { path: string; label: string }[],
  graph: { path: string; label: string }[],
  surfaceable: (path: string) => boolean,
  seen: readonly string[],
  limit: number,
): SeedCandidate[] {
  const out: SeedCandidate[] = [];
  const taken = new Set<string>();
  const push = (c: { path: string; label: string }, tier: SeedCandidate["tier"]) => {
    if (!c.path || taken.has(c.path)) return;
    if (seen.includes(c.path)) return;
    if (!surfaceable(c.path)) return;
    taken.add(c.path);
    out.push({ path: c.path, label: c.label, tier });
  };
  for (const c of lexical) push(c, "lexical");
  for (const c of graph) push(c, "graph");
  return out.slice(0, limit);
}
