/**
 * Lexical seeding and verdict parsing for ambient connection surfacing.
 *
 * Pure — no `$`, so the static scanner is satisfied and every decision that
 * gates a model call stays unit-testable. The tiering mirrors
 * `commonplace seed`: abstraction, cue anchors (tags + mocs + anchors), then
 * names/titles.
 */

import { tokenize as coreTokenize, GENERIC } from "./core/text.js";

/** Lexical score a candidate must clear before it costs a model call. */
export const MIN_SEED_SCORE = 6;

/**
 * Terms too generic to constitute evidence of a connection, and the stopword
 * list, both live in `core/text.ts` — one tokenizer for every lexical caller
 * (plan §3.8). A candidate whose every matched term is generic is dropped
 * before it costs anything — the "skip generic terms like 'AI' or 'model'"
 * rule that cross-domain linking already applies, enforced earlier and free.
 */

/**
 * Minimum token length for the ambient pass. The shared tokenizer defaults to
 * 3; MIN_SEED_SCORE was calibrated against 4-character tokens, so this caller
 * keeps 4 until eval:connection re-pins both together.
 */
export const SEED_MIN_TOKEN_LENGTH = 4;

// ---------------------------------------------------------------------------
// Pure helpers — no `$`, so the scanner is satisfied and these stay testable.
// ---------------------------------------------------------------------------

/** Lowercased significant word tokens (shared tokenizer, length >= 4), as a set. */
export function tokenize(text: string): Set<string> {
  return new Set(coreTokenize(text, { minLength: SEED_MIN_TOKEN_LENGTH }));
}

/** Parse a .wiki/*.jsonl index. Malformed lines are skipped, never thrown. */
export function parseJsonl(content: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of String(content).split("\n")) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* a partial write mid-index; skip the line, keep the index usable */
    }
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): string[] {
  const hits: string[] = [];
  for (const t of b) if (a.has(t)) hits.push(t);
  return hits;
}

/**
 * Tiered lexical score for one index record against the turn's tokens, in the
 * same key-space order `commonplace seed` uses: abstraction, then cue anchors,
 * then the name/title itself. A title match is the strongest single signal, so
 * it weighs most; abstraction next, because it is the note's own summary of
 * what it is about; anchors last, being the loosest association.
 *
 * Returns the score and the matched terms so the caller can drop candidates
 * whose entire match is generic vocabulary.
 */
export function scoreRecord(
  rec: Record<string, unknown>,
  tokens: Set<string>,
): { score: number; matched: string[]; label: string; path: string } {
  const label = String(rec.title ?? rec.name ?? "");
  const path = String(rec.path ?? "");
  if (!label || !path) return { score: 0, matched: [], label, path };

  // Generic terms are excluded from the SCORE, not merely from the
  // all-generic veto below. Counting them lets a title like "Claude Code"
  // clear the threshold on tokens that appear in nearly every answer of a
  // Claude Code session, so the veto never gets a chance to fire.
  const substantive = (hits: string[]) => hits.filter((t) => !GENERIC.has(t));

  const nameHits = substantive(overlap(tokens, tokenize(label)));
  const absHits = substantive(overlap(tokens, tokenize(String(rec.abstraction ?? ""))));
  // Tier B is cue anchors — the same key space `commonplace seed` uses, which
  // is tags + MOC names + anchors, not anchors alone.
  const cues = [
    ...(Array.isArray(rec.anchors) ? rec.anchors : []),
    ...(Array.isArray(rec.tags) ? rec.tags : []),
    ...(Array.isArray(rec.mocs) ? rec.mocs : []),
  ].join(" ");
  const anchorHits = substantive(overlap(tokens, tokenize(cues)));

  const matched = Array.from(new Set([...nameHits, ...absHits, ...anchorHits]));
  const score = nameHits.length * 4 + absHits.length * 3 + anchorHits.length * 1;

  return { score, matched, label, path };
}

/**
 * Notes that must never be surfaced as a live connection, whatever they score.
 *
 * - `scope: "private"` — a private-domain note has no business appearing
 *   unbidden in a session that may be a screen-share or a public repo.
 * - `retired` — surfacing a superseded entity as current is precisely the
 *   failure `commonplace supersede` exists to prevent.
 * - `isStub` — a stub has no content to justify a judge call.
 */
export function isSurfaceable(rec: Record<string, unknown>): boolean {
  if (rec.isStub === true) return false;
  if (rec.scope === "private") return false;
  const tags = Array.isArray(rec.tags) ? rec.tags.map(String) : [];
  if (tags.includes("retired")) return false;
  return true;
}

/** True when every matched term is generic — evidence too weak to act on. */
export function allGeneric(matched: string[]): boolean {
  return matched.length === 0 || matched.every((t) => GENERIC.has(t));
}

/**
 * Rank index records against the turn's tokens and return the best few.
 * Ties break toward the more authoritative note (HITS authority is already in
 * the index), so a hub-like MOC does not crowd out a substantive note.
 */
export function rankCandidates(
  records: Record<string, unknown>[],
  tokens: Set<string>,
  limit: number,
): { score: number; matched: string[]; label: string; path: string }[] {
  const scored = [];
  for (const rec of records) {
    if (!isSurfaceable(rec)) continue;
    const s = scoreRecord(rec, tokens);
    if (s.score < MIN_SEED_SCORE) continue;
    if (allGeneric(s.matched)) continue;
    scored.push({ ...s, authority: Number(rec.authority ?? 0) });
  }
  scored.sort((a, b) => b.score - a.score || b.authority - a.authority);
  return scored.slice(0, limit);
}

/** Strip frontmatter so the judge model reads prose, not YAML. */
export function stripFrontmatter(text: string): string {
  const t = String(text);
  if (!t.startsWith("---")) return t;
  const end = t.indexOf("\n---", 3);
  return end === -1 ? t : t.slice(end + 4);
}

/**
 * The judge's verdict is one line: either SKIP, or a sentence naming the
 * connection. Anything else (a refusal, a preamble, an empty string) is treated
 * as SKIP — surfacing nothing is always the safe failure.
 *
 * Haiku often answers yes before the sentence it was asked for: `YES. The
 * note…` on one line, or `YES` alone with the sentence a paragraph below. The
 * second shape read as a SKIP (a 3-char line) and silently dropped half of the
 * notes the prime judge had accepted; both now yield the sentence alone.
 */
const BARE_YES = /^[*_\s]*yes[*_\s]*[.!:—–-]*[*_\s]*$/i;
const YES_LEAD = /^[*_\s]*yes[*_]*\s*[.!:,—–-]+\s*/i;

export function parseVerdict(reply: string): string | null {
  const lines = String(reply ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let line = lines[0] ?? "";
  if (!line) return null;
  if (/^skip\b/i.test(line)) return null;
  line = BARE_YES.test(line) ? (lines[1] ?? "") : line.replace(YES_LEAD, "");
  if (!line || /^skip\b/i.test(line)) return null;
  // The model is told to answer SKIP, but a plain-English refusal is at least
  // as likely — and rendering "⟡ vault · [[X]] — No connection here." under an
  // answer is worse than saying nothing. Treat any negative opener as a skip.
  if (/^(no\b|none\b|not\b|there('s| is) no\b|nothing\b|n\/a\b)/i.test(line)) {
    return null;
  }
  if (line.length < 12 || line.length > 300) return null;
  return line;
}

/** The rendered line. Deliberately one line and visually quiet. */
export function renderConnection(label: string, verdict: string): string {
  return `⟡ vault · [[${label}]] — ${verdict}`;
}

