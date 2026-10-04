/**
 * The in-memory vault graph a session serves from (plan §2.3a, §3.9).
 *
 *   base       the public CSR as the CLI last wrote it (immutable)
 *   + shards   private shards THIS session has open, spliced in
 *   + patches  per-file upserts/deletes from the journal and this session
 *   = view     an `Adjacency` the walks, paths and link listings run over
 *
 * Nothing here rewrites artefacts: the CLI is the single writer (§3.10). A
 * patch only changes in-memory rows; durability is the journal line the
 * caller appends. The overlay is recomputed from (base, open shards, patches)
 * whenever one of them changes, so opening/closing a shard and replaying the
 * journal compose without order bugs.
 *
 * Visibility is structural: a sealed note is simply absent (no card, no
 * names, no rows); a link from a visible note into a sealed one points at that
 * shard's sentinel, which callers treat as absorbing and never display.
 *
 * Known approximations, all repaired by the next full rebuild/compaction:
 * a patched-in name does not steal a key from an existing better claimant
 * across the total order, and links that start resolving because of a patch
 * are added as single body links.
 *
 * Sandbox-safe.
 */

import { type Csr, type Adjacency, type EdgeKind, KIND_INDEX, KIND_WEIGHT, EDGE_KINDS } from "../graph/csr.js";
import { stemOf, normalizeKey, type Names } from "../graph/resolver.js";
import { makeCard, type Card } from "./cards.js";
import { noteTerms, queryKeys, keyScore, rankHits, authorityPrior, TERMS, RANK, type PostingsRow, type TermConfig, type RankConfig } from "./postings.js";
import { domainOf, type ShardArtefact } from "./model.js";
import type { JournalNote } from "./journal.js";
import { MAIN, type DomainMap } from "../core/scope.js";

type Row = { v: number; w: number; k: number };

export type Patch = { rel: string; note: JournalNote | null };

export type ViewInput = {
  base: Csr;
  sentinels: readonly number[];
  names: Record<string, number[]>;
  aliases: Record<string, string[]>;
  unresolved: Record<string, number[]>;
  postings: readonly PostingsRow[];
  files: ReadonlyArray<{ p: string; id: number }>;
  nextId: number;
  domains: DomainMap;
  hub?: ArrayLike<number>;
  auth?: ArrayLike<number>;
  /** Term shape the postings were built with (eval only; the loader checks the manifest). */
  terms?: TermConfig;
  rank?: RankConfig;
};

export type SearchHit = { id: number; score: number; matched: string[] };

export class VaultView implements Adjacency {
  n: number;
  readonly base: Csr;
  readonly sentinels: Set<number>;
  readonly domains: DomainMap;
  readonly hub?: ArrayLike<number>;
  readonly auth?: ArrayLike<number>;
  readonly terms: TermConfig;
  rank: RankConfig;
  /** HITS authority as a [0, 1] prior; patched notes absent from the base get 0. */
  private readonly authPrior?: (id: number) => number;

  private baseNames: Map<string, number[]>;
  private baseAliases: Map<number, string[]>;
  private baseUnresolved: Map<string, number[]>;
  private basePostings: Map<string, PostingsRow>;
  private baseN: number;
  private baseRel = new Map<string, number>();
  private baseRelOf = new Map<number, string>();
  private nextId: number;

  /** Base cards, filled chunk by chunk by the loader. */
  readonly baseCards = new Map<number, Card>();

  private shards = new Map<string, ShardArtefact>();
  private patches = new Map<string, { id: number; note: JournalNote | null }>();
  /** Ids handed to notes absent from the base, stable for the session across replays. */
  private assigned = new Map<string, number>();

  // ---- derived (recomputed by refresh) ----
  names: Names = new Map();
  private relToId = new Map<string, number>();
  private relOf = new Map<number, string>();
  private deleted = new Set<number>();
  private outOv = new Map<number, Row[]>();
  private inAdd = new Map<number, Row[]>();
  private cardOv = new Map<number, Card>();
  private shardOf = new Map<number, string>();
  private postOv = new Map<number, Map<string, number>>();
  private wdegCache = new Map<number, number>();
  private shardPostings = new Map<string, PostingsRow>();
  private shardN = 0;

