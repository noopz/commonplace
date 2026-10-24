/**
 * `[[wikilinks]]` in Claude's replies: find them, turn the ones that resolve
 * into clickable links, and write the footer that flags the citations that do
 * not hold up (not a note, not read, superseded, contested). Drawing only: the stored message and what the model read never change.
 *
 * Sandbox-safe: no I/O. The module resolves titles and reads cards; this file
 * only rewrites text.
 */

export type WikiRef = { title: string; label: string };

/** `[[Title]]`, `[[Title|label]]`, `[[Title#Heading]]` (one match per link). */
const WIKI = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

/**
 * Runs of `text` outside code: fenced blocks and inline code spans are kept
 * whole and marked `code`, so a `[[x]]` inside an example is left alone.
 */
export function segments(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const push = (code: boolean, s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.code === code) last.text += s;
    else out.push({ code, text: s });
  };
  const lines = String(text ?? "").split(/(?<=\n)/);
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      push(true, line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      push(true, line);
      continue;
    }
    // Inline code: a run of N backticks closes on the next run of exactly N.
    let i = 0;
    while (i < line.length) {
      const tick = line.indexOf("`", i);
      if (tick < 0) {
        push(false, line.slice(i));
        break;
      }
      push(false, line.slice(i, tick));
      let n = 0;
      while (line[tick + n] === "`") n++;
      const run = "`".repeat(n);
      let close = line.indexOf(run, tick + n);
      while (close >= 0 && line[close + n] === "`") close = line.indexOf(run, close + n + 1);
      if (close < 0) {
        push(false, line.slice(tick));
        break;
      }
      push(true, line.slice(tick, close + n));
      i = close + n;
    }
  }
  return out;
}

/** Distinct wikilinks outside code, in order of first appearance (case-insensitive). */
export function wikiRefs(text: string): WikiRef[] {
  const seen = new Set<string>();
  const out: WikiRef[] = [];
  for (const s of segments(text)) {
    if (s.code) continue;
    for (const m of s.text.matchAll(WIKI)) {
      const title = m[1].trim();
      const key = title.toLowerCase();
      if (!title || seen.has(key)) continue;
      seen.add(key);
      out.push({ title, label: (m[2] ?? "").trim() || title });
    }
  }
  return out;
}

/** A `file:` URL for an absolute path, each segment percent-encoded. */
export function fileHref(absPath: string): string {
  return `file://${String(absPath).split("/").map((p) => encodeURIComponent(p)).join("/")}`;
}

/** Markdown link text: brackets and backslashes escaped. */
const linkText = (s: string) => s.replace(/[\\[\]]/g, (c) => `\\${c}`);

/**
 * Replace each wikilink outside code whose title `hrefOf` resolves with a
 * markdown link; any other is left exactly as written.
 */
export function linkWikiRefs(text: string, hrefOf: (title: string) => string | null): string {
  return segments(text)
    .map((s) =>
      s.code
        ? s.text
        : s.text.replace(WIKI, (whole, rawTitle: string, rawLabel?: string) => {
            const href = hrefOf(rawTitle.trim());
            if (!href) return whole;
            return `[${linkText((rawLabel ?? "").trim() || rawTitle.trim())}](${href})`;
          }),
    )
    .join("");
}

export type CitedNote = {
  title: string;
  /** `missing`: no visible note has this title. `unread`: it exists, but no vault_note or Read opened it this session. */
  status: "ok" | "missing" | "unread";
  href?: string;
  supersededBy?: string[];
  contestedBy?: string[];
};

/** Footer lines at most; the rest are counted. */
export const FOOTER_MAX = 6;

/**
 * The flags under a reply that cites vault notes: one line per citation that
 * does not hold up as written — not a note, not read this session, or read
 * but superseded or contested. A citation that holds gets no line: the footer
 * is a warning, so a reply whose citations are sound draws none at all.
 */
export function citationFooter(cited: readonly CitedNote[]): string {
  const lines: string[] = [];
  for (const c of cited) {
    if (c.status === "missing") {
      lines.push(`✗ [[${c.title}]] is not a note in your vault`);
      continue;
    }
    const facts: string[] = [];
    if (c.status === "unread") facts.push("cited without being read this session");
    if (c.supersededBy?.length) facts.push(`superseded by ${c.supersededBy.map((x) => `[[${x}]]`).join(", ")}`);
    if (c.contestedBy?.length) facts.push(`contested by ${c.contestedBy.map((x) => `[[${x}]]`).join(", ")}`);
    if (facts.length === 0) continue;
    const name = c.href ? `[${linkText(c.title)}](${c.href})` : `[[${c.title}]]`;
    lines.push(`⚠ ${name} · ${facts.join(" · ")}`);
  }
  if (lines.length === 0) return "";
  const shown = lines.slice(0, FOOTER_MAX);
  if (lines.length > FOOTER_MAX) shown.push(`… ${lines.length - FOOTER_MAX} more`);
  return shown.join("  \n");
}

/** Counts for the hook-log line (`cite:check`): no titles, they may be private. */
export function citationCounts(cited: readonly CitedNote[]): { refs: number; missing: number; unread: number } {
  return {
    refs: cited.length,
    missing: cited.filter((c) => c.status === "missing").length,
    unread: cited.filter((c) => c.status === "unread").length,
  };
}
