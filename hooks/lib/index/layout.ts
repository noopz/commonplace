/**
 * On-disk layout of the v2 index (plan §3) and the pure serialiser from a
 * `BuildResult` to file contents. The CLI writes what this returns; the
 * module's loader reads the same names — one place defines both.
 *
 *   .wiki/graph/   public artefacts only
 *     manifest.json            written LAST; its version names the set
 *     main.csr.json            packed out-rows + sentinel ids
 *     names.json               key → claimants, aliases, unresolved keys
 *     scores.json              HITS over the public subgraph
 *     main.postings.jsonl      field-weighted postings
 *     cards/main.NNN.jsonl     compact note cards, CARDS_PER_CHUNK per file
 *     linkctx/main.NNN.jsonl   link contexts, LINKCTX_PER_CHUNK source ids per file
 *     files.jsonl              path → id, mtime, size (the sweep's baseline)
 *     journal.jsonl            per-file patches appended by sessions
 *   .wiki/sealed/  every private-bearing artefact
 *     manifest.json, names.json, sentinels.json, overrides.json
 *     <shard>/shard.json, <shard>/journal.jsonl
 *     legacy/<name>-index.private.jsonl
 *
 * Sandbox-safe.
 */

import { CARDS_PER_CHUNK, cardChunk, cardChunkName, type Card } from "./cards.js";
import type { BuildResult, LinkCtx } from "./model.js";
import { TERMS, termSig } from "./postings.js";

export const GRAPH_DIR = "graph";
export const SEALED_DIR = "sealed";
/** Small for the same reason as CARDS_PER_CHUNK: in-links read one chunk per source. */
export const LINKCTX_PER_CHUNK = 64;

export const P = {
  manifest: `${GRAPH_DIR}/manifest.json`,
  csr: `${GRAPH_DIR}/main.csr.json`,
  names: `${GRAPH_DIR}/names.json`,
  scores: `${GRAPH_DIR}/scores.json`,
  postings: `${GRAPH_DIR}/main.postings.jsonl`,
  files: `${GRAPH_DIR}/files.jsonl`,
  journal: `${GRAPH_DIR}/journal.jsonl`,
  lock: `${GRAPH_DIR}/.lock.d`,
  cards: (chunk: number) => `${GRAPH_DIR}/cards/${cardChunkName("main", chunk)}`,
  linkctx: (chunk: number) => `${GRAPH_DIR}/linkctx/main.${String(chunk).padStart(3, "0")}.jsonl`,
  sealedManifest: `${SEALED_DIR}/manifest.json`,
  sealedNames: `${SEALED_DIR}/names.json`,
  sentinels: `${SEALED_DIR}/sentinels.json`,
  overrides: `${SEALED_DIR}/overrides.json`,
  shard: (s: string) => `${SEALED_DIR}/${s}/shard.json`,
  shardJournal: (s: string) => `${SEALED_DIR}/${s}/journal.jsonl`,
  /** Typed maintenance records (sources, concepts, MOCs, domains, backlinks); see records.ts. */
  records: `${GRAPH_DIR}/records.jsonl`,
  shardRecords: (s: string) => `${SEALED_DIR}/${s}/records.jsonl`,
};

export type Manifest = {
  v: 2;
  version: number;
  journalSeq: number;
  writer: { kind: "cli"; at: string };
  builtAt: string;
  nextId: number;
  domains: Record<string, { shard: "main" }>;
  shards: { main: { nodes: number; edges: number } };
  /** Chunk counts, and the ids per chunk they were cut at (a reader built for another size must not use them). */
  chunks: { cards: number; linkctx: number; cardsPer: number; linkctxPer: number };
  knownLoose: string[];
  /** `termSig(TERMS)` the postings were cut with; a reader with another shape treats the index as absent. */
  terms?: string;
  /** Card/edge field schema (SCHEMA); a reader built for another treats the index as absent. */
  schema?: number;
};

/** Bump when cards or edge kinds gain fields an old artefact lacks (2: dates on cards, `contests` edges). */
export const SCHEMA = 2;

export type NamesFile = {
  v: 2;
  version: number;
  names: Record<string, number[]>;
  aliases: Record<string, string[]>;
  unresolved: Record<string, number[]>;
};

