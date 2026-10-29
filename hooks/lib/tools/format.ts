/**
 * Model-facing strings for the vault tools (plan §5). No numeric scores, ever
 * (B15): ranks are positions, link weights are shown only as `×N` occurrence
 * counts, and every listing ends by reminding the reader that a pointer is not
 * a finding.
 *
 * Sandbox-safe.
 */

import type {
  CommonplaceCard,
  CommonplaceLink,
  CommonplaceNote,
  CommonplaceSearchResult,
  CommonplaceLinksResult,
  CommonplacePathResult,
  CommonplaceNeighbourhoodResult,
  CommonplaceListResult,
} from "../../../types/index.js";

export const PRIVATE_CAUTION =
  "(private domain, open in this session — keep its content in the vault; do not copy it into code or other repos)";

const t = (c: CommonplaceCard) => `[[${c.title}]]`;
const priv = (c: CommonplaceCard) => (c.isPrivate ? " 🔒" : "");

/**
 * The note's status, then its two clocks, as facts for the reader to weigh —
 * no age decay is applied anywhere. Old is not stale (a paper can matter more
 * years later) and new is not current (it can be superseded); only an explicit
 * revision edge says a claim was overtaken. Status comes FIRST: LLM readers
 * shift toward newer dates when a date is the first thing they see.
 */
export function timeLines(c: CommonplaceCard): string[] {
  const out: string[] = [];
  if (c.revisions?.length) for (const r of c.revisions) out.push(r.line);
  else {
    if (c.supersededBy?.length) out.push(`⚠ superseded by ${c.supersededBy.map((x) => `[[${x}]]`).join(", ")} — kept for history; read the newer note before relying on this one`);
    if (c.contestedBy?.length) out.push(`⚠ contested by ${c.contestedBy.map((x) => `[[${x}]]`).join(", ")} — read both before relying on either`);
  }
  if (c.mayRelyOnDisplaced?.length) {
    out.push(`⚠ may still rely on a displaced claim of ${c.mayRelyOnDisplaced.map((x) => `[[${x}]]`).join(", ")} — check before relying on this summary`);
  }
  const clock = [c.published ? `published ${c.published}` : "", c.added ? `added ${c.added}` : ""].filter(Boolean);
  if (clock.length) out.push(clock.join(" · "));
  return out;
}

/** Status lines only (no clock), for one-line surfaces. */
export const statusOnly = (c: CommonplaceCard): string[] => timeLines({ ...c, published: undefined, added: undefined });

function whyLine(l: CommonplaceLink, direction: "out" | "in"): string {
  const count = l.kind === "body" && l.weight > 1 ? ` ×${Math.round(l.weight)}` : "";
  const where = l.heading ? `${l.heading}: ` : "";
  const pointer = l.why ? ` — ${where}pointer text (unread): "${l.why}"` : l.kind !== "body" ? " — frontmatter" : "";
  const other = direction === "out" ? l.to : l.from;
  return `${direction === "out" ? "→" : "←"} ${t(other)}${priv(other)} ${l.kind}${count}${pointer}`;
}

export function formatSearch(r: CommonplaceSearchResult, query: string): string {
  if (r.hits.length === 0) {
    return `No vault notes matched "${query}". Try the user's own distinctive terms, or vault_list mocs to browse.`;
  }
  const lines = [`${r.hits.length} pointer(s) for "${query}":`];
  for (const h of r.hits) {
    const meta = [h.path, h.domain || "—", h.kind].join(" · ");
    lines.push(`${h.rank}. ${h.title}${priv(h)}`);
    lines.push(`   ${meta}`);
    if (h.abstraction) lines.push(`   ${h.abstraction}`);
    for (const l of timeLines(h)) lines.push(`   ${l}`);
    lines.push(`   links: in ${h.inDegree} / out ${h.outDegree} · matched: ${h.matched.join(", ")}`);
    if (h.isPrivate) lines.push(`   ${PRIVATE_CAUTION}`);
  }
  if (r.nextOffset !== undefined) lines.push(`More pointers exist: repeat with offset ${r.nextOffset}.`);
  lines.push("Pointers only — a lexical match is not relevance. Read with vault_note; follow with vault_links.");
  return lines.join("\n");
}

export function formatNote(n: CommonplaceNote): string {
  const parts = [n.card.path, ...timeLines(n.card)];
  if (n.card.isPrivate) parts.push(PRIVATE_CAUTION);
  parts.push("", n.text.trimEnd());
  if (n.truncated) parts.push("", "…(truncated; pass a larger maxChars to read more)");
  parts.push("", "---");
  if (n.out.length) {
    parts.push(`Outgoing (${n.out.length + n.moreOut}, showing ${n.out.length}):`);
    for (const l of n.out) parts.push(whyLine(l, "out"));
    if (n.moreOut) parts.push(`…(${n.moreOut} more → vault_links)`);
  } else parts.push("Outgoing: none");
  if (n.in.length) {
    parts.push(`Incoming (${n.in.length + n.moreIn}, showing ${n.in.length}):`);
    for (const l of n.in) parts.push(whyLine(l, "in"));
    if (n.moreIn) parts.push(`…(${n.moreIn} more → vault_links direction:"in")`);
  } else parts.push("Incoming: none");
  return parts.join("\n");
}

