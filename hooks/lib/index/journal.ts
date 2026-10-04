/**
 * Journal lines (plan §3.9 step 9): one per patched file, appended by any
 * session with `tee -a`, replayed by every reader with `seq > journalSeq`.
 *
 * A line carries the note's PARSED facts — keys, not resolved ids — so each
 * session re-resolves it against the names IT can see: the same line serves a
 * session with a private shard open and one with everything sealed. A line
 * for a note in a private shard is written only to
 * `sealed/<shard>/journal.jsonl`, never to the public journal.
 *
 * Sandbox-safe.
 */

import type { ParsedNote, NoteKind, LinkKind } from "./parse.js";

export type JournalLink = { t: string; k: LinkKind; d?: string };

export type JournalNote = {
  title: string;
  aliases: string[];
  kind: NoteKind;
  tags: string[];
  abstraction: string;
  af?: 1;
  cues?: string[];
  created?: string;
  published?: string;
  headings: string[];
  links: JournalLink[];
  stub: boolean;
  scope?: string;
};

export type JournalLine =
  | { v: 2; op: "compacted"; version: number }
  | { v: 2; op: "upsert"; seq: string; at: number; rel: string; mt: number; sz: number; note: JournalNote }
  | { v: 2; op: "delete"; seq: string; at: number; rel: string };

const MAX_LINKS = 400;
const MAX_HEADINGS = 24;

export function journalNote(p: ParsedNote, stub: boolean): JournalNote {
  const links: JournalLink[] = [];
  for (const l of p.links) {
    if (links.length >= MAX_LINKS) break;
    links.push({ t: l.target, k: l.kind, ...(l.display ? { d: l.display } : {}) });
  }
  const scope = typeof p.fm.scope === "string" ? p.fm.scope : undefined;
  return {
    title: p.title,
    aliases: p.aliases,
    kind: p.kind,
    tags: p.tags.slice(0, 16),
    abstraction: p.abstraction,
    ...(p.abstractionFallback ? { af: 1 as const } : {}),
    ...(p.cues ? { cues: p.cues } : {}),
    ...(p.created ? { created: p.created } : {}),
    ...(p.published ? { published: p.published } : {}),
    headings: p.headings.slice(0, MAX_HEADINGS),
    links,
    stub,
    ...(scope ? { scope } : {}),
  };
}

export function parseJournal(text: string): JournalLine[] {
  const out: JournalLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as JournalLine;
      if (j && j.v === 2 && (j.op === "upsert" || j.op === "delete" || j.op === "compacted")) out.push(j);
    } catch {
      // a torn or foreign line is skipped, never fatal
    }
  }
  return out;
}

/** Lines that apply on top of the artefacts at `version`: after the last matching compaction marker. */
export function pendingLines(lines: readonly JournalLine[], version: number): JournalLine[] {
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.op === "compacted" && l.version === version) start = i + 1;
  }
  return lines.slice(start).filter((l) => l.op !== "compacted");
}

/** Compaction is due once the journal is this large (§3.9 step 10). */
export const COMPACT_BYTES = 256 * 1024;
export const COMPACT_LINES = 500;
