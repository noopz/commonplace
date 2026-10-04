/**
 * Parsed notes → the v2 index artefacts (plan §3). Pure: the CLI full rebuild
 * calls it with every note; tests call it with invented ones.
 *
 * Two directories, one rule (§3.0):
 *   - PUBLIC (`graph/`): nothing in it names, counts, links to or is computed
 *     over a private note. Edges from a public note into a private one point at
 *     an opaque per-shard SENTINEL id instead, which walks absorb. Cards,
 *     postings, names and scores cover public nodes only.
 *   - SEALED (`sealed/<shard>/shard.json`): each private shard's nodes, cards,
 *     names, postings, link contexts, its out-edges, and the public→private
 *     edges ("inbound") needed to splice it into the public graph when opened.
 *
 * Links are one-way (user directive): a note's shard comes from where it lives
 * (plus a note-level `scope: private`), never from who links to it.
 *
 * Ids are global, stable across rebuilds (taken from the previous manifest by
 * path) and never reused, so a journal line written against version N still
 * names the right node after a rebuild.
 */

import type { ParsedNote, NoteKind, LinkKind } from "./parse.js";
import { buildNames, type Names, type NameNode } from "../graph/resolver.js";
import { buildCsr, packCsr, KIND_INDEX, type Csr, type CsrPacked, type EdgeInput } from "../graph/csr.js";
import { hitsCsr } from "../graph/hits.js";
import { buildPostings, type PostingsInput, type PostingsRow, type TermConfig } from "./postings.js";
import { makeCard, type Card } from "./cards.js";
import { MAIN, isPrivate, shardOfDomain, type DomainMap } from "../core/scope.js";

export const INDEX_VERSION = 2;

export type IndexNote = {
  rel: string;
  parsed: ParsedNote;
  mt: number;
  sz: number;
  /** Concept is a stub (sentinel, or missing abstraction once adopted). */
  stub: boolean;
};

export type PrevIds = {
  nextId: number;
  ids: ReadonlyMap<string, number>;
  /** shard → sentinel id. */
  sentinels: ReadonlyMap<string, number>;
};

/** One link's context line (§3.2). */
export type LinkCtx = { s: number; t: number; k: LinkKind; raw: string; h: string; sent: string; n: number };

export type EdgeTuple = [from: number, to: number, kind: number, w: number];

export type FileEntry = { p: string; id: number; mt: number; sz: number };

export type ShardArtefact = {
  v: 2;
  shard: string;
  version: number;
  sentinel: number;
  nodes: number[];
  cards: Card[];
  aliases: Record<string, string[]>;
  /** Out-edges of this shard's notes. Targets in another closed shard are listed in `foreign`. */
  out: EdgeTuple[];
  /** Public → this shard edges (write-time violations, kept so an open shard shows them). */
  inbound: EdgeTuple[];
  /** Other private shards this one links into: shard → sentinel id, and node → shard. */
  foreign: { sentinels: Record<string, number>; nodes: Record<string, string> };
  names: Record<string, number[]>;
  unresolved: Record<string, number[]>;
  postings: PostingsRow[];
  linkctx: LinkCtx[];
  files: FileEntry[];
  /** Domain ids in this shard (private; never written under graph/). */
  domains: string[];
};

export type PublicArtefacts = {
  csr: CsrPacked;
  sentinels: number[];
  cards: Card[];
  aliases: Record<string, string[]>;
  postings: PostingsRow[];
  linkctx: LinkCtx[];
  names: Record<string, number[]>;
  unresolved: Record<string, number[]>;
  files: FileEntry[];
  hub: number[];
  auth: number[];
};

