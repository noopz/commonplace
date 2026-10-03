/**
 * The one tokenizer (plan §3.8). Sandbox-safe: no Node, no `$`.
 *
 * Every lexical consumer — the ambient pass (`hooks/lib/seed.ts`), the Connect
 * lexical scorer (`scripts/lib/lexical.ts`) and the seed key-term extractor
 * (`scripts/lib/seed.ts`) — tokenizes through this file, so a stopword added
 * here is a stopword everywhere. Three private lists that drifted apart were
 * the reason this exists.
 *
 * GENERIC is NOT applied by `tokenize`: generic words are real content in a
 * note's text and only become noise as query-time evidence of a connection.
 * Callers filter with `isGeneric` where that judgment is made.
 */

/** Function words with no content signal. Union of the three former lists. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // from hooks/lib/seed.ts
  "the", "and", "for", "that", "this", "with", "from", "have", "has", "had",
  "was", "were", "been", "being", "are", "is", "not", "but", "you", "your",
  "its", "it's", "they", "them", "their", "there", "then", "than", "when",
  "what", "which", "who", "whom", "how", "why", "where", "into", "onto", "over",
  "under", "about", "after", "before", "between", "through", "during", "would",
  "could", "should", "will", "can", "may", "might", "must", "shall", "does",
  "did", "doing", "done", "each", "every", "some", "any", "all", "both", "few",
  "more", "most", "other", "such", "only", "own", "same", "also", "just", "one",
  "two", "three", "here", "very", "much", "many", "well", "back", "even",
  "still", "way", "make", "made", "get", "got", "use", "used", "using", "like",
  // from scripts/lib/lexical.ts
  "a", "an", "or", "of", "to", "in", "on", "do", "my", "me", "it", "new", "via",
  "without", "across", "within", "at", "by", "be", "these", "those",
  "note", "notes", "vault",
  // from scripts/lib/seed.ts
  "we", "i", "he", "she", "his", "her", "our", "say", "says", "said",
]);

/**
 * Words too generic to count as evidence of a connection at query time. A
 * candidate whose every matched term is generic is not worth a model call.
 */
export const GENERIC: ReadonlySet<string> = new Set([
  "agent", "agents", "model", "models", "system", "systems", "data", "code",
  "tool", "tools", "note", "notes", "vault", "file", "files", "text", "user",
  "work", "thing", "things", "part", "case", "type", "kind", "line", "lines",
  "context", "content", "value", "values", "result", "results", "problem",
  "approach", "method", "methods", "process", "state", "level", "point",
  "example", "question", "answer", "output", "input", "change", "changes",
  "version", "project", "design", "build", "test", "tests", "prompt", "prompts",
]);

export const DEFAULT_MIN_LENGTH = 3;

export interface TokenizeOptions {
  /**
   * Minimum token length. Default 3 (§3.8). A caller whose thresholds were
   * calibrated against a stricter tokenizer passes its old value until an eval
   * gate re-pins it — the ambient pass keeps 4 for that reason.
   */
  minLength?: number;
}

/**
 * Lowercased `[a-z0-9][a-z0-9-]*` tokens of at least `minLength` characters,
 * minus stopwords, in order of appearance (duplicates kept — callers that want
 * a set build one). Trailing hyphens are trimmed so `well-- known` yields
 * `well`, not `well-`; inner hyphens are kept, so `multi-agent` is one token.
 */
export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
  const min = opts.minLength ?? DEFAULT_MIN_LENGTH;
  const out: string[] = [];
  for (const raw of String(text ?? "").toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []) {
    const w = raw.replace(/-+$/, "");
    if (w.length < min || STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}

export function isGeneric(word: string): boolean {
  return GENERIC.has(word.toLowerCase());
}
