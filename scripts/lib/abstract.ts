/**
 * Deterministic abstraction derivation for the backfill path. Extracts a
 * ~6-12 word noun-phrase-first descriptor from existing note text (the
 * Summary's first sentence for sources; the definition paragraph for
 * concepts). Zero LLM tokens: this is text extraction, not generation —
 * skills write better abstractions at ingest/compile time; this closes
 * the gap for the existing corpus so the field is populated everywhere.
 */

/** Leading framing phrases that push the noun phrase off the front. */
const BOILERPLATE_PREFIXES = [
  "this paper introduces",
  "this paper presents",
  "this paper proposes",
  "this paper describes",
  "this paper studies",
  "this paper shows",
  "the paper introduces",
  "the paper presents",
  "the paper proposes",
  "this article describes",
  "this article presents",
  "this article covers",
  "this note describes",
  "this note covers",
  "the authors introduce",
  "the authors present",
  "the authors propose",
  "an analysis of",
  "a study of",
  "a survey of",
  "an overview of",
];

/** Strip wikilink/markdown syntax so only display text remains. */
export function cleanForAbstraction(text: string): string {
  let t = text
    .replace(/\[\[([^\[\]|]+)\|([^\[\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\[\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "");
  return t.replace(/\s+/g, " ").trim();
}

export function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : text).trim();
}

/**
 * Derive an abstraction from a paragraph: first sentence, boilerplate
 * prefix stripped, capped at 12 words, trailing punctuation trimmed.
 * Returns null when the result carries fewer than 3 content words —
 * better no abstraction (lint flags it) than a meaningless one.
 */
export function deriveAbstraction(paragraph: string): string | null {
  let s = firstSentence(cleanForAbstraction(paragraph));
  const lower = s.toLowerCase();
  for (const p of BOILERPLATE_PREFIXES) {
    if (lower.startsWith(p)) {
      s = s.slice(p.length).trim();
      break;
    }
  }
  s = s.replace(/^[,:;\s]+/, "");
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 12) s = words.slice(0, 12).join(" ");
  s = s.replace(/[.,;:\s]+$/, "");
  const contentWords = s.split(/\s+/).filter((w) => w.replace(/[^\w-]/g, "").length >= 3);
  if (contentWords.length < 3) return null;
  return s;
}

/** First non-empty paragraph of the `## Summary` section, or null. */
export function extractSummaryParagraph(body: string): string | null {
  const m = body.match(/^##\s+Summary\s*\n([\s\S]*?)(?=\n##\s|$)/m);
  if (!m) return null;
  const para = m[1]
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  return para ?? null;
}

/**
 * First non-empty, non-heading paragraph that isn't the stub sentinel —
 * the definition paragraph of a compiled concept note.
 */
export function extractConceptDefinition(body: string): string | null {
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const p of paras) {
    if (p.startsWith("#")) continue;
    if (p.includes("Definition pending")) continue;
    return p;
  }
  return null;
}

/**
 * True when `raw` opens with a closed `---` frontmatter block. A file that
 * fails this is not a managed note (e.g. a raw scrape dump) — there is no
 * frontmatter to insert an abstraction into.
 */
export function hasClosedFrontmatter(raw: string): boolean {
  return raw.startsWith("---\n") && raw.indexOf("\n---\n", 4) >= 0;
}

/**
 * Insert `abstraction: '...'` as the last frontmatter line, preserving
 * every other byte of the file. Returns null if the file has no closed
 * frontmatter block (caller skips it — we never create frontmatter).
 */
export function insertFrontmatterAbstraction(raw: string, abstraction: string): string | null {
  if (!hasClosedFrontmatter(raw)) return null;
  const end = raw.indexOf("\n---\n", 4);
  const quoted = `'${abstraction.replace(/'/g, "''")}'`;
  return raw.slice(0, end) + `\nabstraction: ${quoted}` + raw.slice(end);
}
