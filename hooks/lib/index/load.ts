/**
 * Loading and keeping the vault graph fresh inside the module (plan §2.3a,
 * §3.10), behind a Ports object so the guard order and the "never read a
 * closed shard" rule are tested against recording fakes.
 *
 *   load()          manifest → csr + names + postings + files (+ scores),
 *                   then the public journal; cards and link contexts lazily.
 *   ensureFresh()   at most every FRESH_MS: `head -c 256 manifest.json` for the
 *                   version, the journal's size for new lines. A new version
 *                   reloads; a grown journal replays.
 *   openShard(s)    reads sealed/<s>/shard.json + its journal — the ONLY code
 *                   path that reads a sealed artefact, and only for a shard the
 *                   caller says is open.
 *   patch()         applies a parsed note in memory and appends one journal
 *                   line (public journal, or the shard's own when private).
 *
 * Sandbox-safe.
 */

import { unpackCsr } from "../graph/csr.js";
import { cardChunk, CARDS_PER_CHUNK, type Card } from "./cards.js";
import { P, peekManifestVersion, linkctxChunk, LINKCTX_PER_CHUNK, SCHEMA, type Manifest, type CsrFile, type NamesFile } from "./layout.js";
import { TERMS, termSig, type PostingsRow } from "./postings.js";
import type { LinkCtx, ShardArtefact, FileEntry } from "./model.js";
import { parseJournal, pendingLines, type JournalNote, type JournalLine, COMPACT_BYTES, COMPACT_LINES } from "./journal.js";
import { VaultView, type Patch } from "./view.js";
import { MAIN, type DomainMap } from "../core/scope.js";

export type IndexPorts = {
  /** Whole file under `.wiki/`, or null when absent/unreadable. */
  read(rel: string): Promise<string | null>;
  /** First `bytes` of a file under `.wiki/`. */
  head(rel: string, bytes: number): Promise<string | null>;
  /** Size in bytes, or null when absent. */
  size(rel: string): Promise<number | null>;
  /** Append one line (newline added by the port). */
  append(rel: string, line: string): Promise<void>;
  now(): number;
};

export const FRESH_MS = 5000;
/** Card chunks kept parsed: 64 × CARDS_PER_CHUNK ≈ 8k cards. */
const LRU_CHUNKS = 64;
/** Link-context chunks kept parsed: 64 × LINKCTX_PER_CHUNK ≈ 4k source notes. */
const CTX_CHUNKS = 64;

const jsonl = <T>(text: string | null): T[] => {
  const out: T[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {}
  }
  return out;
};
const json = <T>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

export type IndexState = "absent" | "ready";

export class VaultIndex {
  state: IndexState = "absent";
  view: VaultView | null = null;
  manifest: Manifest | null = null;
  private journalSize = -1;
  private shardJournalSize = new Map<string, number>();
  private lastCheck = 0;
  private ctxCache = new Map<string, LinkCtx[]>();
  private cardChunksLoaded = new Set<number>();
  private openArts = new Map<string, ShardArtefact>();
  private sessionTag: string;
  private seq = 0;

  constructor(
    private ports: IndexPorts,
    private domains: DomainMap,
    sessionTag = "s",
  ) {
    this.sessionTag = sessionTag;
  }

  setDomains(d: DomainMap): void {
    this.domains = d;
  }

