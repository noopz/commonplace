/**
 * The free gate in front of a read capture's job: which vault notes, if any,
 * the captured text clearly matches. No model call. A long capture is cut
 * into chunks and each is searched on its own, because the whole text as one
 * query matches something in any vault; a note must be a strong hit for some
 * chunk to enter the pool. Most reads end here, at zero cost.
 *
 * The gate only chooses what the detector reads. Whether a note's claim is
 * changed is the detector's judgment, then review's.
 */

/** How a capture is put to the detector and the reviewers: who said it, and when it describes. */
export function captureFraming(c: { class: string; source: string; asOf?: string; text: string }): string {
  return `${c.class === "owner" ? "The vault owner said, in conversation" : `Read from ${c.source}`}${c.asOf ? ` (as of ${c.asOf})` : ""}:\n\n${c.text}`;
}

export type GateHit = { id: number; score: number; matched: string[] };

/** Linear-scale thresholds, the scale prime pinned its own on. */
const GATE_MIN_SCORE = 24;
const GATE_MIN_MATCHED = 3;
export const GATE_POOL_MAX = 8;
const GATE_CHUNKS_MAX = 24;
const CHUNK_CHARS = 700;

/** Paragraph-sized chunks, at most `max`, spread evenly over a long text. */
export function chunks(text: string, max = GATE_CHUNKS_MAX): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of String(text ?? "").split(/\n\s*\n|\n(?=[-*•] )/)) {
    const p = para.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (cur && cur.length + p.length > CHUNK_CHARS) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${p}` : p;
    while (cur.length > CHUNK_CHARS * 1.5) {
      out.push(cur.slice(0, CHUNK_CHARS));
      cur = cur.slice(CHUNK_CHARS);
    }
  }
  if (cur) out.push(cur);
  if (out.length <= max) return out;
  const step = out.length / max;
  return Array.from({ length: max }, (_, i) => out[Math.floor(i * step)]);
}

/** The pool: notes that are a strong hit for some chunk, the most-matched first. */
export function capturePool(text: string, search: (q: string) => GateHit[], opts: { max?: number } = {}): number[] {
  const agg = new Map<number, { n: number; best: number }>();
  for (const c of chunks(text)) {
    for (const h of search(c)) {
      if (h.score < GATE_MIN_SCORE || new Set(h.matched).size < GATE_MIN_MATCHED) continue;
      const a = agg.get(h.id) ?? { n: 0, best: 0 };
      agg.set(h.id, { n: a.n + 1, best: Math.max(a.best, h.score) });
    }
  }
  return [...agg]
    .sort((a, b) => b[1].n - a[1].n || b[1].best - a[1].best)
    .slice(0, opts.max ?? GATE_POOL_MAX)
    .map(([id]) => id);
}

export type CaptureIn = { class: "owner" | "connector" | "web"; source: string; text?: string; asOf?: string };

/** The text of a tool result, whatever shape the tool answered in: its strings, joined. An error or an image is no text. */
export function resultText(r: unknown, depth = 0): string {
  if (depth > 6 || r === null || r === undefined) return "";
  if (typeof r === "string") return r;
  if (Array.isArray(r)) return r.map((x) => resultText(x, depth + 1)).filter(Boolean).join("\n");
  if (typeof r === "object") {
    const o = r as Record<string, unknown>;
    if (o.isError === true || o.type === "image" || o.type === "audio" || o.type === "resource_link") return "";
    if (typeof o.text === "string") return o.text;
    return Object.values(o).map((x) => resultText(x, depth + 1)).filter(Boolean).join("\n");
  }
  return "";
}

const WRITE_VERB = /^(send|post|create|update|write|edit|reply|comment|add|delete|remove|upload|publish|set|put|patch|append|insert|move|rename|draft)s?$/;
/** Shorter than this, a connector result has nothing to rest a claim on. */
const CONNECTOR_MIN_CHARS = 300;

/**
 * What a connector's tool call read, or null. Too short is dropped, and so is
 * what a write-type tool echoes back (the model wrote it): every word of the
 * name is checked (`slack_send_message`, `notion-create-pages`, `createPage`),
 * unless the server declared the tool read-only. `event` is the call: MCP
 * arguments sit beside `tool` on it.
 */
export function connectorRead(event: Readonly<Record<string, unknown>>, out: { result?: unknown; text?: string; isError?: true; isReadOnly?: true; deny?: string }): CaptureIn | null {
  const tool = String(event.tool);
  const words = (tool.split("__").pop() ?? "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]+/);
  if (out.isError || out.deny !== undefined || (!out.isReadOnly && words.some((w) => WRITE_VERB.test(w)))) return null;
  const text = typeof out.text === "string" ? out.text : resultText(out.result);
  if (text.length < CONNECTOR_MIN_CHARS) return null;
  const url = Object.entries(event).find(([k, v]) => k !== "tool" && typeof v === "string" && /^https?:\/\//.test(v))?.[1] as string | undefined;
  return { class: "connector", source: url ?? tool, text };
}

const PASTED_MARK = /^\s*>|^(?:From|Subject|Sent|To|Date):\s|\bwrote:\s*$|^-{3,} ?Forwarded/im;

/**
 * What a typed prompt contributes, or null: a slash command or a short reply
 * carries no claim worth checking. A long prompt, a code block or quoted mail
 * is mostly something pasted, of no known origin (often mail or a work
 * document), so it is connector class, private notes only.
 */
export function typedCapture(prompt: string, day: string): CaptureIn | null {
  const t = prompt.trim();
  if (t.length < 120 || t.startsWith("/")) return null;
  const pasted = t.length > 1500 || t.includes("```") || PASTED_MARK.test(t);
  return pasted ? { class: "connector", source: "pasted in conversation", text: t } : { class: "owner", source: "conversation", text: t, asOf: day };
}
