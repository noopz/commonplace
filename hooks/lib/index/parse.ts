/**
 * One note → the facts the index needs (plan §3.9 step 3). Sandbox-safe: no
 * Node, no `$`. The full rebuild (CLI) and the module's journal patch both
 * parse through here, so they cannot disagree about a note's links.
 *
 * Classification mirrors `scripts/lib/vault.ts classifyNote` plus the
 * auto-discovery rule in `scripts/index.ts` (an "other" note in a folder with
 * a non-empty `concepts:` array is a source). Title is the filename stem, as
 * in `scripts/lib/frontmatter.ts parseNote` — Obsidian resolves by filename.
 */

import { parseFrontmatter, type YamlMap, type YamlValue } from "./yaml.js";
import { normalizeKey, stemOf } from "../graph/resolver.js";

export type NoteKind = "source" | "concept" | "moc" | "other";

export type LinkKind =
  | "body"
  | "concept"
  | "moc"
  | "buildsOn"
  | "comparesWith"
  | "usesMethod"
  | "supersedes";

export interface ParsedLink {
  /** Inner text as written: `Target#h|display` (table `\|` unescaped). */
  raw: string;
  /** Normalised lookup key (`normalizeKey`): lowercase, no anchor/display. */
  target: string;
  display?: string;
  kind: LinkKind;
  /** The governing heading line as written (`## Findings`), "" before any. */
  heading: string;
  /** ≤200 chars of the sentence containing the link, link text included. */
  sentence: string;
  /** 1-based ordinal among this note's links with the same kind and target. */
  n: number;
}

export interface ParsedNote {
  title: string;
  aliases: string[];
  fm: YamlMap;
  kind: NoteKind;
  tags: string[];
  abstraction: string;
  abstractionFallback?: true;
  /** `cues:` — other phrasings a reader would search for this note by (≤8, ≤80 chars each). */
  cues?: string[];
  headings: string[];
  links: ParsedLink[];
  /** Body carries the stub sentinel ("Definition pending - please update."). */
  stubSentinel?: true;
  parseError?: string;
}

export interface ParseOptions {
  /**
   * Frontmatter to use instead of parsing it — the CLI passes gray-matter's
   * result for a file the subset parser rejected (§3.11: the CLI is
   * authoritative for those).
   */
  frontmatter?: YamlMap;
  /** `.wiki/config.json` `structure` folders (vault-relative). */
  structure?: { sources?: string; concepts?: string; mocs?: string };
  /** Registered domain folders (vault-relative); a note under one is a source. */
  domainPaths?: string[];
}

const SENTENCE_MAX = 200;
const ABSTRACTION_MAX = 120;
const CUES_MAX = 8;
const CUE_CHARS = 80;
const STUB_SENTINEL = "Definition pending - please update.";

/** Frontmatter field → link kind. snake_case is what the schema writes. */
const FM_LINK_FIELDS: Array<[string, LinkKind]> = [
  ["concepts", "concept"],
  ["mocs", "moc"],
  ["builds_on", "buildsOn"],
  ["buildsOn", "buildsOn"],
  ["compares_with", "comparesWith"],
  ["comparesWith", "comparesWith"],
  ["uses_method", "usesMethod"],
  ["usesMethod", "usesMethod"],
  ["supersedes", "supersedes"],
];

export function classify(relPath: string, fm: YamlMap, opts: ParseOptions = {}): NoteKind {
  const p = relPath.replace(/\\/g, "/");
  const s = opts.structure ?? {};
  if (s.sources && p.startsWith(s.sources + "/")) return "source";
  if (s.concepts && p.startsWith(s.concepts + "/")) return "concept";
  if (s.mocs && p.startsWith(s.mocs + "/")) return "moc";
  for (const d of opts.domainPaths ?? []) if (d && p.startsWith(d + "/")) return "source";
  // scripts/index.ts auto-registers a domain for a foldered "other" note with
  // source-shaped frontmatter; a root-level note cannot get a domain.
  if (Array.isArray(fm.concepts) && fm.concepts.length > 0 && p.includes("/")) return "source";
  return "other";
}