  /** Load the public artefacts. Leaves state "absent" when there is no v2 index. */
  async load(): Promise<IndexState> {
    const manifest = json<Manifest>(await this.ports.read(P.manifest));
    // A manifest cut at other chunk sizes addresses cards and link contexts
    // differently: treat it as absent so the caller rebuilds.
    if (!manifest || manifest.v !== 2 || manifest.chunks?.cardsPer !== CARDS_PER_CHUNK || manifest.chunks?.linkctxPer !== LINKCTX_PER_CHUNK || manifest.terms !== termSig(TERMS) || manifest.schema !== SCHEMA) {
      this.state = "absent";
      this.view = null;
      return this.state;
    }
    const [csrText, namesText, postingsText, filesText, scoresText] = await Promise.all([
      this.ports.read(P.csr),
      this.ports.read(P.names),
      this.ports.read(P.postings),
      this.ports.read(P.files),
      this.ports.read(P.scores),
    ]);
    const csr = json<CsrFile>(csrText);
    const names = json<NamesFile>(namesText);
    if (!csr || !names || csr.version !== manifest.version || names.version !== manifest.version) {
      // A rebuild is mid-write (artefacts disagree with the manifest): stay absent; the next check retries.
      this.state = "absent";
      return this.state;
    }
    const scores = json<{ hub: number[]; auth: number[] }>(scoresText);
    this.view = new VaultView({
      base: unpackCsr(csr),
      sentinels: csr.sentinels,
      names: names.names,
      aliases: names.aliases,
      unresolved: names.unresolved,
      postings: jsonl<PostingsRow>(postingsText),
      files: jsonl<FileEntry>(filesText),
      nextId: manifest.nextId,
      domains: this.domains,
      hub: scores?.hub,
      auth: scores?.auth,
    });
    this.manifest = manifest;
    this.cardChunksLoaded.clear();
    this.ctxCache.clear();
    this.journalSize = -1;
    this.shardJournalSize.clear();
    this.state = "ready";
    // Re-splice shards that were open before a reload.
    const reopen = [...this.openArts.keys()];
    this.openArts.clear();
    for (const s of reopen) await this.openShard(s);
    await this.replay(true);
    this.lastCheck = this.ports.now();
    return this.state;
  }

  /** Cheap freshness check (≤ every FRESH_MS unless forced). */
  async ensureFresh(force = false): Promise<IndexState> {
    const now = this.ports.now();
    if (!force && this.state === "ready" && now - this.lastCheck < FRESH_MS) return this.state;
    this.lastCheck = now;
    const head = await this.ports.head(P.manifest, 256);
    const peek = head ? peekManifestVersion(head) : null;
    if (!peek) {
      this.state = "absent";
      this.view = null;
      return this.state;
    }
    if (this.state !== "ready" || !this.manifest || peek.version !== this.manifest.version) return this.load();
    await this.replay(false);
    return this.state;
  }

  /** Replay journals whose size changed (public + each open shard). */
  private async replay(force: boolean): Promise<void> {
    if (!this.view || !this.manifest) return;
    let changed = force;
    const size = (await this.ports.size(P.journal)) ?? 0;
    if (size !== this.journalSize) changed = true;
    this.journalSize = size;
    for (const s of this.openArts.keys()) {
      const sz = (await this.ports.size(P.shardJournal(s))) ?? 0;
      if (sz !== this.shardJournalSize.get(s)) changed = true;
      this.shardJournalSize.set(s, sz);
    }
    if (!changed) return;
    const patches: Patch[] = [];
    const take = (lines: JournalLine[]) => {
      for (const l of lines) {
        if (l.op === "upsert") patches.push({ rel: l.rel, note: l.note });
        else if (l.op === "delete") patches.push({ rel: l.rel, note: null });
      }
    };
    take(pendingLines(parseJournal((await this.ports.read(P.journal)) ?? ""), this.manifest.version));
    for (const [s, art] of this.openArts) {
      take(pendingLines(parseJournal((await this.ports.read(P.shardJournal(s))) ?? ""), art.version));
    }
    this.view.setPatches(patches);
  }

  /** Whether the public journal has grown past the compaction trigger. */
  async compactionDue(): Promise<boolean> {
    const size = (await this.ports.size(P.journal)) ?? 0;
    if (size > COMPACT_BYTES) return true;
    return (this.view?.patchCount() ?? 0) > COMPACT_LINES;
  }

  // ------------------------------------------------------------------ shards

  /** Open a private shard. The caller has already decided the shard is open (scope.ts). */
  async openShard(shard: string): Promise<boolean> {
    if (!this.view || shard === MAIN) return false;
    const art = json<ShardArtefact>(await this.ports.read(P.shard(shard)));
    if (!art || art.v !== 2) return false;
    this.openArts.set(shard, art);
    this.view.openShard(art);
    this.shardJournalSize.delete(shard);
    await this.replay(true);
    return true;
  }

  closeShard(shard: string): void {
    if (!this.openArts.delete(shard)) return;
    this.view?.closeShard(shard);
    this.shardJournalSize.delete(shard);
    for (const k of [...this.ctxCache.keys()]) if (k.startsWith(`${shard}:`)) this.ctxCache.delete(k);
    void this.replay(true);
  }

