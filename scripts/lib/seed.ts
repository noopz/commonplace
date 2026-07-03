/**
 * Deterministic seed procedure for retrieval. `mode: "flat"` replicates the
 * pre-mixed-key baseline — grep query terms over whole JSONL index records
 * (minus the abstraction/anchors key fields, which post-date it). `mode:
 * "tiered"` matches explicit key spaces in order: abstraction → cue anchors
 * → names → gated whole-record fallback. Lexical only, by design: no
 * embeddings, no persistent vector index (CLAUDE.md "No RAG").
 */

import { relative, sep } from "node:path";
import type { SourceNote, ConceptNote, MocNote } from "./types.js";

/** Query-function words that carry no content signal. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "not", "of", "in", "on", "at", "by",
  "for", "to", "with", "from", "into", "over", "under", "about", "between",
  "across", "through", "how", "what", "which", "where", "when", "who", "why",
  "does", "do", "did", "is", "are", "was", "were", "be", "been", "it", "its",
  "this", "that", "these", "those", "there", "their", "they", "them", "than",
  "then", "also", "just", "only", "some", "any", "all", "each", "such",
  "can", "could", "should", "would", "will", "may", "might", "must",
  "have", "has", "had", "we", "you", "i", "he", "she", "his", "her", "our",
  "your", "my", "say", "says", "said", "note", "notes", "vault",
]);

/**
 * Extract deterministic key terms from a question: quoted phrases,
 * capitalized multi-word runs (proper-noun phrases), and individual
 * non-stopword words of 3+ characters. All lowercased, deduped, in
 * first-appearance order.
 */
export function extractKeyTerms(question: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const k = t.toLowerCase().trim();
    if (k.length >= 3 && !seen.has(k)) {
      seen.add(k);
      terms.push(k);
    }
  };

  for (const m of question.matchAll(/"([^"]+)"/g)) push(m[1]);
  for (const m of question.matchAll(/\b[A-Z][\w-]*(?:\s+[A-Z][\w-]*)+\b/g)) push(m[0]);
  for (const w of question.toLowerCase().replace(/[^\w\s-]/g, " ").split(/\s+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) push(w);
  }
  return terms;
}

export type SeedTier = "A" | "B" | "C" | "D";

export interface SeedHit {
  /** Path as it appears on the index record (absolute if loadIndexes resolved it) */
  path: string;
  /** Human label: source title / concept name / MOC name */
  label: string;
  kind: "source" | "concept" | "moc";
  matchedTerms: string[];
  /** Which key space matched (tiered mode only). */
  tier?: SeedTier;
  /** HITS authority of the record, when the index carries it (tiered mode). */
  authority?: number;
}

export interface SeedIndexes {
  sources: SourceNote[];
  concepts: ConceptNote[];
  mocs: MocNote[];
}

export interface SeedOptions {
  mode: "flat" | "tiered";
  /** Ablation: disable the abstraction key space (Tier A) in tiered mode. */
  skipAbstractionTier?: boolean;
  /** A–C seed count below which Tier D (whole-record grep) engages. Default 3. */
  tierDGate?: number;
  /** Order hits within each tier by authority desc (default true). Ablation: set false. */
  rankByAuthority?: boolean;
  /** Vault root for re-relativizing record paths in whole-record blobs.
   * loadIndexes absolutizes paths; the frozen baseline greps the JSONL
   * files, which store vault-relative paths — without this, machine-
   * specific absolute prefixes become greppable terms. */
  vaultPath?: string;
}

/**
 * Record serialized WITHOUT the mixed-key fields (abstraction, anchors, hub, authority):
 * the pre-mixed-key record shape a whole-record grep would have seen.
 * Both flat mode and Tier D use this, so the new key spaces are reachable
 * ONLY through their own tiers and ablations stay clean.
 */
function baselineBlob(record: object, vaultPath?: string): string {
  const { abstraction: _a, anchors: _n, hub: _h, authority: _y, ...rest } = record as Record<string, unknown>;
  if (vaultPath && typeof rest.path === "string" && rest.path.startsWith(vaultPath)) {
    const rel = relative(vaultPath, rest.path);
    rest.path = sep === "\\" ? rel.split(sep).join("/") : rel;
  }
  return JSON.stringify(rest).toLowerCase();
}

export function seedCandidates(
  terms: string[],
  indexes: SeedIndexes,
  opts: SeedOptions = { mode: "flat" },
): SeedHit[] {
  if (opts.mode !== "flat" && opts.mode !== "tiered") {
    throw new Error(`unknown seed mode: ${String(opts.mode)} (valid: flat, tiered)`);
  }
  const lowered = terms.map((t) => t.toLowerCase());
  return opts.mode === "flat" ? flatScan(lowered, indexes, opts.vaultPath) : tieredScan(lowered, indexes, opts);
}

