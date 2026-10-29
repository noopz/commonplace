/**
 * Artifacts for the evidence verifier (docs/revision-design.md, "Review" step
 * 4): the captured source behind a source note, retrieved by commonplace
 * itself — never the proposer's quotes. A note names its source on labelled
 * lines (`**URL:**`, `**Source:**`, `**arXiv:**`, `**Paper:**`, `**Links:**`)
 * or in frontmatter (`url`, `source`, `arxiv`), or embeds a captured file
 * (`![[raw/…]]`). The text is cached under `.wiki/revision/artifacts/` by
 * reference, and its hash is what the ledger records.
 *
 * Passage finding is lexical and only LOCATES text (windows sharing the most
 * terms with the claim and its conditions); whether a passage supports the
 * claim is the verifier model's judgment.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { parseFrontmatter } from "../../../hooks/lib/index/yaml.ts";

export type ArtifactRef = { kind: "file" | "url"; ref: string };
export type Artifact = { ref: string; hash: string; text: string; fetchedAt: string; pages?: number[] };
export type Passage = { locator: string; text: string };

const LABELLED = /\*\*(?:URL|Source|Link|Links|Paper|arXiv|Webpage|Doc|PDF):?\*\*:?\s*(\S+)/gi;
const ARXIV_ID = /(?:arxiv\.org\/(?:abs|pdf)\/|arXiv:\s*)?(\d{4}\.\d{4,5})(v\d+)?/i;

/** Where a note's source can be read, best first: a captured file, then an arXiv PDF, then a URL. */
export function sourceRefs(vault: string, noteText: string): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  const add = (r: ArtifactRef) => {
    if (!out.some((x) => x.ref === r.ref)) out.push(r);
  };
  const { data, body } = parseFrontmatter(noteText);
  for (const m of body.matchAll(/!?\[\[((?:raw|_raw)\/[^\]|#]+\.(?:pdf|md|txt|html?))(?:[|#][^\]]*)?\]\]/gi)) {
    const abs = resolve(vault, m[1]);
    if (abs.startsWith(resolve(vault) + "/") && existsSync(abs)) add({ kind: "file", ref: abs });
  }
  const urls: string[] = [];
  for (const k of ["url", "source", "arxiv", "link"]) {
    const v = data[k];
    if (typeof v === "string") urls.push(v);
  }
  for (const m of body.matchAll(LABELLED)) urls.push(m[1]);
  for (const raw of urls) {
    const u = raw.replace(/^<|[)>\].,]+$/g, "").trim();
    const ax = ARXIV_ID.exec(u);
    if (ax && (/arxiv/i.test(u) || /^\d{4}\.\d{4,5}/.test(u))) add({ kind: "url", ref: `https://arxiv.org/pdf/${ax[1]}${ax[2] ?? ""}` });
    else if (/^https?:\/\//.test(u)) add({ kind: "url", ref: u });
  }
  return out;
}

const cacheDir = (vault: string) => join(vault, ".wiki", "revision", "artifacts");
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractAllText } = await import("../../paper/lib/pdf.ts");
  const tmp = join(tmpdir(), `cp-art-${process.pid}-${Date.now()}.pdf`);
  writeFileSync(tmp, bytes);
  try {
    return await extractAllText(tmp);
  } finally {
    try {
      (await import("fs")).rmSync(tmp, { force: true });
    } catch {}
  }
}

/** The artifact's text, from cache or fetched now; null when it cannot be reached. */
export async function loadArtifact(vault: string, r: ArtifactRef, opts: { timeoutMs?: number; offline?: boolean } = {}): Promise<Artifact | null> {
  const dir = cacheDir(vault);
  const file = join(dir, `${sha(r.ref).slice(0, 32)}.json`);
  try {
    const cached = JSON.parse(readFileSync(file, "utf-8")) as Artifact;
    if (cached.text) return cached;
  } catch {}
  let text = "";
  try {
    if (r.kind === "file") {
      const bytes = readFileSync(r.ref);
      text = /\.pdf$/i.test(r.ref) ? await pdfText(new Uint8Array(bytes)) : /\.html?$/i.test(r.ref) ? htmlToText(bytes.toString("utf-8")) : bytes.toString("utf-8");
    } else {
      if (opts.offline) return null;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
      try {
        const res = await fetch(r.ref, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": "commonplace-revision/1 (evidence check)" } });
        if (!res.ok) return null;
        const type = res.headers.get("content-type") ?? "";
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (/pdf/i.test(type) || /\.pdf($|\?)/i.test(r.ref)) text = await pdfText(bytes);
        else text = htmlToText(new TextDecoder().decode(bytes));
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    return null;
  }
  text = text.trim();
  if (text.length < 200) return null; // a paywall stub or an empty page is not the source
  const art: Artifact = { ref: r.ref, hash: `sha256:${sha(text).slice(0, 32)}`, text, fetchedAt: new Date().toISOString() };
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(art));
    renameSync(tmp, file);
  } catch {}
  return art;
}

const STOP = new Set("the a an and or of to in on for with by from at as is are was were be been this that these those it its into than then their our we they which who what when where how not no can may might also more most such using use used".split(" "));
const terms = (s: string) =>
  [...new Set(s.toLowerCase().replace(/[^a-z0-9.%-]+/g, " ").split(" ").filter((t) => t.length > 1 && !STOP.has(t)))];

/** Up to `k` windows of the artifact that share the most terms with `query`, with their locators. */
export function passages(art: Artifact, query: string, k = 4, window = 1100): Passage[] {
  const want = terms(query);
  if (want.length === 0) return [];
  const text = art.text;
  const step = Math.floor(window / 2);
  const scored: Array<{ at: number; score: number }> = [];
  for (let at = 0; at < text.length; at += step) {
    const slice = text.slice(at, at + window).toLowerCase();
    let score = 0;
    for (const t of want) if (slice.includes(t)) score += t.length > 3 || /\d/.test(t) ? 2 : 1;
    if (score > 0) scored.push({ at, score });
  }
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  const picked: number[] = [];
  for (const s of scored) {
    if (picked.length >= k) break;
    if (picked.some((p) => Math.abs(p - s.at) < window)) continue;
    picked.push(s.at);
  }
  return picked
    .sort((a, b) => a - b)
    .map((at) => {
      const page = [...text.slice(0, at).matchAll(/--- Page (\d+) ---/g)].pop()?.[1];
      return { locator: `${page ? `p.${page} ` : ""}chars ${at}-${Math.min(text.length, at + window)}`, text: text.slice(at, at + window) };
    });
}
