/**
 * Wikilink resolution helpers — shared by lint, scope-check, indexer, and score.
 *
 * Obsidian wikilinks are case-insensitive, may carry section anchors (`Note#Heading`),
 * may target attachments (.pdf, .png, …), and may resolve through frontmatter aliases.
 * Every consumer that resolves a wikilink to an actual note needs this same logic —
 * skipping any of it produces silent false positives or false negatives.
 */

import { basename } from "path";
import { parseNote } from "./frontmatter.js";

export const ATTACHMENT_EXTS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".flac",
  ".zip", ".csv", ".xlsx", ".docx", ".pptx",
]);

/**
 * Reduce a wikilink target string to its canonical lookup key, or null if
 * the target is something we can't resolve to a note (intra-doc anchor,
 * attachment file, or empty).
 *
 * Returns lowercase so callers can compare case-insensitively, matching
 * Obsidian's resolution behavior.
 */
export function normalizeWikilinkTarget(target: string): string | null {
  const noteName = target.includes("#") ? target.split("#")[0] : target;
  if (!noteName) return null; // bare [[#section]] — internal anchor
  const dotIdx = noteName.lastIndexOf(".");
  if (dotIdx > 0 && ATTACHMENT_EXTS.has(noteName.slice(dotIdx).toLowerCase())) {
    return null; // attachment, never resolves to a note
  }
  return noteName.toLowerCase();
}

/**
 * Build a case-insensitive lookup of every note's filename and aliases →
 * canonical filename (basename without `.md`). The canonical name is the
 * form that indexes record, so `bodyLinks` and `frontmatter.concepts`
 * resolve to a stable identifier regardless of how the user typed the link.
 *
 * The first occurrence of a name/alias wins on collision — caller's
 * responsibility to choose file order if duplicates exist.
 */
export function buildNameIndex(
  files: string[],
  vaultPath: string,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const f of files) {
    const canonical = basename(f, ".md");
    const lcName = canonical.toLowerCase();
    if (!index.has(lcName)) index.set(lcName, canonical);
    try {
      const parsed = parseNote(f, vaultPath);
      const aliases = parsed.frontmatter.aliases;
      if (Array.isArray(aliases)) {
        for (const alias of aliases) {
          if (typeof alias === "string" && alias.length > 0) {
            const key = alias.toLowerCase();
            if (!index.has(key)) index.set(key, canonical);
          }
        }
      }
    } catch {
      // Unparseable — skip aliases for this file
    }
  }
  return index;
}