export type CsrFile = { v: 2; version: number; sentinels: number[] } & BuildResult["public"]["csr"];

export const linkctxChunk = (sourceId: number) => Math.floor(sourceId / LINKCTX_PER_CHUNK);

const jsonl = (rows: readonly unknown[]) => (rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");

/** Every public and sealed artefact of a build, keyed by `.wiki`-relative path. Manifest is listed LAST. */
export function serializeIndex(r: BuildResult, meta: { version: number; builtAt: string }): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const pub = r.public;
  const v = meta.version;

  const csr: CsrFile = { v: 2, version: v, sentinels: pub.sentinels, ...pub.csr };
  out.push([P.csr, JSON.stringify(csr)]);
  const names: NamesFile = { v: 2, version: v, names: pub.names, aliases: pub.aliases, unresolved: pub.unresolved };
  out.push([P.names, JSON.stringify(names)]);
  out.push([P.scores, JSON.stringify({ v: 2, version: v, hub: pub.hub, auth: pub.auth })]);
  out.push([P.postings, jsonl(pub.postings)]);
  out.push([P.files, jsonl(pub.files)]);

  const cardChunks = new Map<number, Card[]>();
  for (const c of pub.cards) {
    const k = cardChunk(c.id);
    let list = cardChunks.get(k);
    if (!list) cardChunks.set(k, (list = []));
    list.push(c);
  }
  const nCardChunks = Math.ceil(r.nextId / CARDS_PER_CHUNK);
  for (let k = 0; k < nCardChunks; k++) out.push([P.cards(k), jsonl(cardChunks.get(k) ?? [])]);

  const ctxChunks = new Map<number, LinkCtx[]>();
  for (const c of pub.linkctx) {
    const k = linkctxChunk(c.s);
    let list = ctxChunks.get(k);
    if (!list) ctxChunks.set(k, (list = []));
    list.push(c);
  }
  const nCtxChunks = Math.ceil(r.nextId / LINKCTX_PER_CHUNK);
  for (let k = 0; k < nCtxChunks; k++) out.push([P.linkctx(k), jsonl(ctxChunks.get(k) ?? [])]);

  // Sealed.
  for (const [shard, art] of r.shards) out.push([P.shard(shard), JSON.stringify(art)]);
  out.push([P.sealedNames, JSON.stringify({ v: 2, version: v, names: r.privateNames })]);
  out.push([P.sentinels, JSON.stringify({ v: 2, version: v, sentinels: Object.fromEntries(r.sentinels) })]);
  out.push([
    P.sealedManifest,
    JSON.stringify({
      v: 2,
      version: v,
      shards: Object.fromEntries(
        [...r.shards].map(([s, a]) => [s, { nodes: a.nodes.length, domains: a.domains, sentinel: a.sentinel }]),
      ),
    }),
  ]);

  // Journal restarts at the compacted marker for this version.
  out.push([P.journal, JSON.stringify({ v: 2, op: "compacted", version: v }) + "\n"]);

  const manifest: Manifest = {
    v: 2,
    version: v,
    journalSeq: 0,
    writer: { kind: "cli", at: meta.builtAt },
    builtAt: meta.builtAt,
    nextId: r.nextId,
    domains: Object.fromEntries(r.publicDomains.map((d) => [d, { shard: "main" as const }])),
    shards: { main: { nodes: r.stats.publicNodes, edges: r.stats.publicEdges } },
    chunks: { cards: nCardChunks, linkctx: nCtxChunks, cardsPer: CARDS_PER_CHUNK, linkctxPer: LINKCTX_PER_CHUNK },
    knownLoose: r.knownLoose,
    terms: termSig(TERMS),
    schema: SCHEMA,
  };
  // Key order is fixed so `head -c 256` yields `{"v":2,"version":N,"journalSeq":S,`.
  out.push([P.manifest, JSON.stringify(manifest)]);
  return out;
}

/** Cheap version probe on the first bytes of manifest.json (§3.5). */
export function peekManifestVersion(head: string): { version: number; journalSeq: number } | null {
  const m = /^\{"v":2,"version":(\d+),"journalSeq":(\d+),/.exec(head);
  return m ? { version: Number(m[1]), journalSeq: Number(m[2]) } : null;
}
