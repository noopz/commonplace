/**
 * The witness: every piece of context commonplace adds that the transcript
 * does not show — the first-message block, prime, subagent prompt rewrites,
 * skill preambles, notes riding tool results, command context — kept word
 * for word so `/vault witness` can show exactly what the model was told.
 *
 * Module memory only (an entry can quote an open private note). Sandbox-safe.
 */

export type WitnessEntry = { at: number; kind: string; text: string };

/** Entries kept; the oldest leave first. */
export const WITNESS_MAX = 100;

export class Witness {
  private entries: WitnessEntry[] = [];
  private total = 0;

  add(kind: string, text: string, at: number): void {
    const t = String(text ?? "");
    if (!t.trim()) return;
    this.entries.push({ at, kind, text: t });
    this.total += t.length;
    if (this.entries.length > WITNESS_MAX) this.entries.shift();
  }

  clear(): void {
    this.entries = [];
    this.total = 0;
  }

  list(): readonly WitnessEntry[] {
    return this.entries;
  }

  /** Characters added this session, those already rotated out included. */
  chars(): number {
    return this.total;
  }
}

/** Longest single entry drawn whole; past it the head is shown. */
export const WITNESS_ENTRY_CHARS = 4000;

/** Markdown for the witness pane (or the command's text where no pane is placed). */
export function renderWitness(w: Witness): string {
  const list = w.list();
  if (list.length === 0) return "Nothing hidden added yet this session.";
  const head = `**${list.length} hidden addition${list.length === 1 ? "" : "s"} · ${w.chars().toLocaleString("en-US")} characters this session**`;
  const body = [...list].reverse().map((e) => {
    const time = new Date(e.at).toISOString().slice(11, 19);
    const text = e.text.length > WITNESS_ENTRY_CHARS ? `${e.text.slice(0, WITNESS_ENTRY_CHARS)}\n… ${e.text.length - WITNESS_ENTRY_CHARS} more characters` : e.text;
    return `#### ${time} · ${e.kind} · ${e.text.length} chars\n\n\`\`\`\`text\n${text}\n\`\`\`\``;
  });
  return [head, ...body].join("\n\n");
}
