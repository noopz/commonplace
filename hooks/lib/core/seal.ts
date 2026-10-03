/**
 * The sealing guard: private vault domains are explicit-entry, so the model's
 * built-in file tools must not reach a sealed domain's folder either.
 *
 * Sealing commonplace's own tools is not enough — Read/Grep/Glob/Bash can
 * open any file, so without this a sealed note is one `cat` away (review B1).
 * The guard matches only CONCRETE registered vault paths, so an unrelated
 * repo can never false-positive; an exception in the caller fails open.
 *
 * Pure — no `$`, no Node. The adapter in register.tsx computes the roots
 * (realpaths via `$.fs.stat`, lexical fallback) and passes the tool input.
 *
 * Rules, in order:
 *   1. A path argument UNDER a sealed root → deny (read or write).
 *   2. A write (Write/Edit/NotebookEdit) under a protected root
 *      (`.wiki/skills`, `.wiki/agents`) → deny: vault skills are authored by
 *      the user, never by the model (prompt-injection persistence, review B).
 *   3. A recursive scan (Grep, Glob, `grep -r`, `rg`, `find`, `ls -R`, …) or a
 *      shell glob whose root is an ANCESTOR of a sealed root → deny. Scanning
 *      the vault root would read the sealed folder as a side effect.
 * Deny text never names the domain — a deny that names it would itself leak
 * the existence of what is sealed.
 */

export type SealRoots = {
  /** Absolute, normalised: each sealed private-domain folder + `<vault>/.wiki/sealed`. */
  sealed: readonly string[];
  /** Absolute, normalised: `<vault>/.wiki/skills`, `<vault>/.wiki/agents`. */
  protectedWrite: readonly string[];
};

export const SEALED_DENY =
  "That path contains sealed vault content. Use vault_search / vault_note, " +
  "or narrow the path to a public folder.";
export const PROTECTED_DENY =
  "Vault skills and agents are authored by the user outside Claude; see /vault skills.";

/** Lexical normalisation: resolve `.`/`..`, collapse slashes, strip trailing `/`. */
export function normalizePath(p: string, cwd: string, home = ""): string {
  let s = String(p ?? "").trim();
  if (!s) return "";
  if (s === "~" || s.startsWith("~/")) s = (home || "/~") + s.slice(1);
  if (!s.startsWith("/")) s = `${cwd.replace(/\/+$/, "")}/${s}`;
  const out: string[] = [];
  for (const part of s.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

export const isUnder = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
const isAncestorOf = (p: string, root: string) => p === root || root.startsWith(`${p === "/" ? "" : p}/`);

/** Shell-ish word split honouring single/double quotes and backslash escapes. */
export function shellWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")" || ch === "<" || ch === ">") {
      if (has || cur) words.push(cur);
      cur = "";
      has = false;
      if (!/\s/.test(ch)) words.push(ch);
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has || cur) words.push(cur);
  return words;
}

const RECURSIVE_CMDS = new Set(["rg", "find", "fd", "ag", "ack", "tree", "du", "fzf", "locate"]);
const RECURSE_FLAG = /^-[a-zA-Z]*[rR]/;
const looksLikePath = (w: string) => w.startsWith("/") || w.startsWith("~") || w.startsWith(".") || w.includes("/");
const hasGlob = (w: string) => /[*?[]/.test(w);

/** Paths a tool call would touch, and whether each is a recursive scan root. */
export function candidatePaths(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  home = "",
): { path: string; scan: boolean; write: boolean }[] {
  const norm = (p: string) => normalizePath(p, cwd, home);
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const out: { path: string; scan: boolean; write: boolean }[] = [];
  const write = tool === "Write" || tool === "Edit" || tool === "NotebookEdit" || tool === "MultiEdit";

  if (tool === "Grep" || tool === "Glob") {
    const root = str("path") || cwd;
    out.push({ path: norm(root), scan: true, write: false });
    // A Glob pattern can itself be absolute (`/vault/**/x.md`).
    const pat = str("pattern");
    if (tool === "Glob" && pat.startsWith("/")) {
      const fixed = pat.split("/").filter((seg) => !hasGlob(seg));
      out.push({ path: norm(fixed.join("/") || "/"), scan: true, write: false });
    }
    return out;
  }
  if (tool === "Bash") {
    const words = shellWords(str("command"));
    // Judge each simple command (split on ; | & and parens) separately.
    let cmd: string[] = [];
    const flush = () => {
      if (cmd.length === 0) return;
      const name = cmd[0].split("/").pop() ?? "";
      const recursive =
        RECURSIVE_CMDS.has(name) ||
        ((name === "grep" || name === "egrep" || name === "ls" || name === "cp" || name === "rsync" || name === "zip" || name === "tar" || name === "chmod" || name === "chown") &&
          cmd.slice(1).some((a) => RECURSE_FLAG.test(a) || a === "--recursive"));
      for (const w of cmd.slice(1)) {
        if (w.startsWith("-") && !w.includes("/")) continue;
        // `--flag=/path` forms
        const val = w.includes("=") && w.startsWith("-") ? w.slice(w.indexOf("=") + 1) : w;
        if (!looksLikePath(val)) continue;
        if (hasGlob(val)) {
          const fixed = val.split("/").filter((_, i, a) => !a.slice(0, i + 1).some(hasGlob));
          out.push({ path: norm(fixed.join("/") || (val.startsWith("/") ? "/" : ".")), scan: true, write: false });
        } else {
          out.push({ path: norm(val), scan: recursive, write: false });
        }
      }
      // A recursive tool given no path scans the cwd.
      if (recursive && !cmd.slice(1).some((w) => !w.startsWith("-") && looksLikePath(w))) {
        out.push({ path: norm(cwd), scan: true, write: false });
      }
      cmd = [];
    };
    for (const w of words) {
      if ([";", "|", "&", "(", ")", "<", ">"].includes(w)) flush();
      else cmd.push(w);
    }
    flush();
    return out;
  }
  for (const k of ["file_path", "path", "notebook_path"]) {
    const v = str(k);
    if (v) out.push({ path: norm(v), scan: false, write });
  }
  return out;
}

/**
 * The verdict. `null` = allow. Never throws on odd input; the adapter still
 * wraps it so a bug fails open.
 */
export function checkSealedAccess(
  tool: string,
  input: Record<string, unknown>,
  roots: SealRoots,
  cwd: string,
  home = "",
): { deny: string } | null {
  if (roots.sealed.length === 0 && roots.protectedWrite.length === 0) return null;
  for (const c of candidatePaths(tool, input, cwd, home)) {
    if (!c.path) continue;
    if (roots.sealed.some((r) => isUnder(c.path, r))) return { deny: SEALED_DENY };
    if (c.write && roots.protectedWrite.some((r) => isUnder(c.path, r))) return { deny: PROTECTED_DENY };
    if (c.scan && roots.sealed.some((r) => isAncestorOf(c.path, r))) return { deny: SEALED_DENY };
  }
  return null;
}
