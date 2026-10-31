/**
 * Read captures: what an agent READ from outside the vault, recorded by code at
 * read time so revision can rest on it (docs/revision-design.md, "Read
 * capture"). The module hands the CLI the raw text of a connector result or the
 * person's own words; a web page is fetched here, never taken from WebFetch's
 * summary. Captures live under `.wiki/revision/captures/`, outside git; only
 * the window an ACCEPTED revision cites is ever written into the vault.
 *
 * Who said it decides what it may do (`allowedRelations`): the person's own
 * words, anything; a page or connector result, only `contests` or
 * `withdraws_support`, unless it is the older note's own source (an erratum, a
 * changelog). Connector text is private: it may only revise notes in a private
 * shard, so work text never lands in a public note or the public ledger.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { RevisionRelation } from "../../../hooks/lib/revision/edges.ts";

export type CaptureClass = "owner" | "connector" | "web";
export type Capture = {
  hash: string;
  class: CaptureClass;
  /** A URL when there is one, else the tool that returned the text. */
  source: string;
  title: string;
  capturedAt: string;
  /** The date the content describes, only when its own metadata (or the person, now) gives one. */
  asOf?: string;
  text: string;
};

export const CAPTURE_MAX_CHARS = 200_000;
export const CAPTURE_MIN_CHARS = 200;
/** The owner's own words carry more per character than a page: a two-sentence correction is enough. */
export const CAPTURE_MIN_OWNER_CHARS = 120;
/** Captures no proposal refers to are dropped after this. */
export const CAPTURE_TTL_MS = 30 * 24 * 3600_000;

const dir = (vault: string) => join(vault, ".wiki", "revision", "captures");
const fileOf = (vault: string, hash: string) => join(dir(vault), `${hash.replace(/[^a-f0-9]/g, "")}.json`);
export const captureHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** A short title for the captured source, safe as a file name. */
export function captureTitle(source: string, text: string): string {
  let base = "";
  try {
    const u = new URL(source);
    base = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.split("/").slice(0, 3).join(" ");
  } catch {
    base = source === "conversation" ? "In conversation" : source.replace(/^mcp__/, "").replace(/__/g, " ");
  }
  const first = text.split("\n").map((l) => l.trim()).find((l) => l.length >= 12) ?? "";
  const cut = first.length > 60 ? first.slice(0, 60).replace(/\s+\S*$/, "") : first;
  const t = `${base}${cut ? ` - ${cut}` : ""}`;
  return t.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "Captured source";
}

/** Store a capture; the same text is one capture. Null when there is too little to rest anything on. */
export function writeCapture(vault: string, c: Omit<Capture, "hash" | "capturedAt" | "title"> & { title?: string }): Capture | null {
  const text = String(c.text ?? "").slice(0, CAPTURE_MAX_CHARS).trim();
  if (text.length < (c.class === "owner" ? CAPTURE_MIN_OWNER_CHARS : CAPTURE_MIN_CHARS)) return null;
  const hash = captureHash(text);
  const existing = readCapture(vault, hash);
  if (existing) return existing;
  const cap: Capture = {
    hash,
    class: c.class,
    source: String(c.source || "unknown").slice(0, 500),
    title: c.title || captureTitle(c.source, text),
    capturedAt: new Date().toISOString(),
    ...(c.asOf ? { asOf: c.asOf } : {}),
    text,
  };
  mkdirSync(dir(vault), { recursive: true });
  const f = fileOf(vault, hash);
  writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(cap));
  renameSync(`${f}.${process.pid}.tmp`, f);
  return cap;
}

export function readCapture(vault: string, hash: string): Capture | null {
  try {
    return JSON.parse(readFileSync(fileOf(vault, hash), "utf-8")) as Capture;
  } catch {
    return null;
  }
}

/** Drop captures older than the TTL that no live proposal names. */
export function pruneCaptures(vault: string, keep: ReadonlySet<string>, now = Date.now()): number {
  let n = 0;
  try {
    for (const f of readdirSync(dir(vault))) {
      const hash = f.replace(/\.json$/, "");
      if (keep.has(hash)) continue;
      const p = join(dir(vault), f);
      if (now - statSync(p).mtimeMs > CAPTURE_TTL_MS) {
        rmSync(p, { force: true });
        n++;
      }
    }
  } catch {}
  return n;
}

/** The local calendar day of an instant: a capture is dated the day the person read it. */
const localDay = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const ALL: RevisionRelation[] = ["supersedes", "bounds", "contests", "withdrawsSupport"];

/**
 * The relations a capture may decide. A single page or connector result only
 * raises a dispute or removes support; superseding needs the person's words
 * or the older note's own source (`oldSources`: the URLs it cites).
 */
export function allowedRelations(c: Pick<Capture, "class" | "source">, oldSources: readonly string[]): RevisionRelation[] {
  if (c.class === "owner") return ALL;
  const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[#?].*$/, "").replace(/\/+$/, "");
  if (oldSources.some((u) => norm(u) === norm(c.source))) return ALL;
  return ["contests", "withdrawsSupport"];
}

export { captureFraming } from "../../../hooks/lib/revision/capture-gate.ts";

/** Where the note an accepted capture becomes will live: beside the older note, so it is in the same scope. */
export function plannedRel(vault: string, oldRel: string, c: Pick<Capture, "title" | "capturedAt">): string {
  const folder = dirname(oldRel) === "." ? "" : `${dirname(oldRel)}/`;
  const base = `${localDay(c.capturedAt)} ${c.title}`;
  let rel = `${folder}${base}.md`;
  for (let i = 2; existsSync(join(vault, rel)); i++) rel = `${folder}${base} ${i}.md`;
  return rel;
}

/** The captured window an accept writes into the vault: the passages the decision rests on, not the whole text. */
export function rawRelFor(noteRel: string): string {
  const folder = dirname(noteRel) === "." ? "" : `${dirname(noteRel)}/`;
  return `${folder}raw/${noteRel.split("/").pop()}`;
}

export function rawText(c: Capture, passages: ReadonlyArray<{ locator: string; text: string }>): string {
  return [
    `Source: ${c.source}`,
    `Captured: ${localDay(c.capturedAt)}${c.asOf ? ` · as of ${c.asOf}` : ""} · ${c.class === "owner" ? "the vault owner's own words" : c.class === "connector" ? "connector read" : "web page"}`,
    "",
    ...passages.flatMap((p) => [`--- ${p.locator} ---`, p.text.trim(), ""]),
  ].join("\n");
}

/** The source note an accepted capture becomes; the edge is inserted into it by the accept. */
export function captureNote(c: Capture, rawRel: string): string {
  return [
    "---",
    "type: source",
    `created: ${localDay(new Date().toISOString())}`,
    ...(c.asOf ? [`as_of: ${c.asOf}`] : []),
    "tags: [captured]",
    "---",
    `# ${c.title}`,
    "",
    c.class === "owner" ? "**Source:** the vault owner, in conversation" : `**URL:** ${c.source}`,
    `**Original:** ![[${rawRel}]]`,
    "",
    "Captured by commonplace when it was read, because it bears on a claim in an older note. The excerpt above is the part the revision rests on.",
    "",
  ].join("\n");
}