export type BuildOptions = {
  domains: DomainMap;
  version: number;
  builtAt: string;
  prev?: PrevIds;
  /** rel → shard: migration overrides (§4.1) — kept private though the new rule says public. */
  overrides?: ReadonlyMap<string, string>;
  /**
   * Top-level folders with unregistered notes at the first v2 index. A note
   * in no domain whose top folder is absent from this set is quarantined.
   * Undefined = first index: nothing is quarantined, the set is recorded.
   */
  knownLoose?: ReadonlySet<string>;
  /** Folders that hold concepts/MOCs — never quarantined. */
  structureDirs?: readonly string[];
  /** Postings term shape (default TERMS; `eval:search --tune` overrides it in memory). */
  terms?: TermConfig;
};

export type BuildResult = {
  public: PublicArtefacts;
  shards: Map<string, ShardArtefact>;
  /** shard → sentinel (sealed/sentinels.json). */
  sentinels: Map<string, number>;
  /** Private titles + aliases (sealed/names.json, leak-guard input). */
  privateNames: Array<{ t: string; al: string[]; shard: string }>;
  nextId: number;
  knownLoose: string[];
  /** rel → shard for every note (the CLI's legacy split uses it). */
  shardOf: Map<string, string>;
  /** Public domain ids → counts, for the manifest. */
  publicDomains: string[];
  stats: { nodes: number; edges: number; publicNodes: number; publicEdges: number };
};

const LINKCTX_SENTENCE_MAX = 200;

/** Longest registered domain path containing `rel`, or "". */
export function domainOf(domains: DomainMap, rel: string): string {
  let best = "";
  let bestLen = -1;
  for (const [id, d] of Object.entries(domains)) {
    const p = (d.path ?? "").replace(/\/+$/, "");
    if (!p) continue;
    if ((rel === p || rel.startsWith(`${p}/`)) && p.length > bestLen) {
      best = id;
      bestLen = p.length;
    }
  }
  return best;
}

const topFolder = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "");

/** Shard for one note under the one-way rule, quarantine and overrides. */
export function shardFor(
  rel: string,
  fmScope: unknown,
  opts: Pick<BuildOptions, "domains" | "overrides" | "knownLoose" | "structureDirs">,
): string {
  const ov = opts.overrides?.get(rel);
  if (ov) return ov;
  const dom = domainOf(opts.domains, rel);
  if (dom) {
    const shard = shardOfDomain(opts.domains, dom);
    if (shard === MAIN && fmScope === "private") return "loose";
    return shard;
  }
  if (fmScope === "private") return "loose";
  const top = topFolder(rel);
  if (
    opts.knownLoose &&
    top &&
    !opts.knownLoose.has(top) &&
    !(opts.structureDirs ?? []).some((d) => rel === d || rel.startsWith(`${d}/`))
  ) {
    return "quarantine";
  }
  return MAIN;
}

const isRetired = (p: ParsedNote) =>
  p.tags.some((t) => t.toLowerCase() === "retired") || /^\(retired\)/i.test(p.title);

