/**
 * Deterministic wikilink insertion. Given a note's raw text and a set of
 * link targets, find the first safe occurrence of each target name in the
 * body and wrap it in `[[ ]]`. Frontmatter, code blocks, headings, existing
 * wikilinks, and markdown link spans are off-limits.
 *
 * This replaces the wiki-concept-linker agent's Edit path. The agent's
 * naive substring replacements corrupted text mid-word, mid-URL, and
 * mid-frontmatter (commits e84b9a5 reverted in 3c6bce4, then reproduced
 * again on 2026-04-25). Pure-function design here means no LLM ever
 * touches the Edit; the failure mode is structurally impossible.
 */

import type { DomainRegistry } from "./types.js";

export interface LinkTarget {
  name: string;
  domain?: string | null;
  type: "concept" | "source" | "moc";
}

export interface PlannedEdit {
  name: string;
  matched: string;
  start: number;
  end: number;
}

export interface LinkResult {
  /** New full file content, or null if nothing changed */
  newContent: string | null;
  /** Edits planned and applied (in original-body coordinates) */
  edits: PlannedEdit[];
  /** Targets considered but skipped, with reason */
  skipped: Array<{ name: string; reason: "self-link" | "scope" | "no-match" | "all-linked" }>;
}

/** Plan and apply edits in one shot. Pure function. */
export function linkNoteContent(
  raw: string,
  targets: LinkTarget[],
  noteTitle: string,
  noteDomain: string | null,
  registry: DomainRegistry,
): LinkResult {
  const fmEnd = findFrontmatterEnd(raw);
  const frontmatter = raw.slice(0, fmEnd);
  const body = raw.slice(fmEnd);
  const mask = buildLinkableMask(body);

  // Sort longest-first so "Reinforcement Learning" claims its span before
  // "Learning" can grab a substring of it.
  const sorted = [...targets].sort((a, b) => b.name.length - a.name.length);

  const edits: PlannedEdit[] = [];
  const skipped: LinkResult["skipped"] = [];
  const noteTitleLower = noteTitle.toLowerCase();

  for (const t of sorted) {
    if (t.name.toLowerCase() === noteTitleLower) {
      skipped.push({ name: t.name, reason: "self-link" });
      continue;
    }
    if (!canLink(noteDomain, t.domain ?? null, t.type, registry)) {
      skipped.push({ name: t.name, reason: "scope" });
      continue;
    }
    const m = findFirstLinkable(body, mask, t.name);
    if (!m) {
      skipped.push({ name: t.name, reason: "no-match" });
      continue;
    }
    edits.push({ name: t.name, matched: body.slice(m.start, m.end), start: m.start, end: m.end });
    // Block this span so subsequent (shorter) names can't overlap.
    for (let i = m.start; i < m.end; i++) mask[i] = false;
  }

  if (edits.length === 0) return { newContent: null, edits, skipped };

  // Apply in reverse so positions in `body` remain valid.
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let newBody = body;
  for (const e of ordered) {
    const replacement = e.matched === e.name ? `[[${e.name}]]` : `[[${e.name}|${e.matched}]]`;
    newBody = newBody.slice(0, e.start) + replacement + newBody.slice(e.end);
  }

  return { newContent: frontmatter + newBody, edits, skipped };
}

/**
 * Return the byte offset where the body begins (after the closing `---\n`),
 * or 0 if the file has no frontmatter.
 */
export function findFrontmatterEnd(raw: string): number {
  if (!raw.startsWith("---\n")) return 0;
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return 0;
  return end + 5; // past the closing "\n---\n"
}

/**
 * Build a per-character "is this position safe to wrap in a wikilink"
 * mask over the body. Marks the following spans as non-linkable:
 * - Inside fenced code blocks (``` ... ```)
 * - Inside inline code (`...`)
 * - Inside existing wikilinks ([[...]])
 * - Inside markdown link spans ([text](url))
 * - Heading lines (start with #)
 */
export function buildLinkableMask(body: string): boolean[] {
  const mask = new Array(body.length).fill(true);
  let i = 0;
  let inFence = false;

  while (i < body.length) {
    const atLineStart = i === 0 || body[i - 1] === "\n";

    if (atLineStart) {
      // Fenced code block toggle
      if (body.startsWith("```", i)) {
        const eol = body.indexOf("\n", i);
        const lineEnd = eol === -1 ? body.length : eol;
        for (let j = i; j < lineEnd; j++) mask[j] = false;
        inFence = !inFence;
        i = lineEnd;
        continue;
      }
      // Heading line
      if (body[i] === "#") {
        const eol = body.indexOf("\n", i);
        const lineEnd = eol === -1 ? body.length : eol;
        for (let j = i; j < lineEnd; j++) mask[j] = false;
        i = lineEnd;
        continue;
      }
    }

    if (inFence) {
      mask[i] = false;
      i++;
      continue;
    }

    const ch = body[i];

    // Inline code: span to next backtick on same line
    if (ch === "`") {
      const nl = body.indexOf("\n", i + 1);
      const close = body.indexOf("`", i + 1);
      if (close > 0 && (nl === -1 || close < nl)) {
        for (let j = i; j <= close; j++) mask[j] = false;
        i = close + 1;
        continue;
      }
    }

    // Wikilink: [[ ... ]]
    if (ch === "[" && body[i + 1] === "[") {
      const close = body.indexOf("]]", i + 2);
      if (close > 0) {
        for (let j = i; j < close + 2; j++) mask[j] = false;
        i = close + 2;
        continue;
      }
    }

    // Markdown link: [text](url)
    if (ch === "[" && body[i + 1] !== "[") {
      const closeBracket = body.indexOf("]", i + 1);
      if (closeBracket > 0 && body[closeBracket + 1] === "(") {
        const closeParen = body.indexOf(")", closeBracket + 2);
        if (closeParen > 0) {
          for (let j = i; j < closeParen + 1; j++) mask[j] = false;
          i = closeParen + 1;
          continue;
        }
      }
    }

    i++;
  }

  return mask;
}

/**
 * Find the first `\b{name}\b`-style match (case-insensitive) where every
 * character of the match is linkable per `mask`. Word-boundary uses a
 * lookbehind/lookahead that excludes word chars and hyphens — handles
 * names with internal punctuation like "Claude Opus 4.7".
 */
export function findFirstLinkable(
  body: string,
  mask: boolean[],
  name: string,
): { start: number; end: number } | null {
  const re = new RegExp(`(?<![\\w-])${escapeRegex(name)}(?![\\w-])`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    let ok = true;
    for (let i = start; i < end; i++) {
      if (!mask[i]) { ok = false; break; }
    }
    if (ok) return { start, end };
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Public/private scope check for source-note and MOC targets. Concepts
 * are global — they have no single domain — so they're always linkable.
 *
 * Rules (matches the wiki-concept-linker agent's prior policy):
 * - Public source linking to a private target: no
 * - Private source linking to public: yes
 * - Same domain or same linkGroup: yes
 */
function canLink(
  srcDomain: string | null,
  tgtDomain: string | null,
  tgtType: LinkTarget["type"],
  registry: DomainRegistry,
): boolean {
  if (tgtType === "concept") return true;
  if (!tgtDomain) return true;
  const tgt = registry.domains[tgtDomain];
  if (!tgt || tgt.scope !== "private") return true;
  if (srcDomain === tgtDomain) return true;
  const srcGroup = srcDomain ? registry.domains[srcDomain]?.linkGroup : undefined;
  const tgtGroup = tgt.linkGroup;
  if (srcGroup && tgtGroup && srcGroup === tgtGroup) return true;
  return false;
}