  constructor(inp: ViewInput) {
    this.base = inp.base;
    this.n = Math.max(inp.base.n, inp.nextId);
    this.nextId = inp.nextId;
    this.sentinels = new Set(inp.sentinels);
    this.domains = inp.domains;
    this.hub = inp.hub;
    this.auth = inp.auth;
    this.authPrior = authorityPrior(inp.auth);
    this.terms = inp.terms ?? TERMS;
    this.rank = inp.rank ?? RANK;
    this.baseNames = new Map(Object.entries(inp.names));
    this.baseAliases = new Map(Object.entries(inp.aliases).map(([k, v]) => [Number(k), v]));
    this.baseUnresolved = new Map(Object.entries(inp.unresolved));
    this.basePostings = new Map(inp.postings.map((r) => [r.t, r]));
    this.baseN = inp.files.length;
    for (const f of inp.files) {
      this.baseRel.set(f.p, f.id);
      this.baseRelOf.set(f.id, f.p);
    }
    this.refresh();
  }

  // ------------------------------------------------------------------ scope

  openShard(art: ShardArtefact): void {
    this.shards.set(art.shard, art);
    this.refresh();
  }

  closeShard(shard: string): void {
    if (this.shards.delete(shard)) this.refresh();
  }

  openShardNames(): string[] {
    return [...this.shards.keys()].sort();
  }

  // ---------------------------------------------------------------- patches

  /** Apply upserts/deletes (journal replay or a local write). Returns ids touched. */
  applyPatches(list: readonly Patch[]): number[] {
    const ids: number[] = [];
    for (const p of list) {
      let id = this.patches.get(p.rel)?.id ?? this.relToId.get(p.rel) ?? this.assigned.get(p.rel);
      if (id === undefined) {
        if (p.note === null) continue;
        id = this.nextId++;
        this.assigned.set(p.rel, id);
        this.n = Math.max(this.n, this.nextId);
      }
      this.patches.set(p.rel, { id, note: p.note });
      ids.push(id);
    }
    if (ids.length) this.refresh();
    return ids;
  }

  /** Replace every patch (a full journal replay, in file order). */
  setPatches(list: readonly Patch[]): void {
    this.patches.clear();
    if (!this.applyPatches(list).length) this.refresh();
  }

  patchCount(): number {
    return this.patches.size;
  }

  idOfRel(rel: string): number | undefined {
    const id = this.relToId.get(rel);
    return id !== undefined && !this.deleted.has(id) ? id : undefined;
  }

  relOfId(id: number): string | undefined {
    return this.relOf.get(id);
  }

  /** True when the note is visible to this session (not sealed, not deleted, not a sentinel). */
  visible(id: number): boolean {
    return !this.sentinels.has(id) && !this.deleted.has(id) && this.relOf.has(id);
  }

  /** Shard of a visible node: "main" or the open private shard it came from. */
  shard(id: number): string {
    return this.shardOf.get(id) ?? MAIN;
  }

  // -------------------------------------------------------------- resolving