/** Body text with fenced code blanked and inline code spans masked (same length). */
function maskCode(body: string): { lines: string[]; inFence: boolean[] } {
  const lines = body.split("\n");
  const inFence: boolean[] = [];
  let fence: string | null = null;
  for (let k = 0; k < lines.length; k++) {
    const m = /^(\s*)(```+|~~~+)/.exec(lines[k]);
    if (m) {
      const marker = m[2][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      inFence.push(true);
      continue;
    }
    inFence.push(fence !== null);
  }
  return { lines, inFence };
}

function maskInlineCode(line: string): string {
  return line.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m) => " ".repeat(m.length));
}

const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

interface RawLink {
  raw: string;
  target: string;
  display?: string;
  embed: boolean;
}

/** Split one wikilink's inner text; null when it names no note. */
function readLink(inner: string, embed: boolean): RawLink | null {
  let raw = inner;
  let display: string | undefined;
  const pipe = inner.indexOf("|");
  if (pipe !== -1) {
    // Table cells escape the alias pipe as `\|`.
    const targetPart = inner.slice(0, pipe).replace(/\\$/, "");
    display = inner.slice(pipe + 1).trim() || undefined;
    raw = targetPart + "|" + inner.slice(pipe + 1);
    inner = targetPart;
  }
  const target = normalizeKey(inner);
  if (!target) return null; // `[[#Heading]]`, attachments, empty
  return { raw, target, ...(display ? { display } : {}), embed };
}

/** [start, end) of the sentence around [ls, le) within `text`, never splitting inside a link. */
function sentenceBounds(text: string, ls: number, le: number): [number, number] {
  const inLink = new Array<boolean>(text.length).fill(false);
  for (const m of text.matchAll(/\[\[[^\[\]\n]*\]\]/g)) {
    for (let k = m.index!; k < m.index! + m[0].length; k++) inLink[k] = true;
  }
  const isEnd = (k: number) =>
    !inLink[k] && /[.!?]/.test(text[k]) && (k + 1 >= text.length || /\s/.test(text[k + 1]));
  let start = 0;
  for (let k = ls - 1; k >= 0; k--) {
    if (isEnd(k)) {
      start = k + 1;
      break;
    }
  }
  let end = text.length;
  for (let k = le; k < text.length; k++) {
    if (isEnd(k)) {
      end = k + 1;
      break;
    }
  }
  return [start, end];
}

/** Strip list, quote and callout markers from the start of a line. */
function stripLineMarkers(line: string): string {
  return line
    .replace(/^\s*(>\s*)+/, "")
    .replace(/^\[!\w+\][-+]?\s*/, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "");
}

function sentenceFor(text: string, ls: number, le: number): string {
  let [s, e] = sentenceBounds(text, ls, le);
  while (s < ls && /\s/.test(text[s])) s++;
  while (e > le && /\s/.test(text[e - 1])) e--;
  if (e - s > SENTENCE_MAX) {
    let start = Math.max(s, Math.min(ls, le - SENTENCE_MAX));
    if (start > ls) start = ls;
    s = start;
    e = Math.min(e, s + SENTENCE_MAX);
  }
  return text.slice(s, e);
}

/** Plain text of a markdown line: links reduced to their display text. */
function plainText(line: string): string {
  return line
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\[\]|]+?)(?:\\?\|([^\[\]]+))?\]\]/g, (_m, t: string, d?: string) =>
      (d ?? t.replace(/#.*$/, "")).trim(),
    )
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/(\*\*|__)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max / 2 ? cut.slice(0, sp) : s.slice(0, max)).replace(/[\s,;:–—-]+$/, "");
}

function fallbackAbstraction(lines: string[], inFence: boolean[]): string {
  let k = 0;
  const h1 = lines.findIndex((l, i) => !inFence[i] && /^#\s+\S/.test(l));
  if (h1 !== -1) k = h1 + 1;
  for (; k < lines.length; k++) {
    if (inFence[k]) continue;
    const l = lines[k].trim();
    if (!l || /^#{1,6}\s/.test(l) || /^(-{3,}|\*{3,}|_{3,})$/.test(l)) continue;
    if (l.startsWith("|") || l.startsWith("<") || l.startsWith("%%")) continue;
    if (/^>\s*\[!\w+\][-+]?\s*$/.test(l)) continue; // bare callout header
    if (l.includes(STUB_SENTINEL)) continue;
    const text = plainText(stripLineMarkers(l));
    if (!text) continue;
    const m = /^.*?[.!?](?=\s|$)/.exec(text);
    return truncateWords((m ? m[0] : text).trim(), ABSTRACTION_MAX);
  }
  return "";
}

/** Strings named by a frontmatter link field: `"[[X]]"`, `[[X]]` (YAML nested list), arrays of either. */
function fmLinkStrings(v: YamlValue | undefined): string[] {
  if (typeof v === "string") return [...v.matchAll(/\[\[([^\[\]]+)\]\]/g)].map((m) => m[1]);
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(...fmLinkStrings(item));
    // Unquoted wikilinks parse (in YAML and gray-matter alike) as nested lists:
    // `field: [[X]]` → [["X"]] (item ["X"]); `- [[X]]` → [[["X"]]] (item [["X"]]).
    else if (Array.isArray(item) && item.length === 1) {
      const inner = Array.isArray(item[0]) && item[0].length === 1 ? item[0][0] : item[0];
      if (typeof inner === "string") out.push(inner);
    }
  }
  return out;
}

function strList(v: YamlValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x) => x !== null && typeof x !== "object").map(String) : [];
}