/** The hidden follow-up nudge attached as tool-result context (not shown to the user). */
export function unreadContext(n: CommonplaceNote): string | null {
  if (n.unread.length === 0) return null;
  return `Linked notes not yet read this session: ${n.unread.map(t).join(", ")} — open with vault_note if relevant.`;
}

export function formatLinks(r: CommonplaceLinksResult, direction: "out" | "in" | "both"): string {
  const c = r.card;
  const lines = [`Links of ${t(c)}${priv(c)} (in ${c.inDegree}, out ${c.outDegree})${direction === "both" ? "" : `, ${direction} only`}:`];
  if (r.links.length === 0) lines.push("(none)");
  for (const l of r.links) lines.push(whyLine(l, l.from.id === c.id ? "out" : "in"));
  lines.push("Pointer text is the linking note's own sentence, unread — open a note with vault_note before relying on it.");
  return lines.join("\n");
}

export function formatPath(r: CommonplacePathResult, from: string, to: string, maxHops: number): string {
  if (!r.path || r.path.length === 0) return `No path within ${maxHops} hops between "${from}" and "${to}".`;
  // Steps carry the link's own direction; a `reversed` hop was walked from
  // its target back to the note that links it, and is drawn that way.
  const start = r.path[0].reversed ? r.path[0].to : r.path[0].from;
  const chain = [t(start)];
  let end = start;
  for (const s of r.path) {
    end = s.reversed ? s.from : s.to;
    chain.push(s.reversed ? `←${s.kind}— ${t(end)}` : `—${s.kind}→ ${t(end)}`);
  }
  const lines = [`Path ${t(start)} → ${t(end)} (${r.path.length} hop${r.path.length === 1 ? "" : "s"}):`, chain.join(" ")];
  const whys = r.path.filter((s) => s.why);
  if (whys.length) {
    lines.push("why (unread pointer text):");
    for (const s of whys) lines.push(`- ${t(s.from)} → ${t(s.to)}: "${s.why}"`);
  }
  return lines.join("\n");
}

export function formatNeighbourhood(r: CommonplaceNeighbourhoodResult, seeds: string[]): string {
  if (r.pool.length === 0) return `No related notes reachable from ${seeds.map((s) => `"${s}"`).join(", ")}.`;
  const lines = [`Pool around ${seeds.map((s) => `[[${s}]]`).join(", ")} (personalized PageRank, ranked):`];
  for (const p of r.pool) {
    const via = p.via ? ` via ${t(p.via.from)} —${p.via.kind}→ ${t(p.via.to)}` : "";
    lines.push(`${p.rank}. ${t(p.card)}${priv(p.card)}${via}${p.card.abstraction ? ` — ${p.card.abstraction}` : ""}`);
  }
  lines.push("Pool, not answer: read with vault_note.");
  return lines.join("\n");
}

/** One `commonplace revise log` row. */
export type LineageRow = {
  status: string;
  old: string;
  new: string;
  claim: string;
  relation?: string;
  because?: string;
  reason?: string;
  accept?: string;
  commit?: string;
};

const RELATION_WORDS: Record<string, string> = {
  supersedes: "corrected or changed by",
  bounds: "bounded by",
  contests: "contested by",
  withdrawsSupport: "lost its support in",
};

export function formatLineage(rows: readonly LineageRow[], note?: string): string {
  if (rows.length === 0) return note ? `No revisions recorded for [[${note}]].` : "No revisions recorded yet.";
  const lines = [note ? `Revision history touching [[${note}]] (newest first):` : "Recent revisions (newest first):"];
  for (const r of rows) {
    const rel = r.relation ? RELATION_WORDS[r.relation] ?? r.relation : "judged against";
    lines.push(`- ${r.status}: [[${r.old}]] claim "${r.claim}" — ${rel} [[${r.new}]]`);
    if (r.because) lines.push(`  because: ${r.because}`);
    if (r.reason) lines.push(`  note: ${r.reason}`);
    if (r.accept) lines.push(`  event ${r.accept}${r.commit ? ` · commit ${r.commit.slice(0, 10)}` : ""}`);
  }
  lines.push("Accepted entries are what the vault currently relies on; reverted and pending ones are kept for history.");
  return lines.join("\n");
}

export function formatList(r: CommonplaceListResult, what: string): string {
  if (r.items.length === 0) return `No ${what} to list.`;
  const keys = Object.keys(r.items[0]);
  const lines = [`${what} (${r.items.length}):`, keys.join(" | ")];
  for (const it of r.items) lines.push(keys.map((k) => String(it[k] ?? "")).join(" | "));
  return lines.join("\n");
}
