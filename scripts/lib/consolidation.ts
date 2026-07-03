/**
 * Consolidation-as-flag: detect when two sources' abstractions describe
 * substantially the same finding. Lexical only (token Jaccard) — cheap,
 * deterministic, zero tokens. The output is a FLAG routed to human/agent
 * judgment (supersede, cross-link, or drop); source notes carry citation
 * identity and provenance and are NEVER auto-merged.
 */

import type { SourceNote } from "./types.js";

// Self-contained stopword set: abstractions are 6-12 word noun phrases, so
// only high-frequency glue words need excluding for Jaccard to be meaningful.
const STOP = new Set([
  "the", "and", "for", "with", "into", "from", "over", "that", "this",
  "are", "its", "their", "across", "between", "without", "under", "via",
  "using", "toward", "towards", "through", "about", "than", "when",
]);

/** Lowercased content tokens (length >= 3, stopwords removed). */
export function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

/** Jaccard similarity of the two abstractions' content-token sets. */
export function abstractionSimilarity(a: string, b: string): number {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export interface ConsolidationCandidate {
  path: string;
  title: string;
  domain: string;
  similarity: number;
}

/**
 * Candidates among `candidates` whose abstraction Jaccard-overlaps the new
 * source's at or above `threshold`, sorted most-similar first. Callers are
 * responsible for scope filtering (canLink) and for excluding the new
 * source itself — this function only skips records without abstractions.
 */
export function findConsolidationCandidates(
  newSource: SourceNote,
  candidates: SourceNote[],
  threshold: number,
): ConsolidationCandidate[] {
  const a = newSource.abstraction?.trim();
  if (!a) return [];
  const out: ConsolidationCandidate[] = [];
  for (const c of candidates) {
    const b = c.abstraction?.trim();
    if (!b || c.path === newSource.path) continue;
    const similarity = abstractionSimilarity(a, b);
    if (similarity >= threshold) {
      out.push({
        path: c.path,
        title: c.title,
        domain: c.domain,
        similarity: Math.round(similarity * 1000) / 1000,
      });
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity);
}