export function parseNote(path: string, text: string, opts: ParseOptions = {}): ParsedNote {
  // Same pre-clean as scripts/lib/frontmatter.ts: bare `P25-11-07` lines break YAML.
  const cleaned = text.replace(/\r\n?/g, "\n").replace(/^P\d{2}-\d{2}-\d{2}$/gm, "");
  const pf = parseFrontmatter(cleaned);
  const fm = opts.frontmatter ?? pf.data;
  const body = pf.body;
  const error = opts.frontmatter ? undefined : pf.error;

  const title = stemOf(path);
  const aliases = Array.isArray(fm.aliases)
    ? fm.aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    : [];
  const tags = strList(fm.tags);
  const kind = classify(path, fm, opts);

  const links: ParsedLink[] = [];
  const ordinal = new Map<string, number>();
  const push = (l: Omit<ParsedLink, "n">) => {
    const key = l.kind + "\0" + l.target;
    const n = (ordinal.get(key) ?? 0) + 1;
    ordinal.set(key, n);
    links.push({ ...l, n });
  };

  // Frontmatter relations first: they are the note's declared structure.
  for (const [field, lk] of FM_LINK_FIELDS) {
    for (const inner of fmLinkStrings(fm[field])) {
      const rl = readLink(inner, false);
      if (!rl) continue;
      push({
        raw: rl.raw,
        target: rl.target,
        ...(rl.display ? { display: rl.display } : {}),
        kind: lk,
        heading: "",
        sentence: `${field}: [[${rl.raw}]]`.slice(0, SENTENCE_MAX),
      });
    }
  }

  const { lines, inFence } = maskCode(body);
  const headings: string[] = [];
  let heading = "";
  for (let k = 0; k < lines.length; k++) {
    if (inFence[k]) continue;
    const line = lines[k];
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      headings.push(h[2]);
      heading = `${h[1]} ${h[2]}`;
    }
    const masked = maskInlineCode(line);
    for (const m of masked.matchAll(WIKILINK_RE)) {
      const rl = readLink(m[2], m[1] === "!");
      if (!rl) continue;
      const ls = m.index!;
      const le = ls + m[0].length;
      // Sentences come from the real line (code spans intact), markers stripped.
      const stripped = stripLineMarkers(line);
      const off = line.length - stripped.length;
      const sentence =
        ls >= off ? sentenceFor(stripped, ls - off, le - off) : sentenceFor(line, ls, le);
      push({
        raw: rl.raw,
        target: rl.target,
        ...(rl.display ? { display: rl.display } : {}),
        kind: "body",
        heading,
        sentence,
      });
    }
  }

  let abstraction = "";
  let abstractionFallback: true | undefined;
  if (typeof fm.abstraction === "string" && fm.abstraction.trim()) {
    abstraction = fm.abstraction.trim();
  } else {
    abstraction = fallbackAbstraction(lines, inFence);
    if (abstraction) abstractionFallback = true;
  }

  const cues = strList(fm.cues)
    .map((c) => c.trim().slice(0, CUE_CHARS))
    .filter(Boolean)
    .slice(0, CUES_MAX);

  return {
    title,
    aliases,
    fm,
    kind,
    tags,
    abstraction,
    ...(abstractionFallback ? { abstractionFallback } : {}),
    ...(cues.length ? { cues } : {}),
    headings,
    links,
    ...(body.includes(STUB_SENTINEL) ? { stubSentinel: true as const } : {}),
    ...(error ? { parseError: error } : {}),
  };
}
