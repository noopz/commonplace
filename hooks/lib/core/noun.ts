/**
 * The `$.commonplace` methods' logic (plan §2.2), over one vault's loaded
 * index. `register.tsx` binds each method to an own-event hook
 * (`commonplace.<m>`) and the model-facing tools call the same functions
 * directly, so a foreign hook on our events never sits between our own
 * callers and our data (§2.2a rule 4).
 *
 * Scope is inside, not around: every function reads only through the view,
 * which holds public + open shards and nothing else. A sealed note is
 * indistinguishable from a missing one — same error text, no counts.
 *
 * Text masking (§4.2): any note text or link sentence returned has wikilinks
 * to sealed titles rewritten `[[…]]` and distinctive sealed titles replaced
 * by `(…)`. The sealed list comes from `sealed/names.json` (the leak guard's
 * input), filtered to shards this session has not opened.
 *
 * Pure: plain values and a `readNote` port.
 */

import type {
  CommonplaceCard,
  CommonplaceLink,
  CommonplaceNote,
  CommonplaceEdgeKind,
  CommonplaceNodeKind,
  CommonplaceSearchResult,
  CommonplaceLinksResult,
  CommonplacePathResult,
  CommonplaceNeighbourhoodResult,
  CommonplaceListResult,
  CommonplaceError,
} from "../../../types/index.js";
import type { Card } from "../index/cards.js";
import type { VaultIndex } from "../index/load.js";
import { findPath } from "../graph/path.js";
import { pushPpr, topPool } from "../graph/walk.js";
import { KIND_INDEX, KIND_WEIGHT, type EdgeKind } from "../graph/csr.js";
import { findPrivateMatches } from "../guard.js";
import { listableDomains, MAIN, type DomainMap } from "./scope.js";

export type NounCtx = {
  vaultId: string;
  index: VaultIndex;
  domains: DomainMap;
  /** Open private shards for this vault (module memory). */
  open: ReadonlySet<string>;
  /** Titles + aliases of shards NOT open (masking input). */
  sealedNames: readonly string[];
  /** Whole note text by vault-relative path, or null. */
  readNote(rel: string): Promise<string | null>;
  /** Notes read in this session (trail), for the "unread" hint. */
  readSet?: ReadonlySet<number>;
  now(): number;
};

export const NO_NOTE = (ref: string) => ({ error: `No vault note matches "${ref}".` });

const KIND_RANK: Record<string, number> = Object.fromEntries(
  Object.entries(KIND_WEIGHT).map(([k, w]) => [k, -w * 10 + KIND_INDEX[k as EdgeKind]]),
);

/**
 * Titles of visible notes linking here with `kind` (`supersedes`/`contests`
 * point from the newer note at the one it replaces or disputes). Titles come
 * from paths: a note's title is its filename.
 */
function inboundTitles(view: VaultIndex["view"], id: number, kind: EdgeKind): string[] {
  if (!view) return [];
  const k = KIND_INDEX[kind];
  const out = new Set<string>();
  view.eachIn(id, (v, _w, ki) => {
    if (ki !== k || !view.visible(v)) return;
    const rel = view.relOfId(v);
    if (rel) out.add(rel.split("/").pop()!.replace(/\.md$/, ""));
  });
  return [...out].sort();
}

export function toCard(c: Card, ctx: Pick<NounCtx, "vaultId" | "index">): CommonplaceCard {
  const shard = ctx.index.view?.shard(c.id) ?? MAIN;
  const sup = inboundTitles(ctx.index.view, c.id, "supersedes");
  const con = inboundTitles(ctx.index.view, c.id, "contests");
  return {
    id: c.id,
    vault: ctx.vaultId,
    path: c.p,
    title: c.t,
    kind: c.k as CommonplaceNodeKind,
    domain: c.d,
    abstraction: c.a,
    inDegree: c.deg[0],
    outDegree: c.deg[1],
    tags: c.tags,
    isStub: c.stub,
    isRetired: c.ret,
    ...(c.pub ? { published: c.pub } : {}),
    ...(c.cr ? { added: c.cr } : {}),
    ...(sup.length ? { supersededBy: sup } : {}),
    ...(con.length ? { contestedBy: con } : {}),
    ...(shard !== MAIN ? { isPrivate: true as const } : {}),
  };
}

