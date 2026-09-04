/**
 * The status band above the prompt: its model and its one rendered line.
 *
 * Pure — no `$`. The band is a receipt for work the vault just did, not a
 * dashboard: `turn.complete` raises it, `prompt.submit` lowers it.
 */

export type Status = {
  phase: "idle" | "ok" | "warn";
  sources: number;
  concepts: number;
  surfaced: number;
  lastOutcome: string;
  lastError: string;
  paused: boolean;
  /**
   * Whether the band is currently drawn. It is a receipt for work just done,
   * not a dashboard: `turn.complete` raises it when the vault was actually
   * consulted, and `prompt.submit` lowers it the moment the user types again.
   * A line that persists across turns becomes furniture and stops being read.
   */
  visible: boolean;
};
/**
 * The one line drawn above the prompt, or null to draw nothing.
 *
 * Ordered by what the user needs to act on: a stopped feature first, then a
 * plain heartbeat. Returns null before the first run so an unconfigured vault
 * never puts a band on someone's screen.
 */
export function statusLine(
  s: Status,
): { text: string; color: string; dim: boolean } | null {
  // Hidden until the vault has actually done something this turn, and hidden
  // again as soon as the user starts the next one.
  if (!s.visible) return null;

  if (s.paused) {
    const why = s.lastError ? ` — ${s.lastError}` : "";
    return {
      text: `⚠ commonplace: connection surfacing stopped after repeated errors${why}`,
      color: "yellow",
      dim: false,
    };
  }

  /*
   * A `partialIndex` warning stood here — "vault index outgrew the 2000-line
   * read cap". It was wrong in both directions: the Read tool's cap is a size
   * budget near 48KB, not 2000 lines, and it had already been crossed
   * silently. Index reads now go through `$.process.run(["cat", …])`, which
   * returns the file whole, so there is no partial state left to warn about.
   */

  if (s.phase === "idle") return null;

  const bits = [
    `${s.sources} sources`,
    `${s.concepts} concepts`,
    `${s.surfaced} surfaced`,
  ];
  if (s.lastOutcome) bits.push(`last: ${s.lastOutcome}`);
  return { text: `⟡ vault · ${bits.join(" · ")}`, color: "gray", dim: true };
}
