/**
 * Deterministic `published:` derivation for source notes — when the knowledge
 * was produced, as opposed to `created:` (when it entered the vault).
 *
 * Read ONLY from labelled lines (`**Published:**`, `**Date:**`, `**Source:**`,
 * `**Paper:**`, `**arXiv:**`, `**Links:**`, `**URL:**`, `**Venue:**`,
 * `**Year:**`). An arXiv id elsewhere in the body is usually a citation of
 * some OTHER paper, so it never counts. Per line, the most precise evidence
 * wins: an ISO date, then "Month D, YYYY" / "Month YYYY", then an arXiv id
 * (2502.14802 → 2025-02), then a bare year. Lines are tried in label order
 * (published/date first), and no date is guessed without one.
 */

const LABEL = /^\s*[-*]?\s*\*\*(published|date|year|source|paper|arxiv|links?|url|venue)\b[^*\n]*\*\*:?(.*)$/gim;
const ORDER = ["published", "date", "year", "arxiv", "paper", "source", "venue", "link", "links", "url"];
const ISO = /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_DAY_YEAR = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/i;
const MONTH_YEAR = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+((?:19|20)\d{2})\b/i;
const ARXIV_PREFIXED = /(?:arxiv\.org\/(?:abs|pdf|html)\/|arxiv:?\s*)(\d{2})(0[1-9]|1[0-2])\.\d{4,5}\b/i;
/** A bare id ("2605.03042") counts only on an arXiv-labelled line. */
const ARXIV_BARE = /^\s*(\d{2})(0[1-9]|1[0-2])\.\d{4,5}\b/;
const YEAR = /\b((?:19|20)\d{2})\b/;

export type Derived = { published: string; from: "date" | "month" | "arxiv" | "year" };

const pad = (n: number) => String(n).padStart(2, "0");

/** The best date on one labelled line's value, or null. */
export function dateOnLine(value: string, label: string): Derived | null {
  const iso = ISO.exec(value);
  if (iso) return { published: `${iso[1]}-${iso[2]}-${iso[3]}`, from: "date" };
  const mdy = MONTH_DAY_YEAR.exec(value);
  if (mdy) {
    const d = Number(mdy[2]);
    if (d >= 1 && d <= 31) return { published: `${mdy[3]}-${pad(MONTHS.indexOf(mdy[1].toLowerCase().slice(0, 3)) + 1)}-${pad(d)}`, from: "date" };
  }
  const my = MONTH_YEAR.exec(value);
  if (my) return { published: `${my[2]}-${pad(MONTHS.indexOf(my[1].toLowerCase().slice(0, 3)) + 1)}`, from: "month" };
  const ax = ARXIV_PREFIXED.exec(value) ?? (label === "arxiv" ? ARXIV_BARE.exec(value) : null);
  if (ax) return { published: `20${ax[1]}-${ax[2]}`, from: "arxiv" };
  if (label === "links" || label === "link" || label === "url") return null; // a year in a URL path is not a date
  const y = YEAR.exec(value);
  return y ? { published: y[1], from: "year" } : null;
}

export function derivePublished(body: string): Derived | null {
  const lines = [...body.matchAll(LABEL)].map((m) => ({ label: m[1].toLowerCase(), value: m[2] }));
  lines.sort((a, b) => ORDER.indexOf(a.label) - ORDER.indexOf(b.label));
  for (const l of lines) {
    const d = dateOnLine(l.value, l.label);
    if (d) return d;
  }
  return null;
}

/** `published: 'YYYY-MM'` as the last frontmatter line, every other byte preserved; null without closed frontmatter. */
export function insertFrontmatterPublished(raw: string, published: string): string | null {
  if (!raw.startsWith("---\n")) return null;
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return null;
  return raw.slice(0, end) + `\npublished: '${published}'` + raw.slice(end);
}