/** Mask sealed references in returned text (§4.2). */
export function maskSealed(text: string, sealedNames: readonly string[]): string {
  if (!text || sealedNames.length === 0) return text;
  const lower = new Set(sealedNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  let out = text.replace(/\[\[([^\]|#]+)((?:[#|][^\]]*)?)\]\]/g, (m, target: string) =>
    lower.has(target.trim().toLowerCase()) ? "[[…]]" : m,
  );
  const hits = findPrivateMatches(out, [...sealedNames]);
  for (const h of hits.sort((a, b) => b.length - a.length)) {
    const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9])${esc}(?=$|[^A-Za-z0-9])`, "gi"), (_m, pre: string) => `${pre}(…)`);
  }
  return out;
}

async function cardsFor(ctx: NounCtx, ids: number[]): Promise<Map<number, CommonplaceCard>> {
  const raw = await ctx.index.cards(ids);
  const out = new Map<number, CommonplaceCard>();
  for (const [id, c] of raw) out.set(id, toCard(c, ctx));
  return out;
}

function resolveRef(ctx: NounCtx, ref: string): number | null {
  return ctx.index.view?.resolve(ref) ?? null;
}

// ---------------------------------------------------------------- search

export async function search(
  ctx: NounCtx,
  args: { query: string; limit?: number; offset?: number; kinds?: CommonplaceNodeKind[]; domain?: string },
): Promise<CommonplaceSearchResult | CommonplaceError> {
  const t0 = ctx.now();
  const v = ctx.index.view;
  if (!v) return { error: "index not built" };
  if (args.domain && !listableDomains(ctx.domains, ctx.open).includes(args.domain)) {
    return { error: "No such domain" };
  }
  const limit = Math.max(1, Math.min(25, Number(args.limit ?? 8) || 8));
  const offset = Math.max(0, Math.min(200, Math.floor(Number(args.offset ?? 0)) || 0));
  // Fetch one past the page to know whether another exists; over-fetch when
  // filtering by kind/domain (cards decide those).
  const want = offset + limit + 1;
  const raw = v.search(args.query, { limit: args.kinds || args.domain ? want * 6 : want });
  const cards = await cardsFor(ctx, raw.map((h) => h.id));
  const hits = [];
  let seen = 0;
  let more = false;
  for (const h of raw) {
    const c = cards.get(h.id);
    if (!c) continue;
    if (args.kinds && !args.kinds.includes(c.kind)) continue;
    if (args.domain && c.domain !== args.domain) continue;
    if (seen++ < offset) continue;
    if (hits.length >= limit) {
      more = true;
      break;
    }
    hits.push({ ...c, rank: offset + hits.length + 1, matched: h.matched });
  }
  return { hits, vault: ctx.vaultId, tookMs: ctx.now() - t0, ...(more ? { nextOffset: offset + limit } : {}) };
}

// ----------------------------------------------------------------- links

async function linkObjects(
  ctx: NounCtx,
  u: number,
  list: Array<{ id: number; w: number; kind: EdgeKind; dir: "out" | "in" }>,
  withWhy: boolean,
): Promise<CommonplaceLink[]> {
  const cards = await cardsFor(ctx, [u, ...list.map((l) => l.id)]);
  const self = cards.get(u);
  if (!self) return [];
  // Link contexts: out-links come from u's chunk; in-links from each source's.
  const why = new Map<string, { h: string; sent: string }>();
  if (withWhy) {
    const outs = list.filter((l) => l.dir === "out").map((l) => l.id);
    if (outs.length) {
      for (const [tk, c] of await ctx.index.linkContextsByKind(u, outs)) why.set(`${u}>${tk}`, { h: c.h, sent: c.sent });
    }
    for (const l of list.filter((x) => x.dir === "in").slice(0, 25)) {
      for (const [tk, c] of await ctx.index.linkContextsByKind(l.id, [u])) why.set(`${l.id}>${tk}`, { h: c.h, sent: c.sent });
    }
  }
  const out: CommonplaceLink[] = [];
  for (const l of list) {
    const other = cards.get(l.id);
    if (!other) continue;
    const from = l.dir === "out" ? self : other;
    const to = l.dir === "out" ? other : self;
    const w = why.get(`${from.id}>${to.id}|${l.kind}`);
    out.push({
      from,
      to,
      kind: l.kind as CommonplaceEdgeKind,
      weight: l.w,
      why: w ? maskSealed(w.sent, ctx.sealedNames) : "",
      heading: w?.h ?? "",
    });
  }
  return out;
}

function sortLinks<T extends { kind: EdgeKind; w: number; id: number }>(list: T[], indeg: (id: number) => number): T[] {
  return [...list].sort(
    (a, b) => (KIND_RANK[a.kind] ?? 0) - (KIND_RANK[b.kind] ?? 0) || b.w - a.w || indeg(b.id) - indeg(a.id) || a.id - b.id,
  );
}

export async function links(
  ctx: NounCtx,
  args: { note: string; direction?: "out" | "in" | "both"; kinds?: CommonplaceEdgeKind[]; limit?: number; withWhy?: boolean },
): Promise<CommonplaceLinksResult | CommonplaceError> {
  const t0 = ctx.now();
  const v = ctx.index.view;
  if (!v) return { error: "index not built" };
  const u = resolveRef(ctx, args.note);
  if (u === null) return NO_NOTE(args.note);
  const limit = Math.max(1, Math.min(100, Number(args.limit ?? 20) || 20));
  let list = v.links(u, args.direction ?? "both");
  if (args.kinds?.length) list = list.filter((l) => args.kinds!.includes(l.kind as CommonplaceEdgeKind));
  const indeg = (id: number) => {
    let d = 0;
    v.eachIn(id, () => d++);
    return d;
  };
  list = sortLinks(list, indeg).slice(0, limit);
  const objs = await linkObjects(ctx, u, list, args.withWhy !== false && list.length <= 25);
  const card = (await cardsFor(ctx, [u])).get(u);
  if (!card) return NO_NOTE(args.note);
  return { card, links: objs, tookMs: ctx.now() - t0 };
}

// ------------------------------------------------------------------ note

export const NOTE_LINK_CAP = 10;

export async function note(
  ctx: NounCtx,
  args: { ref: string; maxChars?: number },
): Promise<CommonplaceNote | CommonplaceError> {
  const v = ctx.index.view;
  if (!v) return { error: "index not built" };
  const u = resolveRef(ctx, args.ref);
  if (u === null) return NO_NOTE(args.ref);
  const rel = v.relOfId(u);
  if (!rel) return NO_NOTE(args.ref);
  const raw = await ctx.readNote(rel);
  if (raw === null) return NO_NOTE(args.ref);
  const max = Math.max(1000, Math.min(200_000, Number(args.maxChars ?? 40_000) || 40_000));
  const truncated = raw.length > max;
  const text = maskSealed(truncated ? raw.slice(0, max) : raw, ctx.sealedNames);
  const indeg = (id: number) => {
    let d = 0;
    v.eachIn(id, () => d++);
    return d;
  };
  const outAll = sortLinks(v.links(u, "out"), indeg);
  const inAll = sortLinks(v.links(u, "in"), indeg);
  const out = await linkObjects(ctx, u, outAll.slice(0, NOTE_LINK_CAP), true);
  const inn = await linkObjects(ctx, u, inAll.slice(0, NOTE_LINK_CAP), false);
  const card = (await cardsFor(ctx, [u])).get(u)!;
  const readSet = ctx.readSet ?? new Set<number>();
  const seen = new Set<number>();
  const unread: CommonplaceCard[] = [];
  for (const l of [...out.map((x) => x.to), ...inn.map((x) => x.from)]) {
    if (l.id === u || readSet.has(l.id) || seen.has(l.id)) continue;
    seen.add(l.id);
    unread.push(l);
  }
  return {
    card,
    text,
    truncated,
    out,
    in: inn,
    moreOut: Math.max(0, outAll.length - out.length),
    moreIn: Math.max(0, inAll.length - inn.length),
    unread: unread.slice(0, 6),
  };
}

// ------------------------------------------------------------------ path

export async function path(
  ctx: NounCtx,
  args: { from: string; to: string; maxHops?: number; avoidHubs?: boolean },
): Promise<CommonplacePathResult | CommonplaceError> {
  const t0 = ctx.now();
  const v = ctx.index.view;
  if (!v) return { error: "index not built" };
  const a = resolveRef(ctx, args.from);
  if (a === null) return NO_NOTE(args.from);
  const b = resolveRef(ctx, args.to);
  if (b === null) return NO_NOTE(args.to);
  const maxHops = Math.max(1, Math.min(6, Number(args.maxHops ?? 4) || 4));
  const res = findPath(v, a, b, { maxHops, avoidHubs: args.avoidHubs !== false, blocked: v.sentinels });
  if (!res) return { path: null, cost: null, tookMs: ctx.now() - t0 };
  const steps: CommonplaceLink[] = [];
  for (const s of res.steps) {
    const [link] = await linkObjects(
      ctx,
      s.from,
      [{ id: s.to, w: s.w, kind: s.kind, dir: s.dir }],
      true,
    );
    if (!link) return { path: null, cost: null, tookMs: ctx.now() - t0 };
    steps.push(s.dir === "in" ? { ...link, reversed: true } : link);
  }
  return { path: steps, cost: res.cost, tookMs: ctx.now() - t0 };
}

// --------------------------------------------------------- neighbourhood

export async function neighbourhood(
  ctx: NounCtx,
  args: { seeds: string[]; k?: number },
): Promise<CommonplaceNeighbourhoodResult | CommonplaceError> {
  const t0 = ctx.now();
  const v = ctx.index.view;
  if (!v) return { error: "index not built" };
  const seeds = new Map<number, number>();
  for (const s of (args.seeds ?? []).slice(0, 5)) {
    const id = resolveRef(ctx, s);
    if (id !== null) seeds.set(id, 1);
  }
  if (seeds.size === 0) return NO_NOTE((args.seeds ?? []).join(", "));
  const k = Math.max(1, Math.min(30, Number(args.k ?? 12) || 12));
  const res = pushPpr(v, seeds, { epsilon: 1e-5, blocked: v.sentinels });
  const pool = topPool(res, seeds, k * 2).filter((p) => v.visible(p.id)).slice(0, k);
  const cards = await cardsFor(ctx, pool.flatMap((p) => (p.via === null ? [p.id] : [p.id, p.via])));
  const out = [];
  for (const p of pool) {
    const card = cards.get(p.id);
    if (!card) continue;
    let via: CommonplaceLink | null = null;
    if (p.via !== null && v.visible(p.via)) {
      const edge = v.links(p.via).find((l) => l.id === p.id);
      if (edge) {
        const [link] = await linkObjects(ctx, p.via, [edge], false);
        via = link ?? null;
      }
    }
    out.push({ card, rank: out.length + 1, via });
  }
  return { pool: out, tookMs: ctx.now() - t0 };
}

// ------------------------------------------------------------------ list

export async function list(
  ctx: NounCtx,
  args: { what: "domains" | "mocs" | "recent" | "stubs" | "vaults"; limit?: number },
  extra: { vaults?: Array<Record<string, string | number | boolean>>; recent?: Array<{ p: string; mt: number }> } = {},
): Promise<CommonplaceListResult> {
  const limit = Math.max(1, Math.min(200, Number(args.limit ?? 50) || 50));
  const v = ctx.index.view;
  if (args.what === "vaults") return { items: (extra.vaults ?? []).slice(0, limit) };
  if (args.what === "domains") {
    return {
      items: listableDomains(ctx.domains, ctx.open).map((id) => ({
        id,
        path: ctx.domains[id]?.path ?? "",
        scope: ctx.domains[id]?.scope === "private" ? "private (open)" : "public",
      })),
    };
  }
  if (!v) return { items: [] };
  if (args.what === "recent") {
    const rows = (extra.recent ?? [])
      .filter((r) => v.idOfRel(r.p) !== undefined)
      .sort((a, b) => b.mt - a.mt)
      .slice(0, limit);
    const cards = await cardsFor(ctx, rows.map((r) => v.idOfRel(r.p)!));
    return {
      items: rows.flatMap((r) => {
        const c = cards.get(v.idOfRel(r.p)!);
        return c ? [{ title: c.title, path: c.path, kind: c.kind, changed: new Date(r.mt).toISOString().slice(0, 10) }] : [];
      }),
    };
  }
  // mocs / stubs: scan visible cards (all chunks; this is a listing, not a hot path).
  const ids: number[] = [];
  for (let id = 0; id < v.n; id++) if (v.visible(id)) ids.push(id);
  const cards = await cardsFor(ctx, ids);
  const want = [...cards.values()].filter((c) => (args.what === "mocs" ? c.kind === "moc" : c.isStub));
  const indeg = (c: CommonplaceCard) => c.inDegree;
  return {
    items: want
      .sort((a, b) => indeg(b) - indeg(a) || (a.title < b.title ? -1 : 1))
      .slice(0, limit)
      .map((c) => ({ title: c.title, path: c.path, links: c.inDegree + c.outDegree })),
  };
}
