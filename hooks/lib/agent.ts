/**
 * Steering for Agent dispatches that are really vault research.
 *
 * WHY THIS REPLACES A DENY
 * `scripts/agent-guard.ts` catches the same failure — a general-purpose Agent
 * sent off to re-implement wiki-query's iterative search — by DENYING the
 * dispatch after the model has already composed the prompt. Two problems with
 * that: a regex had to carry the whole decision, and because it cannot tell
 * research from orchestrated work (both talk about `[[wikilinks]]` and source
 * notes) it needed the `ALLOW_VAULT_AGENT` escape hatch to stay usable.
 *
 * `agent.spawn` fires before the subagent resolves and may rewrite `prompt`,
 * so the better move is to equip the dispatch rather than refuse it. That only
 * became possible once `vault_search`/`vault_note` were real registered tools
 * a subagent can call — before v1.58.0 they were registered but every call
 * failed, so there was nothing to point an agent at and denying was all we had.
 *
 * TWO GATES, DIFFERENT JOBS — this is the part worth keeping straight:
 *
 *   `looksVaultShaped` is a COST gate, not a decision. Its only job is to keep
 *   a model call off the critical path of Agent dispatches that obviously have
 *   nothing to do with the vault. A false positive here costs ~700ms and
 *   nothing else, so it can afford to be loose — unlike the old regex, which
 *   was the decision and therefore had to be precise enough to never block
 *   real work.
 *
 *   The classify makes the actual judgement.
 *
 * Pure — no `$`, no I/O. `hooks/register.ts` performs the classify.
 */

/**
 * Labels for the dispatch classify.
 *
 * `vault-work` is deliberately its own label rather than folded into
 * "unrelated": orchestrated work over many notes (compiling stubs, fixing
 * lint, editing in parallel) is a legitimate pattern whose prompts are dense
 * with exactly the vocabulary research uses. Naming it explicitly is what lets
 * the guard tell the two apart, which the regex never could.
 */
export const SPAWN_LABELS = [
  "vault-research",
  "vault-work",
  "unrelated",
] as const;

/** The classify question. Kept beside the labels it has to agree with. */
export const SPAWN_CLASSIFY_PROMPT = (prompt: string): string =>
  "A subagent is about to be dispatched with the task below. Classify it.\n\n" +
  "vault-research — the task is to FIND OUT something from the user's " +
  "personal notes/knowledge vault: searching it, tracing connections between " +
  "notes, or answering a question whose answer lives in them.\n" +
  "vault-work — the task OPERATES on vault notes mechanically: editing, " +
  "fixing, linting, compiling, reindexing, or writing many of them.\n" +
  "unrelated — anything else, including ordinary software work on a codebase " +
  "that merely happens to mention notes, wikis, or a vault.\n\n" +
  `TASK:\n${prompt.slice(0, 1200)}`;

/**
 * Markers that a prompt might concern the vault at all.
 *
 * Precision matters far less here than in the old guard (see the header): this
 * only decides whether to spend a classify. Still narrow enough that ordinary
 * dev work does not pay for it on every dispatch — bare "vault" is excluded
 * because HashiCorp Vault exists, and bash `[[ -f x ]]` is excluded by the
 * lookahead, which real wikilinks never trip.
 */
export const VAULT_MARKERS: readonly RegExp[] = [
  /\bwiki-(query|ingest|domain|compile|lint|supersede|deep-link)\b/i,
  /\bcommonplace\s+(query|ingest|index|lint|seed|connect|score|prune|supersede|abstract)\b/i,
  /\bobsidian\b/i,
  /\b(concept|source|MOC)\s+notes?\b/i,
  /\bmy\s+(notes|vault)\b/i,
  /\bknowledge\s+(base|vault)\b/i,
  /\.wiki[\\/]/,
  /\[\[(?!\s)[^\[\]\n]+\]\]/,
];

/**
 * Whether a dispatch is worth spending a classify on.
 *
 * `vaultPath` is matched too, so a prompt that names the vault directory
 * counts even with no other marker.
 */
export function looksVaultShaped(prompt: string, vaultPath: string): boolean {
  const text = String(prompt ?? "");
  if (!text) return false;
  if (VAULT_MARKERS.some((re) => re.test(text))) return true;
  const p = String(vaultPath ?? "").trim();
  if (p && text.toLowerCase().includes(p.toLowerCase())) return true;
  return false;
}

/**
 * Whether this spawn is one we may steer at all.
 *
 * Forks inherit the parent's context and are not research dispatches. A named
 * agent — `commonplace:wiki-linter`, `code-reviewer` — was chosen deliberately
 * and already knows its job; only the generic worker gets redirected.
 */
export function isSteerableSpawn(subagentType: string, fork: boolean): boolean {
  if (fork) return false;
  const t = String(subagentType ?? "").trim();
  return t === "" || t === "general-purpose";
}

/**
 * The instruction prepended to a research dispatch.
 *
 * Deliberately additive and short. It does NOT say "stop and use wiki-query
 * instead" — the dispatch has already been decided, and a subagent told to
 * abandon its task tends to return nothing useful. It says how to do the task
 * properly with the tools that exist, and carries the doctrine that makes the
 * difference between a lexical hit and an actual answer.
 */
export const STEER_PREFIX =
  "This task concerns the user's commonplace vault. Use the `vault_search` " +
  "tool to find candidate notes and `vault_note` to read them — do not grep " +
  "the vault directly, and do not answer from search results alone: " +
  "`vault_search` returns pointers, and a lexical match is not relevance, so " +
  "read the notes before concluding anything. If a question needs iterative " +
  "search and graph traversal rather than a few lookups, say so in your " +
  "report and stop, so the wiki-query skill can be used instead.\n\n---\n\n";

/** Prepend the steer once; a re-dispatch of an already-steered prompt is left alone. */
export function steerPrompt(prompt: string): string {
  const text = String(prompt ?? "");
  return text.startsWith(STEER_PREFIX) ? text : `${STEER_PREFIX}${text}`;
}
