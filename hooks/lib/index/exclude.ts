/**
 * The one exclusion predicate (plan §3.9 step 1b, review A9). Sandbox-safe.
 *
 * The CLI (`scripts/lib/vault.ts findNotesByGlob`) and the module's sweep must
 * agree on which files are notes, or a journal-patched graph and a full
 * rebuild diverge. A file is NOT a note when:
 *   - it is not a `.md` file;
 *   - its filename starts with `.` (glob's default `dot: false`);
 *   - any DIRECTORY on its vault-relative path starts with `.` (`.trash`,
 *     `.obsidian`, `.git`, `.wiki`, any `/.x/`) or `_` (`_raw/`, `_templates/`
 *     — scaffolding, not managed notes).
 *
 * A note simply NAMED `_draft.md` is still a note: the `_` rule applies to
 * directory segments only, as findNotesByGlob always did.
 */

/** True when `relPath` (vault-relative, `/` or `\` separated) is not a note. */
export function isExcluded(relPath: string): boolean {
  const segs = String(relPath).replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter((s) => s !== "");
  const file = segs.pop();
  if (!file || !file.endsWith(".md")) return true;
  if (file.startsWith(".")) return true;
  return segs.some((d) => d.startsWith(".") || d.startsWith("_"));
}

/**
 * The `find` argv equivalent to `isExcluded`, over `root`, optionally limited
 * to files newer than `newer`.
 *
 * Excluded directories are PRUNED, not filtered: `-not -path` still walks
 * `.git/objects`, `.obsidian/plugins`, `.trash` and any worktree checkout
 * before discarding them, which made the sweep several times slower than the
 * notes it lists. `-mindepth 1` keeps `root` itself out of the prune, so a
 * vault living under a dot-directory (e.g. `~/.vaults/alpha`) is still walked.
 */
export function findNotesArgv(root: string, newer?: string): string[] {
  return [
    "find", root, "-mindepth", "1",
    "-type", "d", "(", "-name", ".*", "-o", "-name", "_*", ")", "-prune",
    "-o", "-type", "f", "-name", "*.md", "!", "-name", ".*",
    ...(newer ? ["-newer", newer] : []),
    "-print",
  ];
}
