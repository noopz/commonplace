/**
 * Connect pool assembly — the shared core behind `commonplace connect` and the
 * connect eval. Pure and file-I/O-free (records come in already vault-relative)
 * so it is unit-testable and both callers rank identically.
 *
 * Pipeline: build the weighted content graph, seed a Personalized PageRank walk
 * (from a note and/or a query's top lexical matches), then rank every note by
 * the gentle additive gate  norm(PPR) + lambda * norm(lexical)  and return the
 * top-k pool. See scripts/connect.ts for the score rationale.
 */

import type { SourceNote, ConceptNote, MocNote } from "./types.js";
import { buildContentGraph, personalizedPageRank, type BacklinkRecord } from "./ppr.js";
import { lexicalScores, topLexicalSeeds, type LexNode } from "./lexical.js";

export interface ConnectInput {
  sources: SourceNote[];
  concepts: ConceptNote[];
  mocs: MocNote[];
  backlinks?: BacklinkRecord[];
}

export interface ConnectOptions {
  query?: string;
  /** Vault-relative path to seed the walk from a specific note. */
  note?: string;
  k?: number;
  lambda?: number;
  alpha?: number;
  seedK?: number;
}

export interface ConnectCandidate {
  path: string;
  title: string;
  kind: "source" | "concept" | "moc";
  abstraction: string | null;
  ppr: number;
  lex: number;
  score: number;
}

export interface ConnectResult {
  candidates: ConnectCandidate[];
  /** Seed notes excluded from the pool (the --note seeds). */
  seedNotes: string[];
}

interface Meta {
  title: string;
  kind: ConnectCandidate["kind"];
  abstraction: string | null;
}

export const DEFAULT_CONNECT_OPTIONS: Required<Omit<ConnectOptions, "query" | "note">> = {
  k: 20,
  lambda: 0.25,
  alpha: 0.85,
  seedK: 5,
};

export function connectPool(input: ConnectInput, opts: ConnectOptions): ConnectResult {
  const { k, lambda, alpha, seedK } = { ...DEFAULT_CONNECT_OPTIONS, ...opts };
  const adj = buildContentGraph(input);

  const meta = new Map<string, Meta>();
  const lexNodes: LexNode[] = [];
  for (const s of input.sources) {
    meta.set(s.path, { title: s.title, kind: "source", abstraction: s.abstraction ?? null });
    lexNodes.push({ path: s.path, text: [s.title, s.abstraction ?? "", (s.tags ?? []).join(" "), (s.anchors ?? []).join(" ")].join(" ") });
  }
  for (const c of input.concepts) {
    meta.set(c.path, { title: c.name, kind: "concept", abstraction: c.abstraction ?? null });
    lexNodes.push({ path: c.path, text: [c.name, c.abstraction ?? "", (c.anchors ?? []).join(" ")].join(" ") });
  }
  for (const m of input.mocs) {
    meta.set(m.path, { title: m.name, kind: "moc", abstraction: null });
    lexNodes.push({ path: m.path, text: m.name });
  }

  const lex = opts.query ? lexicalScores(opts.query, lexNodes) : new Map<string, number>();
  const personalization = new Map<string, number>();
  const seedNotes: string[] = [];
  if (opts.note) {
    if (!meta.has(opts.note)) throw new Error(`--note "${opts.note}" is not an indexed note`);
    personalization.set(opts.note, 1);
    seedNotes.push(opts.note);
  }
  if (opts.query) {
    for (const [n, w] of topLexicalSeeds(lex, seedK)) {
      personalization.set(n, (personalization.get(n) ?? 0) + w);
    }
  }

  const ppr = personalizedPageRank(adj, personalization, { alpha });
  const maxPpr = Math.max(1e-12, ...ppr.values());
  const maxLex = Math.max(1, ...lex.values());
  const seedSet = new Set(seedNotes);

  const candidates: ConnectCandidate[] = [...meta.keys()]
    .filter((p) => !seedSet.has(p))
    .map((p) => {
      const pprRaw = ppr.get(p) ?? 0;
      const lexRaw = lex.get(p) ?? 0;
      const m = meta.get(p)!;
      return {
        path: p,
        title: m.title,
        kind: m.kind,
        abstraction: m.abstraction,
        ppr: pprRaw,
        lex: lexRaw,
        score: pprRaw / maxPpr + lambda * (lexRaw / maxLex),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return { candidates, seedNotes };
}