export function buildIndex(notes: readonly IndexNote[], opts: BuildOptions): BuildResult {
  // ---- ids ----------------------------------------------------------------
  const sorted = [...notes].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  let nextId = opts.prev?.nextId ?? 0;
  const used = new Set<number>();
  const idOf = new Map<string, number>();
  for (const n of sorted) {
    const prevId = opts.prev?.ids.get(n.rel);
    if (prevId !== undefined && !used.has(prevId)) {
      idOf.set(n.rel, prevId);
      used.add(prevId);
      nextId = Math.max(nextId, prevId + 1);
    }
  }
  const prevSentinels = opts.prev?.sentinels ?? new Map<string, number>();
  for (const id of prevSentinels.values()) nextId = Math.max(nextId, id + 1);
  for (const n of sorted) if (!idOf.has(n.rel)) idOf.set(n.rel, nextId++);

  // ---- shards ---------------------------------------------------------------
  const shardOf = new Map<string, string>();
  const shardById = new Map<number, string>();
  const looseFolders = new Set<string>();
  for (const n of sorted) {
    const shard = shardFor(n.rel, n.parsed.fm.scope, opts);
    shardOf.set(n.rel, shard);
    shardById.set(idOf.get(n.rel)!, shard);
    if (!domainOf(opts.domains, n.rel) && topFolder(n.rel)) looseFolders.add(topFolder(n.rel));
  }
  const privateShards = [...new Set([...shardOf.values()].filter((s) => s !== MAIN))].sort();
  const sentinels = new Map<string, number>();
  for (const s of privateShards) {
    const prevId = prevSentinels.get(s);
    sentinels.set(s, prevId !== undefined && !used.has(prevId) ? prevId : nextId++);
  }
  const n = nextId;
  const isPub = (id: number) => shardById.get(id) === MAIN;

  // ---- names + resolution ---------------------------------------------------
  const byId = new Map<number, IndexNote>();
  const nameNodes: NameNode[] = [];
  for (const note of sorted) {
    const id = idOf.get(note.rel)!;
    byId.set(id, note);
    nameNodes.push({ id, path: note.rel, title: "", aliases: note.parsed.aliases });
  }
  const names: Names = buildNames(nameNodes);

  // ---- edges ----------------------------------------------------------------
  const allEdges: EdgeInput[] = [];
  const linkctxAll: LinkCtx[] = [];
  const unresolvedAll = new Map<string, Set<number>>();
  for (const note of sorted) {
    const s = idOf.get(note.rel)!;
    for (const l of note.parsed.links) {
      const t = names.get(l.target)?.[0];
      if (t === undefined) {
        let set = unresolvedAll.get(l.target);
        if (!set) unresolvedAll.set(l.target, (set = new Set()));
        set.add(s);
        continue;
      }
      if (t === s) continue;
      allEdges.push({ from: s, to: t, kind: l.kind, w: l.kind === "body" ? 1 : undefined });
      linkctxAll.push({
        s,
        t,
        k: l.kind,
        raw: l.raw,
        h: l.heading,
        sent: l.sentence.slice(0, LINKCTX_SENTENCE_MAX),
        n: l.n,
      });
    }
  }

  // Public graph: public→public real, public→private → sentinel.
  const pubEdges: EdgeInput[] = [];
  const shardEdges = new Map<string, { out: EdgeInput[]; inbound: EdgeInput[] }>();
  const shardBucket = (s: string) => {
    let b = shardEdges.get(s);
    if (!b) shardEdges.set(s, (b = { out: [], inbound: [] }));
    return b;
  };
  for (const e of allEdges) {
    const fs = shardById.get(e.from)!;
    const ts = shardById.get(e.to)!;
    if (fs === MAIN && ts === MAIN) pubEdges.push(e);
    else if (fs === MAIN) {
      pubEdges.push({ ...e, to: sentinels.get(ts)! });
      shardBucket(ts).inbound.push(e);
    } else shardBucket(fs).out.push(e);
  }
  const pub: Csr = buildCsr(n, pubEdges);
  const sentinelSet = new Set(sentinels.values());

  // Public-subgraph degrees and strongest neighbours (sentinel edges excluded, B8).
  const pubNeighbours = (u: number) => {
    const m = new Map<number, number>();
    for (let e = pub.outPtr[u]; e < pub.outPtr[u + 1]; e++) {
      const v = pub.outTo[e];
      if (!sentinelSet.has(v)) m.set(v, (m.get(v) ?? 0) + pub.outW[e]);
    }
    for (let e = pub.inPtr[u]; e < pub.inPtr[u + 1]; e++) {
      const v = pub.inFrom[e];
      m.set(v, (m.get(v) ?? 0) + pub.inW[e]);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([v]) => v);
  };
  const pubDeg = (u: number): [number, number] => {
    let o = 0;
    for (let e = pub.outPtr[u]; e < pub.outPtr[u + 1]; e++) if (!sentinelSet.has(pub.outTo[e])) o++;
    return [pub.inPtr[u + 1] - pub.inPtr[u], o];
  };

  // ---- cards / postings inputs ---------------------------------------------
  const mocNames = (p: ParsedNote) => p.links.filter((l) => l.kind === "moc").map((l) => l.display ?? l.raw.split("|")[0]);
  const anchorsVisible = (p: ParsedNote, visible: (t: number) => boolean) =>
    p.links
      .filter((l) => l.kind === "body" && l.display)
      .filter((l) => {
        const t = names.get(l.target)?.[0];
        return t === undefined || visible(t);
      })
      .map((l) => l.display!);
  const kindOf = (k: NoteKind): Card["k"] => k;

  const cardFor = (id: number, deg: [number, number], nb: number[]): Card => {
    const note = byId.get(id)!;
    const p = note.parsed;
    return makeCard({
      id,
      t: p.title,
      p: note.rel,
      k: kindOf(p.kind),
      d: domainOf(opts.domains, note.rel),
      a: p.abstraction,
      ...(p.abstractionFallback ? { af: 1 as const } : {}),
      deg,
      nb,
      tags: p.tags,
      stub: note.stub,
      ret: isRetired(p),
      pub: p.published,
      cr: p.created,
    });
  };
  const postingsFor = (id: number, visible: (t: number) => boolean): PostingsInput => {
    const p = byId.get(id)!.parsed;
    return {
      id,
      title: p.title,
      aliases: p.aliases,
      abstraction: p.abstractionFallback ? "" : p.abstraction,
      headings: p.headings,
      cues: p.cues,
      anchors: anchorsVisible(p, visible),
      tags: p.tags,
      mocs: mocNames(p),
    };
  };

  // ---- public artefacts -----------------------------------------------------
  const pubIds = sorted.map((x) => idOf.get(x.rel)!).filter(isPub).sort((a, b) => a - b);
  const pubCards = pubIds.map((id) => cardFor(id, pubDeg(id), pubNeighbours(id)));
  const pubAliases: Record<string, string[]> = {};
  for (const id of pubIds) {
    const al = byId.get(id)!.parsed.aliases;
    if (al.length) pubAliases[String(id)] = al;
  }
  const pubPostings = buildPostings(pubIds.map((id) => postingsFor(id, isPub)), { terms: opts.terms });
  const filterNames = (keep: (id: number) => boolean) => {
    const out: Record<string, number[]> = {};
    for (const [k, ids] of names) {
      const f = ids.filter(keep);
      if (f.length) out[k] = f;
    }
    return out;
  };
  const filterUnresolved = (keep: (id: number) => boolean) => {
    const out: Record<string, number[]> = {};
    for (const [k, ids] of [...unresolvedAll.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const f = [...ids].filter(keep).sort((a, b) => a - b);
      if (f.length) out[k] = f;
    }
    return out;
  };
  const { hub, auth } = hitsCsr(pub, { exclude: new Set([...sentinelSet, ...[...shardById.entries()].filter(([, s]) => s !== MAIN).map(([id]) => id)]) });
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const fileEntry = (note: IndexNote): FileEntry => ({ p: note.rel, id: idOf.get(note.rel)!, mt: note.mt, sz: note.sz });

  const publicArt: PublicArtefacts = {
    csr: packCsr(pub),
    sentinels: [...sentinelSet].sort((a, b) => a - b),
    cards: pubCards,
    aliases: pubAliases,
    postings: pubPostings,
    linkctx: linkctxAll.filter((c) => isPub(c.s) && isPub(c.t)),
    names: filterNames(isPub),
    unresolved: filterUnresolved(isPub),
    files: sorted.filter((x) => shardOf.get(x.rel) === MAIN).map(fileEntry),
    hub: Array.from(hub, r6),
    auth: Array.from(auth, r6),
  };

  // ---- sealed shards --------------------------------------------------------
  const shards = new Map<string, ShardArtefact>();
  const privateNames: BuildResult["privateNames"] = [];
  for (const shard of privateShards) {
    const inShard = (id: number) => shardById.get(id) === shard;
    const visibleWhenOpen = (id: number) => isPub(id) || inShard(id);
    const ids = sorted.map((x) => idOf.get(x.rel)!).filter(inShard).sort((a, b) => a - b);
    const b = shardEdges.get(shard) ?? { out: [], inbound: [] };
    const foreignSentinels: Record<string, number> = {};
    const foreignNodes: Record<string, string> = {};
    for (const e of b.out) {
      const ts = shardById.get(e.to)!;
      if (ts !== MAIN && ts !== shard) {
        foreignSentinels[ts] = sentinels.get(ts)!;
        foreignNodes[String(e.to)] = ts;
      }
    }
    const tuple = (e: EdgeInput): EdgeTuple => [e.from, e.to, KIND_INDEX[e.kind], e.w ?? 1];
    const mergeTuples = (list: EdgeInput[]) => {
      const m = new Map<string, EdgeTuple>();
      for (const e of list) {
        const t = tuple(e);
        const key = `${t[0]}:${t[1]}:${t[2]}`;
        const prev = m.get(key);
        if (prev) prev[3] += t[3];
        else m.set(key, t);
      }
      return [...m.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    };
    // Degrees as seen with this shard open: public subgraph + this shard.
    const dIn = new Map<number, number>();
    const dOut = new Map<number, number>();
    for (const e of allEdges) {
      if (!inShard(e.from) && !inShard(e.to)) continue;
      if (!visibleWhenOpen(e.from) || !visibleWhenOpen(e.to)) continue;
      dOut.set(e.from, (dOut.get(e.from) ?? 0) + 1);
      dIn.set(e.to, (dIn.get(e.to) ?? 0) + 1);
    }
    const pubDegOf = (u: number) => (isPub(u) ? pubDeg(u) : ([0, 0] as [number, number]));
    const degOpen = (u: number): [number, number] => {
      const [pi, po] = pubDegOf(u);
      return [pi + (dIn.get(u) ?? 0), po + (dOut.get(u) ?? 0)];
    };
    const aliases: Record<string, string[]> = {};
    for (const id of ids) {
      const p = byId.get(id)!.parsed;
      if (p.aliases.length) aliases[String(id)] = p.aliases;
      privateNames.push({ t: p.title, al: p.aliases, shard });
    }
    const shardDomains = Object.entries(opts.domains)
      .filter(([id, d]) => isPrivate(d) && shardOfDomain(opts.domains, id) === shard)
      .map(([id]) => id)
      .sort();
    shards.set(shard, {
      v: 2,
      shard,
      version: opts.version,
      sentinel: sentinels.get(shard)!,
      nodes: ids,
      cards: ids.map((id) => cardFor(id, degOpen(id), [])),
      aliases,
      out: mergeTuples(b.out),
      inbound: mergeTuples(b.inbound),
      foreign: { sentinels: foreignSentinels, nodes: foreignNodes },
      names: filterNames(inShard),
      unresolved: filterUnresolved(inShard),
      postings: buildPostings(ids.map((id) => postingsFor(id, visibleWhenOpen)), { terms: opts.terms }),
      linkctx: linkctxAll.filter(
        (c) => (inShard(c.s) && visibleWhenOpen(c.t)) || (isPub(c.s) && inShard(c.t)),
      ),
      files: sorted.filter((x) => shardOf.get(x.rel) === shard).map(fileEntry),
      domains: shardDomains,
    });
  }

  const publicDomains = Object.entries(opts.domains)
    .filter(([id]) => shardOfDomain(opts.domains, id) === MAIN)
    .map(([id]) => id)
    .sort();

  return {
    public: publicArt,
    shards,
    sentinels,
    privateNames,
    nextId,
    knownLoose: [...(opts.knownLoose ?? looseFolders)].sort(),
    shardOf,
    publicDomains,
    stats: {
      nodes: sorted.length,
      edges: allEdges.length,
      publicNodes: pubIds.length,
      publicEdges: pubEdges.length,
    },
  };
}
