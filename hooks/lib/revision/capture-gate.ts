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
export const GATE_MIN_SCORE = 24;
export const GATE_MIN_MATCHED = 3;
export const GATE_POOL_MAX = 8;
export const GATE_CHUNKS_MAX = 24;
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
export function capturePool(text: string, search: (q: string) => GateHit[], opts: { minScore?: number; minMatched?: number; max?: number } = {}): number[] {
  const minScore = opts.minScore ?? GATE_MIN_SCORE;
  const minMatched = opts.minMatched ?? GATE_MIN_MATCHED;
  const agg = new Map<number, { n: number; best: number }>();
  for (const c of chunks(text)) {
    for (const h of search(c)) {
      if (h.score < minScore || new Set(h.matched).size < minMatched) continue;
      const a = agg.get(h.id) ?? { n: 0, best: 0 };
      agg.set(h.id, { n: a.n + 1, best: Math.max(a.best, h.score) });
    }
  }
  return [...agg]
    .sort((a, b) => b[1].n - a[1].n || b[1].best - a[1].best)
    .slice(0, opts.max ?? GATE_POOL_MAX)
    .map(([id]) => id);
}
