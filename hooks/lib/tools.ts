/**
 * Vault operations exposed to the model as real tools.
 *
 * WHY THIS EXISTS
 * commonplace's vault operations have always been *skills*, which the model
 * has to be talked into invoking — wiki-ingest's description is literally
 * shouting `ALWAYS use when...` in capitals, which is what a reliability
 * problem looks like when the only lever is prose. `$.tool.register` stands up
 * an in-process MCP server for the plugin, so these become first-class tools in
 * the tool list with real input schemas. Models call tools far more reliably
 * than they invoke skills.
 *
 * DOCTRINE BY CONSTRUCTION (CLAUDE.md, "No RAG — grep finds, reading connects")
 * The two tools are deliberately split so the doctrine is structural rather
 * than advisory: `vault_search` returns POINTERS ONLY — titles, paths, and each
 * note's own one-line abstraction — and never note bodies. To learn what a note
 * says you must call `vault_note` and read it. A caller therefore cannot
 * mistake a lexical match for an answer, because the match never carries the
 * content that would let it pretend to be one.
 *
 * Pure — no `$`, no I/O. `hooks/register.ts` supplies the index records and
 * performs the reads.
 */

import { scoreRecord, tokenize } from "./seed.js";

/**
 * Explicit search is more permissive than ambient surfacing. Ambient has to
 * justify interrupting; a caller who asked deserves the benefit of the doubt,
 * so the bar is a single substantive hit rather than the ambient threshold.
 */
const SEARCH_MIN_SCORE = 3;

export const VAULT_SEARCH_SPEC = {
  name: "vault_search",
  description:
    "Search the user's commonplace knowledge vault for notes related to a " +
    "query. Returns POINTERS ONLY — title, path, domain, and each note's own " +
    "one-line abstraction — never note bodies. These are jumping-off points, " +
    "not an answer: a lexical match is not evidence of relevance. Read the " +
    "notes that look promising with vault_note before drawing any conclusion. " +
    "Use this whenever the user asks something their own notes may cover, or " +
    "before concluding that something they shared is not worth saving.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to look for. Prefer the user's own words and distinctive " +
          "terms; generic vocabulary is filtered out and will match nothing.",
      },
      limit: {
        type: "number",
        description: "Maximum pointers to return (default 8, max 25).",
      },
    },
    required: ["query"],
  },
} as const;

export const VAULT_NOTE_SPEC = {
  name: "vault_note",
  description:
    "Read one note from the user's commonplace vault, by the path or title " +
    "returned by vault_search. This is the step that turns a search hit into " +
    "an actual relevance judgement — do not answer from vault_search results " +
    "alone.",
  inputSchema: {
    type: "object",
    properties: {
      note: {
        type: "string",
        description: "The note's path (preferred) or its exact title.",
      },
    },
    required: ["note"],
  },
} as const;

/** One pointer returned by `vault_search`. Deliberately carries no body. */
export type SearchHit = {
  title: string;
  path: string;
  domain: string;
  abstraction: string;
  matched: string[];
  /** Set when the note needs handling with care; absent when it does not. */
  caution?: string;
};

/**
 * Rank index records against an explicit query.
 *
 * Unlike the ambient path this does NOT hide private or retired notes. The
 * ambient path suppresses them because it displays unbidden; here the user
 * asked, and it is their own vault. They are flagged instead, so a caller
 * knows a note is private (do not copy it into a public artefact) or retired
 * (do not present it as current) without being silently denied their own data.
 */
export function searchVault(
  records: Record<string, unknown>[],
  query: string,
  limit = 8,
): SearchHit[] {
  const tokens = tokenize(query);
  if (tokens.size === 0) return [];

  const capped = Math.max(1, Math.min(25, Number(limit) || 8));
  const scored: (SearchHit & { score: number; authority: number })[] = [];

  for (const rec of records) {
    const s = scoreRecord(rec, tokens);
    if (s.score < SEARCH_MIN_SCORE) continue;

    const tags = Array.isArray(rec.tags) ? rec.tags.map(String) : [];
    const caution =
      rec.scope === "private"
        ? "private — the user's own data; never copy into a public repo or artefact"
        : tags.includes("retired")
          ? "retired — do not present as current"
          : rec.isStub === true
            ? "stub — no definition written yet"
            : undefined;

    scored.push({
      title: s.label,
      path: s.path,
      domain: String(rec.domain ?? (Array.isArray(rec.domains) ? rec.domains[0] : "") ?? ""),
      abstraction: String(rec.abstraction ?? ""),
      matched: s.matched,
      ...(caution ? { caution } : {}),
      score: s.score,
      authority: Number(rec.authority ?? 0),
    });
  }

  scored.sort((a, b) => b.score - a.score || b.authority - a.authority);

  return scored.slice(0, capped).map(({ score, authority, ...hit }) => hit);
}

/**
 * The payload `vault_search` answers with.
 *
 * The reminder is not decoration: this tool's whole failure mode is a caller
 * treating pointers as findings, so the answer says so in the answer itself
 * rather than relying on the description having been read.
 */
export function formatSearchResult(
  hits: SearchHit[],
  query: string,
): Record<string, unknown> {
  if (hits.length === 0) {
    return {
      query,
      hits: [],
      note:
        "No notes matched those terms. That is not evidence the vault has " +
        "nothing relevant — matching is lexical, so a note can be highly " +
        "relevant with no shared wording. Try distinctive synonyms, or the " +
        "wiki-query skill, which searches iteratively and traverses the graph.",
    };
  }
  return {
    query,
    hits,
    note:
      "Pointers only — no note bodies. A lexical match is not relevance. " +
      "Read the promising ones with vault_note before concluding anything.",
  };
}

/**
 * Resolve a user-supplied reference to a vault-relative path.
 *
 * Accepts a path outright, otherwise matches a title case-insensitively.
 * Returns null when nothing matches, so the caller can answer with a real
 * error rather than reading an arbitrary file.
 */
export function resolveNotePath(
  records: Record<string, unknown>[],
  ref: string,
): string | null {
  const wanted = String(ref ?? "").trim();
  if (!wanted) return null;

  for (const rec of records) {
    if (String(rec.path ?? "") === wanted) return wanted;
  }

  const lowered = wanted.toLowerCase();
  for (const rec of records) {
    const label = String(rec.title ?? rec.name ?? "");
    if (label && label.toLowerCase() === lowered) return String(rec.path ?? "");
  }

  // Last resort: a path that differs only by a leading "./" or a .md suffix.
  const normalised = lowered.replace(/^\.\//, "").replace(/\.md$/, "");
  for (const rec of records) {
    const p = String(rec.path ?? "").toLowerCase().replace(/\.md$/, "");
    if (p && p === normalised) return String(rec.path ?? "");
  }

  return null;
}

/**
 * Guard a path against escaping the vault before it reaches a Read.
 *
 * The reference comes from the model, so it is untrusted input: without this a
 * crafted `note` argument would turn a vault reader into an arbitrary-file
 * reader.
 */
export function isSafeVaultPath(path: string): boolean {
  const p = String(path ?? "");
  if (!p) return false;
  if (p.startsWith("/") || p.startsWith("~")) return false;
  if (p.includes("..")) return false;
  if (p.includes("\0")) return false;
  return true;
}
