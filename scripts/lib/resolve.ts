/**
 * Wikilink resolution helpers — shared by lint, scope-check, indexer, and score.
 *
 * The logic lives in `hooks/lib/graph/resolver.ts` (the one resolver, plan
 * §3.8); this file re-exports it for the Node scripts and adds the one piece
 * that needs the filesystem: reading each file's `aliases:` frontmatter.
 */

import { basename } from "path";
import { parseNote } from "./frontmatter.js";
import {
  ATTACHMENT_EXTS,
  buildNames,
  claimants,
  normalizeKey,
  resolve,
  stemOf,
  type NameNode,
  type Names,
} from "../../hooks/lib/graph/resolver.js";

export { ATTACHMENT_EXTS, buildNames, claimants, normalizeKey, resolve, stemOf };
export type { NameNode, Names };

/**
 * Reduce a wikilink target string to its canonical lookup key, or null if
 * the target can't resolve to a note (intra-doc anchor, attachment, empty).
 * Lowercase, matching Obsidian's case-insensitive resolution.
 */
export const normalizeWikilinkTarget = normalizeKey;

/** A file's frontmatter aliases; [] when absent or unparseable. */
export function readAliases(file: string, vaultPath: string): string[] {
  try {
    const aliases = parseNote(file, vaultPath).frontmatter.aliases;
    return Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === "string" && a.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * Name nodes for a file list: filename stem and aliases, no title — body
 * wikilinks resolve the way Obsidian resolves them. Node id = index in `files`.
 */
export function fileNameNodes(files: string[], vaultPath: string): NameNode[] {
  return files.map((f, id) => ({ id, path: f, title: "", aliases: readAliases(f, vaultPath) }));
}

/**
 * Build a case-insensitive lookup of every note's filename and aliases →
 * canonical filename (basename without `.md`). The canonical name is the
 * form that indexes record, so `bodyLinks` and `frontmatter.concepts`
 * resolve to a stable identifier regardless of how the user typed the link.
 *
 * Collisions follow the resolver's total order (stem > alias > path), so the
 * result does not depend on the order of `files`.
 */
export function buildNameIndex(
  files: string[],
  vaultPath: string,
): Map<string, string> {
  const names = buildNames(fileNameNodes(files, vaultPath));
  const index = new Map<string, string>();
  for (const [key, ids] of names) index.set(key, basename(files[ids[0]], ".md"));
  return index;
}