/**
 * Flat-mode seeding: a record is a candidate if ANY term appears
 * case-insensitively in its baseline blob — the pure-function equivalent
 * of the old `Grep "<term>" .wiki/*-index.jsonl` unioned over terms.
 */
function flatScan(lowered: string[], indexes: SeedIndexes, vaultPath?: string): SeedHit[] {
  const hits: SeedHit[] = [];
  const scan = (record: object, path: string, label: string, kind: SeedHit["kind"]) => {
    const blob = baselineBlob(record, vaultPath);
    const matchedTerms = lowered.filter((t) => blob.includes(t));
    if (matchedTerms.length > 0) hits.push({ path, label, kind, matchedTerms });
  };
  for (const s of indexes.sources) scan(s, s.path, s.title, "source");
  for (const c of indexes.concepts) scan(c, c.path, c.name, "concept");
  for (const m of indexes.mocs) scan(m, m.path, m.name, "moc");
  return hits;
}

interface TierEntry {
  record: object;
  path: string;
  label: string;
  kind: SeedHit["kind"];
  abstraction: string | null;
  anchors: string[];
  title: string;
  authority: number;
}

/**
 * Tiered seeding: each record seeds at its HIGHEST matching tier only —
 * (A) abstraction, (B) cue anchors (tags + MOC memberships + outgoing
 * wikilink display texts), (C) name/title, then (D) whole-record grep
 * only when A–C produced fewer than tierDGate seeds. Hits are ordered
 * tier-first (all A, then B, then C, then D) so readers start from the
 * strongest key space.
 */
function tieredScan(lowered: string[], indexes: SeedIndexes, opts: SeedOptions): SeedHit[] {
  const gate = opts.tierDGate ?? 3;
  const entries: TierEntry[] = [
    ...indexes.sources.map((s) => ({
      record: s as object,
      path: s.path,
      label: s.title,
      kind: "source" as const,
      abstraction: s.abstraction?.toLowerCase() ?? null,
      anchors: [...s.tags, ...s.mocs, ...(s.anchors ?? [])].map((a) => a.toLowerCase()),
      title: s.title.toLowerCase(),
      authority: s.authority ?? 0,
    })),
    ...indexes.concepts.map((c) => ({
      record: c as object,
      path: c.path,
      label: c.name,
      kind: "concept" as const,
      abstraction: c.abstraction?.toLowerCase() ?? null,
      anchors: (c.anchors ?? []).map((a) => a.toLowerCase()),
      title: c.name.toLowerCase(),
      authority: c.authority ?? 0,
    })),
    ...indexes.mocs.map((m) => ({
      record: m as object,
      path: m.path,
      label: m.name,
      kind: "moc" as const,
      abstraction: null,
      anchors: [],
      title: m.name.toLowerCase(),
      authority: m.authority ?? 0,
    })),
  ];

  const rank = opts.rankByAuthority !== false;
  const hits: SeedHit[] = [];
  const taken = new Set<string>();
  const collect = (tier: SeedTier, match: (e: TierEntry) => string[]) => {
    const batch: SeedHit[] = [];
    for (const e of entries) {
      if (taken.has(e.path)) continue;
      const matchedTerms = match(e);
      if (matchedTerms.length > 0) {
        taken.add(e.path);
        batch.push({
          path: e.path,
          label: e.label,
          kind: e.kind,
          matchedTerms,
          tier,
          ...(e.authority > 0 ? { authority: e.authority } : {}),
        });
      }
    }
    if (rank) {
      // Stable sort: equal (or absent) authority keeps index order, so
      // ranking is a tie-breaker on top of the tier ordering, never a filter.
      batch.sort((a, b) => (b.authority ?? 0) - (a.authority ?? 0));
    }
    hits.push(...batch);
  };

  if (!opts.skipAbstractionTier) {
    collect("A", (e) => (e.abstraction ? lowered.filter((t) => e.abstraction!.includes(t)) : []));
  }
  collect("B", (e) => lowered.filter((t) => e.anchors.some((a) => a.includes(t))));
  collect("C", (e) => lowered.filter((t) => e.title.includes(t)));
  if (hits.length < gate) {
    collect("D", (e) => {
      const blob = baselineBlob(e.record, opts.vaultPath);
      return lowered.filter((t) => blob.includes(t));
    });
  }
  return hits;
}