  openShards(): string[] {
    return [...this.openArts.keys()].sort();
  }

  // ------------------------------------------------------------------- cards

  /** Cards for visible ids, loading at most the chunks needed (LRU-bounded). */
  async cards(ids: readonly number[]): Promise<Map<number, Card>> {
    const out = new Map<number, Card>();
    const v = this.view;
    if (!v) return out;
    const need = new Set(v.missingCards(ids).map(cardChunk));
    for (const chunk of need) {
      if (this.cardChunksLoaded.has(chunk)) continue;
      for (const c of jsonl<Card>(await this.ports.read(P.cards(chunk)))) v.baseCards.set(c.id, c);
      this.cardChunksLoaded.add(chunk);
      // Bound memory: evict the oldest chunks' cards beyond LRU_CHUNKS.
      while (this.cardChunksLoaded.size > Math.max(LRU_CHUNKS, need.size)) {
        const oldest = this.cardChunksLoaded.values().next().value as number;
        if (need.has(oldest)) break;
        this.cardChunksLoaded.delete(oldest);
        for (let id = oldest * CARDS_PER_CHUNK; id < (oldest + 1) * CARDS_PER_CHUNK; id++) v.baseCards.delete(id);
      }
    }
    for (const id of ids) {
      const c = v.card(id);
      if (c) out.set(id, c);
    }
    return out;
  }

  // ---------------------------------------------------------------- linkctx

  /** Link contexts from `s` to any of `targets` (public chunk, or an open shard's list). */
  async linkContexts(s: number, targets: readonly number[]): Promise<Map<number, LinkCtx>> {
    const out = new Map<number, LinkCtx>();
    for (const c of (await this.linkContextsByKind(s, targets)).values()) if (!out.has(c.t)) out.set(c.t, c);
    return out;
  }

  /**
   * First link context per (target, kind). A note can link the same target as
   * a frontmatter relation AND in its body; keyed by target alone, the body
   * edge borrowed the frontmatter line as its "sentence".
   */
  async linkContextsByKind(s: number, targets: readonly number[]): Promise<Map<string, LinkCtx>> {
    const out = new Map<string, LinkCtx>();
    const v = this.view;
    if (!v) return out;
    const want = new Set(targets);
    const shard = v.shard(s);
    const lists: LinkCtx[][] = [];
    if (shard === MAIN) {
      const key = `main:${linkctxChunk(s)}`;
      let list = this.ctxCache.get(key);
      if (!list) {
        list = jsonl<LinkCtx>(await this.ports.read(P.linkctx(linkctxChunk(s))));
        this.ctxCache.set(key, list);
        if (this.ctxCache.size > CTX_CHUNKS) this.ctxCache.delete(this.ctxCache.keys().next().value as string);
      }
      lists.push(list);
    }
    for (const art of this.openArts.values()) lists.push(art.linkctx);
    for (const list of lists) {
      for (const c of list) {
        const key = `${c.t}|${c.k}`;
        if (c.s === s && want.has(c.t) && !out.has(key) && v.visible(c.t)) out.set(key, c);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------- patch

  /**
   * Apply one parsed note (or a delete) and append its journal line. A note
   * in a private shard is journaled to that shard only; the caller must not
   * patch a sealed shard (the guard denies those writes, and the sweep
   * delegates external changes there to the CLI).
   */
  async patch(rel: string, note: JournalNote | null, meta: { mt: number; sz: number; shard: string }): Promise<number | null> {
    if (!this.view) return null;
    const [id] = this.view.applyPatches([{ rel, note }]);
    this.seq++;
    const at = this.ports.now();
    const seq = `${this.sessionTag}:${this.seq}`;
    const line: JournalLine = note
      ? { v: 2, op: "upsert", seq, at, rel, mt: meta.mt, sz: meta.sz, note }
      : { v: 2, op: "delete", seq, at, rel };
    const target = meta.shard === MAIN ? P.journal : P.shardJournal(meta.shard);
    await this.ports.append(target, JSON.stringify(line));
    // Our own append grew the file: record the new size so it is not replayed as foreign.
    const sz = await this.ports.size(target);
    if (meta.shard === MAIN) this.journalSize = sz ?? this.journalSize;
    else this.shardJournalSize.set(meta.shard, sz ?? 0);
    return id ?? null;
  }
}
