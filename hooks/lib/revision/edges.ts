/**
 * Claim-scoped revision edges (docs/revision-design.md, "Accepted edges").
 *
 * Frontmatter on the NEWER note names the older note it revises, the exact
 * claim, why, and — for `bounds` — the conditions it holds within:
 *
 *   supersedes:
 *     - note: "[[Acme Study 2026]]"
 *       claim: "reaches 71% on BenchX"
 *       because: "…"
 *       kind: correction            # or world-change (+ effective: 2026-06-01)
 *   bounds:            [{ note, claim, within, because }]
 *   contests:          [{ note, claim, because }]
 *   withdraws_support: [{ note, claim, because }]
 *
 * The plain form `supersedes: ["[[X]]"]` stays valid: a whole-note edge with
 * no reason. Sandbox-safe: the module, the index and the CLI share it.
 */

import type { YamlValue } from "../index/yaml.ts";

export type RevisionRelation = "supersedes" | "bounds" | "contests" | "withdrawsSupport";
export const REVISION_RELATIONS: readonly RevisionRelation[] = ["supersedes", "bounds", "contests", "withdrawsSupport"];

/** Frontmatter keys per relation; the first is what the reducer writes. */
export const RELATION_KEYS: Record<RevisionRelation, string[]> = {
  supersedes: ["supersedes"],
  bounds: ["bounds"],
  contests: ["contests"],
  withdrawsSupport: ["withdraws_support", "withdraws-support", "withdrawsSupport"],
};

export type EdgeRel = {
  claim?: string;
  because?: string;
  within?: string;
  /** `supersedes` only. */
  kind?: "correction" | "world-change";
  /** `supersedes` with kind world-change only: YYYY, YYYY-MM or YYYY-MM-DD. */
  effective?: string;
};

export type FmEdge = { inner: string; rel?: EdgeRel };

const str = (v: YamlValue | undefined): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  return undefined;
};

/** A wikilink's inner text from a frontmatter value: `"[[X]]"`, or the nested list an unquoted `[[X]]` parses to. */
function linkInner(v: YamlValue | undefined): string | null {
  if (typeof v === "string") {
    const m = /\[\[([^\[\]]+)\]\]/.exec(v);
    return m ? m[1] : null;
  }
  if (Array.isArray(v) && v.length === 1) {
    const inner = Array.isArray(v[0]) && v[0].length === 1 ? v[0][0] : v[0];
    return typeof inner === "string" ? inner : null;
  }
  return null;
}

/**
 * Every edge a frontmatter link field names. Strings (one or several links),
 * unquoted nested lists, and mapping items with `note:` — the last is what the
 * old parser dropped silently.
 */
export function fmEdges(v: YamlValue | undefined): FmEdge[] {
  if (typeof v === "string") return [...v.matchAll(/\[\[([^\[\]]+)\]\]/g)].map((m) => ({ inner: m[1] }));
  if (!Array.isArray(v)) {
    if (v && typeof v === "object") return fmEdges([v]);
    return [];
  }
  const out: FmEdge[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(...fmEdges(item));
    else if (Array.isArray(item)) {
      const inner = linkInner(item);
      if (inner) out.push({ inner });
    } else if (item && typeof item === "object") {
      const m = item as Record<string, YamlValue>;
      const inner = linkInner(m.note);
      if (!inner) continue;
      const kind = str(m.kind);
      const rel: EdgeRel = {
        ...(str(m.claim) ? { claim: str(m.claim) } : {}),
        ...(str(m.because) ? { because: str(m.because) } : {}),
        ...(str(m.within) ? { within: str(m.within) } : {}),
        ...(kind === "correction" || kind === "world-change" ? { kind } : {}),
        ...(str(m.effective) ? { effective: str(m.effective) } : {}),
      };
      out.push(Object.keys(rel).length ? { inner, rel } : { inner });
    }
  }
  return out;
}

