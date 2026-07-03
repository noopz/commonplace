/**
 * Deterministic seed procedure for retrieval. `mode: "flat"` replicates the
 * wiki-query skill's documented baseline — grep query terms over whole JSONL
 * index records, any-term substring match — as a pure function so the eval
 * harness can measure it and later specs (tiered mixed-key seeding,
 * authority ranking) can extend it behind explicit options. Lexical only,
 * by design: no embeddings, no persistent vector index (CLAUDE.md "No RAG").
 */

import type { SourceNote, ConceptNote, MocNote } from "./types.js";

export interface SeedHit {
  /** Path as it appears on the index record (absolute if loadIndexes resolved it) */
  path: string;
  /** Human label: source title / concept name / MOC name */
  label: string;
  kind: "source" | "concept" | "moc";
  matchedTerms: string[];
}

export interface SeedIndexes {
  sources: SourceNote[];
  concepts: ConceptNote[];
  mocs: MocNote[];
}

export interface SeedOptions {
  mode: "flat";
}

/** Query-function words that carry no content signal. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "not", "of", "in", "on", "at", "by",
  "for", "to", "with", "from", "into", "over", "under", "about", "between",
  "across", "through", "how", "what", "which", "where", "when", "who", "why",
  "does", "do", "did", "is", "are", "was", "were", "be", "been", "it", "its",
  "this", "that", "these", "those", "there", "their", "they", "them", "than",
  "then", "also", "just", "only", "some", "any", "all", "each", "such",
  "can", "could", "should", "would", "will", "may", "might", "must",
  "have", "has", "had", "we", "you", "i", "he", "she", "his", "her", "our",
  "your", "my", "say", "says", "said", "note", "notes", "vault",
]);

/**
 * Extract deterministic key terms from a question: quoted phrases,
 * capitalized multi-word runs (proper-noun phrases), and individual
 * non-stopword words of 3+ characters. All lowercased, deduped, in
 * first-appearance order.
 */
export function extractKeyTerms(question: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const k = t.toLowerCase().trim();
    if (k.length >= 3 && !seen.has(k)) {
      seen.add(k);
      terms.push(k);
    }
  };

  for (const m of question.matchAll(/"([^"]+)"/g)) push(m[1]);
  for (const m of question.matchAll(/\b[A-Z][\w-]*(?:\s+[A-Z][\w-]*)+\b/g)) push(m[0]);
  for (const w of question.toLowerCase().replace(/[^\w\s-]/g, " ").split(/\s+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) push(w);
  }
  return terms;
}

/**
 * Flat-mode seeding: a record is a candidate if ANY term appears
 * case-insensitively anywhere in its JSON-serialized form — the pure-function
 * equivalent of `Grep "<term>" .wiki/*-index.jsonl` unioned over terms.
 */
export function seedCandidates(
  terms: string[],
  indexes: SeedIndexes,
  opts: SeedOptions = { mode: "flat" },
): SeedHit[] {
  if (opts.mode !== "flat") {
    throw new Error(`unknown seed mode: ${String(opts.mode)} (valid: flat)`);
  }
  const lowered = terms.map((t) => t.toLowerCase());
  const hits: SeedHit[] = [];
  const scan = (record: unknown, path: string, label: string, kind: SeedHit["kind"]) => {
    const blob = JSON.stringify(record).toLowerCase();
    const matchedTerms = lowered.filter((t) => blob.includes(t));
    if (matchedTerms.length > 0) hits.push({ path, label, kind, matchedTerms });
  };
  for (const s of indexes.sources) scan(s, s.path, s.title, "source");
  for (const c of indexes.concepts) scan(c, c.path, c.name, "concept");
  for (const m of indexes.mocs) scan(m, m.path, m.name, "moc");
  return hits;
}
