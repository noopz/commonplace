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

/** Escape find(1) `-path` glob metacharacters in a literal path. */
function escapeFindGlob(s: string): string {
  return s.replace(/[\\*?[\]]/g, (c) => "\\" + c);
}

/**
 * The `find` argv fragment equivalent to `isExcluded`, anchored at `root` (the
 * path passed to find as its starting point, without a trailing slash).
 * Anchoring matters: an unanchored `-not -path '*\/.*'` excludes EVERYTHING
 * when the vault itself lives under a dot-directory (e.g. `~/.vaults/alpha`).
 * `*` in `-path` matches `/`, so `root/*\/.*` covers every depth below 1.
 *
 * Use with: `find <root> -type f -name '*.md' ...findExcludeArgs(root)`.
 */
export function findExcludeArgs(root: string): string[] {
  const r = escapeFindGlob(root.replace(/\/+$/, "") || "/");
  const base = r === "/" ? "" : r;
  return [
    "-not", "-path", `${base}/.*`,
    "-not", "-path", `${base}/*/.*`,
    "-not", "-path", `${base}/_*/*`,
    "-not", "-path", `${base}/*/_*/*`,
  ];
}

/** Full sweep argv for one find exec over `root`. */
export function findNotesArgv(root: string): string[] {
  return ["find", root, "-type", "f", "-name", "*.md", ...findExcludeArgs(root)];
}