/** Lowercased, whitespace-collapsed title key of a wikilink inner (`X#h|d` → `x`). */
export function targetKey(inner: string): string {
  return inner.split("|")[0].split("#")[0].trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Identity of one edge: the newer note, the relation, the older note and the
 * claim. Whole-note edges have an empty claim.
 */
export function edgeKey(fromRel: string, relation: RevisionRelation, toTitle: string, claim?: string): string {
  return [fromRel, relation, targetKey(toTitle), (claim ?? "").replace(/\s+/g, " ").trim()].join("\u001f");
}

/** Where a quoted claim sits in a note body: the one match, or why not. */
export function locateClaim(body: string, claim: string): { at: number } | { error: "missing" | "ambiguous" | "empty" } {
  const c = claim.trim();
  if (!c) return { error: "empty" };
  const norm = (s: string) => s.replace(/\s+/g, " ");
  const b = norm(body);
  const q = norm(c);
  const first = b.indexOf(q);
  if (first === -1) return { error: "missing" };
  if (b.indexOf(q, first + 1) !== -1) return { error: "ambiguous" };
  return { at: first };
}

// ------------------------------------------------------------------ status

/** One revision status of a note, as the reader sees it. */
export type RevisionStatus = {
  relation: RevisionRelation;
  /** Title of the newer note that carries the edge. */
  by: string;
  rel?: EdgeRel;
  /** Accepted by the reducer (autonomous mode); false = unreviewed. */
  reviewed: boolean;
  /** The edge's claim no longer occurs in this note's body. */
  claimMissing?: boolean;
};

const q = (s: string) => `"${s.replace(/\s+/g, " ").trim()}"`;

/**
 * The status line for one status, worded per relation (design: bounds says
 * only where the claim is supported; a world change is a change, not a
 * correction; lost support is not refutation). Status comes BEFORE any date.
 */
export function statusLine(s: RevisionStatus): string {
  const by = `[[${s.by}]]`;
  const r = s.rel ?? {};
  const claim = r.claim ? `claim ${q(r.claim)} ` : "";
  const why = r.because ? `: ${r.because}` : r.claim ? "" : " (no reason recorded)";
  const tail = [
    s.claimMissing ? "the quoted claim is no longer in this note" : "",
    s.reviewed ? "" : "unreviewed",
  ].filter(Boolean);
  const suffix = tail.length ? ` [${tail.join("; ")}]` : "";
  switch (s.relation) {
    case "supersedes":
      if (r.kind === "world-change") {
        const eff = r.effective ? ` (effective ${r.effective})` : "";
        return `⚠ ${claim}changed in ${by}${eff}${why} — the earlier state stays true for its period${suffix}`;
      }
      if (!r.claim) return `⚠ superseded by ${by}${why} — kept for history; read the newer note before relying on this one${suffix}`;
      return `⚠ ${claim}corrected by ${by}${why}${suffix}`;
    case "bounds":
      return `⚠ ${claim}supported within ${r.within ? q(r.within) : "the conditions in"} ${by}${why}${suffix}`;
    case "contests":
      return `⚠ ${claim || ""}contested by ${by}${why} — read both before relying on either${suffix}`;
    case "withdrawsSupport":
      return `⚠ ${claim}lost its support in ${by}${why} — not shown false, only unsupported${suffix}`;
  }
}

// ---------------------------------------------------------- serialisation

const yq = (s: string) => JSON.stringify(s.replace(/\r?\n/g, " ").trim());

/** YAML lines for one mapping item under a relation key, indented by `pad`. */
export function edgeItemYaml(toTitle: string, rel: EdgeRel, pad = "  "): string[] {
  const lines = [`${pad}- note: ${yq(`[[${toTitle}]]`)}`];
  const inner = pad + "  ";
  if (rel.claim) lines.push(`${inner}claim: ${yq(rel.claim)}`);
  if (rel.within) lines.push(`${inner}within: ${yq(rel.within)}`);
  if (rel.because) lines.push(`${inner}because: ${yq(rel.because)}`);
  if (rel.kind) lines.push(`${inner}kind: ${rel.kind}`);
  if (rel.effective) lines.push(`${inner}effective: ${yq(rel.effective)}`);
  return lines;
}
