/**
 * One compact card per note (`graph/cards/main.NNN.jsonl`, plan §3.3).
 *
 * A card is what search results, link listings and the prime show about a
 * note WITHOUT reading it: title, kind, domain, a ≤120-char abstraction and
 * its public degree/neighbours. No path: the title IS the filename stem
 * (parse.ts), so a path on the card paid for a long title twice and the
 * abstraction was clipped to pay the bill. Readers take the path from the
 * view (`relOfId`), which every visible id has. It is a pointer, never content — reading
 * the note is still `vault_note`'s job.
 *
 * `deg`/`nb` are computed by the caller on the public subgraph (review B8),
 * so a card never reveals that a sealed note links here. No hub/authority
 * scores on cards: those are internal ranking signals, not facts to show.
 *
 * Sandbox-safe.
 */

export type Card = {
  id: number;
  t: string;
  k: "source" | "concept" | "moc" | "other";
  d: string;
  a: string;
  /** 1 when `a` is the first-sentence fallback, not a written abstraction. */
  af?: 1;
  /** [in-degree, out-degree] on the public subgraph. */
  deg: [number, number];
  /** Up to 3 strongest public neighbour ids. */
  nb: number[];
  tags: string[];
  stub: boolean;
  ret: boolean;
  /** When the knowledge was produced (`published:`/`date:`), when it entered the vault (`created:`). */
  pub?: string;
  cr?: string;
};

export const CARD_ABSTRACTION_MAX = 120;
export const CARD_MAX_BYTES = 290;
/** Small on purpose: a card lookup parses its whole chunk, and lookups scatter across ids. */
export const CARDS_PER_CHUNK = 128;

export function clip(s: string, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * Build a card, shedding tags, then neighbours, until the serialised line fits
 * CARD_MAX_BYTES — a soft budget. The abstraction is never clipped below
 * CARD_ABSTRACTION_MAX: it is the one field a card exists to deliver, so a
 * note with a very long title gets a longer line instead.
 */
export function makeCard(c: Omit<Card, "a"> & { a: string }): Card {
  const card: Card = { ...c, a: clip(c.a, CARD_ABSTRACTION_MAX), tags: c.tags.slice(0, 5), nb: c.nb.slice(0, 3) };
  if (!c.af) delete card.af;
  if (!c.pub) delete card.pub;
  if (!c.cr) delete card.cr;
  const size = () => new TextEncoder().encode(JSON.stringify(card)).length;
  while (size() > CARD_MAX_BYTES && card.tags.length > 0) card.tags.pop();
  while (size() > CARD_MAX_BYTES && card.nb.length > 0) card.nb.pop();
  return card;
}

/** Chunk number for an id (cards are written in id order, CARDS_PER_CHUNK per file). */
export const cardChunk = (id: number) => Math.floor(id / CARDS_PER_CHUNK);
export const cardChunkName = (shard: string, chunk: number) =>
  `${shard}.${String(chunk).padStart(3, "0")}.jsonl`;