  /** Resolve a title, alias, `[[link]]` or vault-relative path to a visible id. */
  resolve(ref: string): number | null {
    let r = String(ref ?? "").trim();
    const m = /^\[\[([^\]]+)\]\]$/.exec(r);
    if (m) r = m[1];
    const asPath = r.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (asPath.toLowerCase().endsWith(".md")) {
      const id = this.relToId.get(asPath);
      if (id !== undefined && this.visible(id)) return id;
      // Tolerate an absolute path or a missing folder prefix.
      for (const [rel, rid] of this.relToId) {
        if ((asPath.endsWith(`/${rel}`) || rel.endsWith(`/${asPath}`)) && this.visible(rid)) return rid;
      }
    }
    const key = normalizeKey(r);
    if (!key) return null;
    for (const id of this.names.get(key) ?? []) if (this.visible(id)) return id;
    return null;
  }

  // ------------------------------------------------------------- adjacency

  eachOut(u: number, cb: (v: number, w: number, kindIdx: number) => void): void {
    if (this.deleted.has(u)) return;
    const ov = this.outOv.get(u);
    if (ov) {
      for (const r of ov) if (!this.deleted.has(r.v)) cb(r.v, r.w, r.k);
      return;
    }
    if (u >= this.base.n) return;
    const g = this.base;
    for (let e = g.outPtr[u]; e < g.outPtr[u + 1]; e++) {
      const v = g.outTo[e];
      if (!this.deleted.has(v)) cb(v, g.outW[e], g.outKind[e]);
    }
  }

  eachIn(u: number, cb: (v: number, w: number, kindIdx: number) => void): void {
    if (this.deleted.has(u)) return;
    if (u < this.base.n) {
      const g = this.base;
      for (let e = g.inPtr[u]; e < g.inPtr[u + 1]; e++) {
        const s = g.inFrom[e];
        if (this.outOv.has(s) || this.deleted.has(s)) continue;
        cb(s, g.inW[e], g.inKind[e]);
      }
    }
    for (const r of this.inAdd.get(u) ?? []) cb(r.v, r.w, r.k);
  }

  wdegOf(u: number): number {
    if (this.outOv.size === 0 && this.deleted.size === 0) return u < this.base.n ? this.base.wdeg[u] : 0;
    let d = this.wdegCache.get(u);
    if (d === undefined) {
      d = 0;
      const add = (_v: number, w: number) => {
        d! += w;
      };
      this.eachOut(u, add);
      this.eachIn(u, add);
      this.wdegCache.set(u, d);
    }
    return d;
  }

  degOf(u: number): number {
    let d = 0;
    const add = () => {
      d++;
    };
    this.eachOut(u, add);
    this.eachIn(u, add);
    return d;
  }

  /** Visible links of `u` (sentinel and deleted ends dropped silently). */
  links(u: number, dir: "out" | "in" | "both" = "both"): Array<{ id: number; w: number; kind: EdgeKind; dir: "out" | "in" }> {
    const res: Array<{ id: number; w: number; kind: EdgeKind; dir: "out" | "in" }> = [];
    if (dir !== "in") this.eachOut(u, (v, w, k) => this.visible(v) && res.push({ id: v, w, kind: EDGE_KINDS[k], dir: "out" }));
    if (dir !== "out") this.eachIn(u, (v, w, k) => this.visible(v) && res.push({ id: v, w, kind: EDGE_KINDS[k], dir: "in" }));
    return res;
  }

  // ------------------------------------------------------------------ cards

  card(id: number): Card | undefined {
    if (!this.visible(id)) return undefined;
    return this.cardOv.get(id) ?? this.baseCards.get(id);
  }

  /** Card chunks the loader must read before `card(id)` can answer. */
  missingCards(ids: readonly number[]): number[] {
    return ids.filter((id) => this.visible(id) && !this.cardOv.has(id) && !this.baseCards.has(id));
  }

  // ----------------------------------------------------------------- search

  /**
   * Field-weighted search over the visible notes: base postings (minus
   * patched/deleted docs) + open shard postings + patched docs, scored
   * exactly as `searchPostings` (key scores, phrase boost, coverage).
   */
  search(query: string, opts: { limit?: number; filter?: (id: number) => boolean; rank?: RankConfig } = {}): SearchHit[] {
    const limit = opts.limit ?? 8;
    const r = opts.rank ?? this.rank;
    const q = queryKeys(query, this.terms);
    const N = this.baseN + this.shardN;
    const acc = new Map<number, { score: number; matched: string[] }>();
    const run = (t: string, mul: number, word: boolean) => {
      if (!(mul > 0)) return;
      const b = this.basePostings.get(t);
      const s = this.shardPostings.get(t);
      let ovDf = 0;
      for (const m of this.postOv.values()) if (m.has(t)) ovDf++;
      const df = (b?.df ?? 0) + (s?.df ?? 0) + ovDf;
      if (df === 0) return;
      const add = (id: number, fs: number) => {
        if (!this.visible(id) || (opts.filter && !opts.filter(id))) return;
        if (!word && !acc.has(id)) return; // a phrase only boosts a note a word already found
        const a = acc.get(id) ?? { score: 0, matched: [] };
        a.score += mul * keyScore(fs, df, N, r);
        if (word && !a.matched.includes(t)) a.matched.push(t);
        acc.set(id, a);
      };
      for (const [id, fs] of b?.n ?? []) if (!this.postOv.has(id)) add(id, fs);
      for (const [id, fs] of s?.n ?? []) if (!this.postOv.has(id)) add(id, fs);
      for (const [id, m] of this.postOv) {
        const fs = m.get(t);
        if (fs) add(id, fs);
      }
    };
    for (const t of q.words) run(t, 1, true);
    for (const t of q.phrases) run(t, r.phrase, false);
    return rankHits(acc, q.words.length, r, limit, 0, this.authPrior);
  }

  // --------------------------------------------------------------- refresh

  private refresh(): void {
    this.wdegCache.clear();
    // Names: base + open shards (shard claimants after public ones).
    // Shallow copy: claimant arrays are replaced, never mutated in place.
    const names = new Map<string, number[]>(this.baseNames);
    this.relToId = new Map(this.baseRel);
    this.relOf = new Map(this.baseRelOf);
    this.shardOf = new Map();
    this.cardOv = new Map();
    this.shardPostings = new Map();
    this.shardN = 0;
    const unresolved = new Map<string, Set<number>>();
    for (const [k, ids] of this.baseUnresolved) unresolved.set(k, new Set(ids));
    const outOv = new Map<number, Row[]>();
    const baseRow = (u: number): Row[] => {
      const rows: Row[] = [];
      if (u < this.base.n) {
        for (let e = this.base.outPtr[u]; e < this.base.outPtr[u + 1]; e++) {
          rows.push({ v: this.base.outTo[e], w: this.base.outW[e], k: this.base.outKind[e] });
        }
      }
      return rows;
    };

    for (const art of this.shards.values()) {
      for (const [k, ids] of Object.entries(art.names)) names.set(k, [...(names.get(k) ?? []), ...ids]);
      for (const f of art.files) {
        this.relToId.set(f.p, f.id);
        this.relOf.set(f.id, f.p);
      }
      for (const id of art.nodes) this.shardOf.set(id, art.shard);
      for (const c of art.cards) this.cardOv.set(c.id, c);
      for (const [k, ids] of Object.entries(art.unresolved)) {
        const s = unresolved.get(k) ?? new Set<number>();
        for (const id of ids) s.add(id);
        unresolved.set(k, s);
      }
      for (const r of art.postings) {
        const prev = this.shardPostings.get(r.t);
        this.shardPostings.set(r.t, prev ? { t: r.t, df: prev.df + r.df, n: [...prev.n, ...r.n] } : r);
      }
      this.shardN += art.nodes.length;
    }
    for (const art of this.shards.values()) {
      const redirect = (to: number) => {
        const fs = art.foreign.nodes[String(to)];
        if (fs && !this.shards.has(fs)) return art.foreign.sentinels[fs];
        return to;
      };
      for (const [from, to, k, w] of art.out) {
        let row = outOv.get(from);
        if (!row) outOv.set(from, (row = []));
        row.push({ v: redirect(to), w, k });
      }
      // Splice public → this shard: drop the sentinel edge, add the real ones.
      const byFrom = new Map<number, Row[]>();
      for (const [from, to, k, w] of art.inbound) {
        let r = byFrom.get(from);
        if (!r) byFrom.set(from, (r = []));
        r.push({ v: to, w, k });
      }
      for (const [from, extra] of byFrom) {
        const cur = outOv.get(from) ?? baseRow(from);
        outOv.set(from, [...cur.filter((r) => r.v !== art.sentinel), ...extra]);
      }
    }

    // Patches.
    this.deleted = new Set();
    this.postOv = new Map();
    const patchedIds = new Set<number>();
    for (const [rel, { id }] of this.patches) {
      patchedIds.add(id);
      // Remove the keys this id held (stem + aliases); the patch re-adds its own.
      const held = [stemOf(this.relOf.get(id) ?? rel), ...(this.baseAliases.get(id) ?? [])];
      for (const art of this.shards.values()) held.push(...(art.aliases[String(id)] ?? []));
      for (const raw of held) {
        const k = raw.trim().toLowerCase();
        const ids = names.get(k);
        if (!ids || !ids.includes(id)) continue;
        const f = ids.filter((x) => x !== id);
        if (f.length) names.set(k, f);
        else names.delete(k);
      }
      this.relToId.set(rel, id);
      this.relOf.set(id, rel);
    }
    const addedKeys: Array<[string, number]> = [];
    for (const [rel, { id, note }] of this.patches) {
      if (note === null) {
        this.deleted.add(id);
        continue;
      }
      const claim = (raw: string, front: boolean) => {
        const k = raw.trim().toLowerCase();
        if (!k) return;
        const cur = names.get(k) ?? [];
        if (cur.includes(id)) return;
        names.set(k, front ? [id, ...cur] : [...cur, id]);
        addedKeys.push([k, id]);
      };
      claim(stemOf(rel), true);
      for (const a of note.aliases) claim(a, false);
    }
    this.names = names;

    const visibleNow = (id: number) => !this.sentinels.has(id) && !this.deleted.has(id) && this.relOf.has(id);
    for (const [rel, { id, note }] of this.patches) {
      if (note === null) continue;
      const row = new Map<string, Row>();
      for (const l of note.links) {
        const t = (names.get(l.t) ?? []).find(visibleNow);
        if (t === undefined || t === id) continue;
        const k = KIND_INDEX[l.k];
        const key = `${t}:${k}`;
        const w = l.k === "body" ? 1 : KIND_WEIGHT[l.k];
        const r = row.get(key);
        if (r) r.w += w;
        else row.set(key, { v: t, w, k });
      }
      outOv.set(id, [...row.values()].sort((a, b) => a.v - b.v || a.k - b.k));
      this.shardOf.set(id, this.shardOf.get(id) ?? MAIN);
      // Card + postings for the patched note.
      this.postOv.set(
        id,
        noteTerms({
          id,
          title: note.title,
          aliases: note.aliases,
          abstraction: note.af ? "" : note.abstraction,
          headings: note.headings,
          cues: note.cues,
          anchors: note.links.filter((l) => l.k === "body" && l.d).map((l) => l.d!),
          tags: note.tags,
          mocs: note.links.filter((l) => l.k === "moc").map((l) => l.d ?? l.t),
        }, this.terms),
      );
    }
    // Links waiting on a key a patch just claimed start resolving.
    for (const [k, id] of addedKeys) {
      for (const s of unresolved.get(k) ?? []) {
        if (s === id || patchedIds.has(s)) continue;
        const row = outOv.get(s) ?? baseRow(s);
        if (!row.some((r) => r.v === id)) row.push({ v: id, w: 1, k: KIND_INDEX.body });
        outOv.set(s, row);
      }
    }
    for (const id of this.deleted) this.postOv.set(id, new Map());

    this.outOv = outOv;
    const inAdd = new Map<number, Row[]>();
    for (const [from, rows] of outOv) {
      for (const r of rows) {
        let list = inAdd.get(r.v);
        if (!list) inAdd.set(r.v, (list = []));
        list.push({ v: from, w: r.w, k: r.k });
      }
    }
    this.inAdd = inAdd;
    this.wdegCache.clear();

    for (const [rel, { id, note }] of this.patches) {
      if (note === null) continue;
      const nbW = new Map<number, number>();
      let din = 0;
      let dout = 0;
      this.eachOut(id, (v, w) => {
        if (!this.sentinels.has(v)) {
          dout++;
          nbW.set(v, (nbW.get(v) ?? 0) + w);
        }
      });
      this.eachIn(id, (v, w) => {
        din++;
        nbW.set(v, (nbW.get(v) ?? 0) + w);
      });
      const nb = [...nbW.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([v]) => v);
      this.cardOv.set(
        id,
        makeCard({
          id,
          t: note.title,
          p: rel,
          k: note.kind,
          d: domainOf(this.domains, rel),
          a: note.abstraction,
          ...(note.af ? { af: 1 as const } : {}),
          deg: [din, dout],
          nb,
          tags: note.tags,
          stub: note.stub,
          ret: note.tags.some((t) => t.toLowerCase() === "retired") || /^\(retired\)/i.test(note.title),
        }),
      );
    }
  }
}
