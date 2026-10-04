/**
 * `cues:` generation, after Doc2Query-- (Gospodinov et al. 2023): a cheap
 * model writes the phrasings a reader would search for a note by, and a
 * filter throws away the ones that do not earn their place. Doc2Query-- filters
 * with a relevance model; here the filter is retrieval itself — a cue is kept
 * only if, with every note's cues indexed, it ranks its own note in the top
 * KEEP_TOP. A generic cue ("AI agents") is matched by many notes and fails; a
 * cue the title already says adds no key and is dropped as redundant.
 *
 * Pure: the CLI (scripts/cues.ts) does the reads, the model calls and writes.
 */

import { wordKeys, TERMS } from "../../hooks/lib/index/postings.js";

export const KEEP_TOP = 3;
export const BATCH = 10;
const BODY_CHARS = 1500;

export type CueNote = { key: string; title: string; abstraction: string; body: string };

export const CUES_SYSTEM =
  "You write search queries for a personal knowledge base. You reply with one JSON object and nothing else.";

export function cuesPrompt(notes: readonly CueNote[]): string {
  const blocks = notes.map(
    (n) =>
      `### ${n.key}\nTitle: ${n.title}\n${n.abstraction ? `Summary: ${n.abstraction}\n` : ""}Text: ${n.body.replace(/\s+/g, " ").slice(0, BODY_CHARS)}`,
  );
  return [
    "For each note below, write 5 search queries that a person who read it months ago, and now only half-remembers it, would type to find it again.",
    "- Use DIFFERENT words from the title: the problem it addresses, the situation where it would be needed, plain-language paraphrases, synonyms, the field's other names for the idea.",
    "- 2 to 7 words each, lowercase, no quotes, no punctuation.",
    "- Specific to THIS note: a query that would fit most notes in a knowledge base is useless.",
    "- Never mention the names of other notes.",
    `Reply with JSON only: {"${notes[0]?.key ?? "N1"}": ["query", ...], ...} with one key per note.`,
    "",
    ...blocks,
  ].join("\n");
}

/** The model's reply → cues per key. Tolerates prose or a code fence around the object. */
export function parseCues(reply: string, keys: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const a = reply.indexOf("{");
  const b = reply.lastIndexOf("}");
  if (a < 0 || b <= a) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(reply.slice(a, b + 1));
  } catch {
    return out;
  }
  if (!obj || typeof obj !== "object") return out;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (!Array.isArray(v)) continue;
    const cues = [
      ...new Set(
        v
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.toLowerCase().replace(/["'`]/g, "").replace(/\s+/g, " ").trim())
          .filter((x) => x.length >= 3 && x.length <= 80),
      ),
    ];
    if (cues.length) out.set(k, cues.slice(0, 8));
  }
  return out;
}

/** A cue every one of whose keys the title or an alias already carries adds nothing. */
export function redundant(cue: string, title: string, aliases: readonly string[]): boolean {
  const have = new Set([title, ...aliases].flatMap((s) => wordKeys(s, TERMS)));
  const keys = wordKeys(cue, TERMS);
  return keys.length === 0 || keys.every((k) => have.has(k));
}

/**
 * Split generated cues into kept and dropped. `rank(cue)` returns the ids of
 * the top hits for the cue with ALL generated cues indexed.
 */
export function filterCues(
  id: number,
  cues: readonly string[],
  title: string,
  aliases: readonly string[],
  rank: (cue: string) => number[],
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const c of cues) {
    if (!redundant(c, title, aliases) && rank(c).slice(0, KEEP_TOP).includes(id)) kept.push(c);
    else dropped.push(c);
  }
  return { kept, dropped };
}

/** `cues: ['…', …]` as the last frontmatter line, every other byte preserved; null without closed frontmatter. */
export function insertFrontmatterCues(raw: string, cues: readonly string[]): string | null {
  if (!raw.startsWith("---\n") || cues.length === 0) return null;
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const list = cues.map((c) => `'${c.replace(/'/g, "''")}'`).join(", ");
  return raw.slice(0, end) + `\ncues: [${list}]` + raw.slice(end);
}
