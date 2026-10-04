#!/usr/bin/env tsx
/**
 * Build the vault's indexes. One pass reads and parses every note once, then
 * writes two families of artefacts:
 *
 *   v2 (`.wiki/graph/`, `.wiki/sealed/`) — the CSR link graph, cards,
 *     postings, link contexts and names the hooks module and the vault tools
 *     serve from (hooks/lib/index/model.ts, layout.ts). Public artefacts carry
 *     nothing about private notes; each private shard lives under sealed/.
 *   records — the per-note maintenance facts (sources, concepts, MOCs,
 *     domains, backlinks) the CLI tools read, ONE typed file per shard:
 *     `graph/records.jsonl` and `sealed/<shard>/records.jsonl`
 *     (hooks/lib/index/records.ts; readers go through scripts/lib/vault.ts
 *     `readLegacyIndex`). v1's public `.wiki/*-index.jsonl` files are no
 *     longer written, and stale ones are deleted.
 *
 * Scope is one-way (user directive): a note is private because of where it
 * lives, never because a private note links to it. The first v2 index keeps
 * every concept the v1 rule had marked private as private (an override in
 * sealed/overrides.json) so nothing is revealed without the user.
 *
 * Single writer: takes `graph/.lock.d` (mkdir test-and-set; stolen after
 * 120 s). Every artefact is written atomically (tmp + rename), manifest last.
 *
 * Usage: commonplace index [--incremental] [--paths <rel>...] [--json]
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
} from "fs";
import { join, basename, relative, sep, dirname } from "path";
import { parseArgs } from "util";
import matter from "gray-matter";
import {
  resolveVault,
  loadDomainRegistry,
  autoRegisterDomain,
  findAllNotes,
  classifyNote,
  getLastIndexTime,
  getFileMtime,
  loadWikiConfig,
} from "./lib/vault.js";
import {
  extractFrontmatterWikilinks,
  extractWikilinks,
  extractWikilinkDisplayTexts,
  computeIsStub,
} from "./lib/frontmatter.js";
import { inferSourceDomain, inferConceptDomains } from "./lib/domain.js";
import { buildNames, resolve } from "./lib/resolve.js";
import { buildCsr, type EdgeInput } from "../hooks/lib/graph/csr.js";
import { hitsCsr } from "../hooks/lib/graph/hits.js";
import { discoverGenres, loadGenreSamples } from "./lib/genre-discovery.js";
import { parseNote as parseIndexNote } from "../hooks/lib/index/parse.js";
import { buildIndex, type IndexNote, type PrevIds } from "../hooks/lib/index/model.js";
import { serializeIndex, P, SCHEMA, type Manifest } from "../hooks/lib/index/layout.js";
import { TERMS, termSig } from "../hooks/lib/index/postings.js";
import { recordLines, RECORD_KINDS, type RecordKind } from "../hooks/lib/index/records.js";
import { shardOfDomain, MAIN, type DomainMap } from "../hooks/lib/core/scope.js";
import type { SourceNote, ConceptNote, MocNote, DomainSummary } from "./lib/types.js";

const t0 = Date.now();
const marks: Array<[string, number]> = [];
const mark = (label: string) => marks.push([label, Date.now() - t0]);
const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    incremental: { type: "boolean", default: false },
    paths: { type: "string", multiple: true },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const config = resolveVault(values.vault);
const wikiCfg = loadWikiConfig(config);
const abstractionsEnabled = wikiCfg?.abstractions === true;
const registry = loadDomainRegistry(config.wikiPath);
const W = (p: string) => join(config.wikiPath, p);

if (!existsSync(config.wikiPath)) mkdirSync(config.wikiPath, { recursive: true });

const allFiles = (await findAllNotes(config.vaultPath)).sort();

if (values.incremental) {
  const last = getLastIndexTime(config);
  // v1 semantics: nothing newer than the last build → nothing to do. The
  // hooks module asks for a FULL build when the graph is absent or due for
  // compaction, so this shortcut never strands a vault without artefacts.
  // A v2 graph cut with another postings term shape is stale even when no
  // note moved. (No manifest at all keeps the v1 semantics above.)
  let termsStale = false;
  try {
    const m = JSON.parse(readFileSync(W(P.manifest), "utf-8")) as Manifest;
    termsStale = m.terms !== termSig(TERMS) || m.schema !== SCHEMA;
  } catch {}
  if (!termsStale && !allFiles.some((f) => getFileMtime(f) > last)) {
    console.log("Indexes up to date, 0 files changed");
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Lock (single writer, plan §3.10)
// ---------------------------------------------------------------------------
const lockDir = W(P.lock);
function takeLock(): boolean {
  mkdirSync(dirname(lockDir), { recursive: true });
  try {
    mkdirSync(lockDir);
  } catch {
    let age = Infinity;
    try {
      age = Date.now() - Number(readFileSync(join(lockDir, "at"), "utf-8"));
    } catch {
      try {
        age = Date.now() - statSync(lockDir).mtimeMs;
      } catch {}
    }
    if (age < 120_000) return false;
    console.error("index: lock-stolen (holder older than 120 s)");
  }
  writeFileSync(join(lockDir, "at"), String(Date.now()));
  return true;
}
if (!takeLock()) {
  console.log("index: lock-busy — another index job is running");
  process.exit(0);
}
const releaseLock = () => {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {}
};
process.on("exit", releaseLock);

// ---------------------------------------------------------------------------
// Read + parse every note ONCE
// ---------------------------------------------------------------------------
const toRel = (abs: string) => {
  const rel = relative(config.vaultPath, abs);
  return sep === "\\" ? rel.split(sep).join("/") : rel;
};

type Loaded = {
  abs: string;
  rel: string;
  fm: Record<string, unknown>;
  body: string;
  raw: string;
  mt: number;
  sz: number;
  aliases: string[];
};

const loaded: Loaded[] = [];
for (const abs of allFiles) {
  try {
    const raw = readFileSync(abs, "utf-8");
    const st = statSync(abs);
    const { data, content } = matter(raw.replace(/^P\d{2}-\d{2}-\d{2}$/gm, ""));
    const aliases = Array.isArray(data.aliases)
      ? data.aliases.filter((a: unknown): a is string => typeof a === "string" && a.trim().length > 0)
      : [];
    loaded.push({ abs, rel: toRel(abs), fm: data, body: content, raw, mt: Math.round(st.mtimeMs), sz: st.size, aliases });
  } catch {
    // unreadable or unparseable — skipped, as v1 did
  }
}

mark("read");
// Auto-register domains for foldered "other" notes with source-shaped frontmatter.
for (const l of loaded) {
  if (classifyNote(l.abs, config.vaultPath, wikiCfg, registry) !== "other") continue;
  if (Array.isArray(l.fm.concepts) && l.fm.concepts.length > 0) {
    autoRegisterDomain(l.abs, config.vaultPath, config.wikiPath, registry);
  }
}
const domains = registry.domains as DomainMap;

// ---------------------------------------------------------------------------
// Legacy records (v1 shapes)
// ---------------------------------------------------------------------------
const sources: SourceNote[] = [];
const concepts: ConceptNote[] = [];
const mocs: MocNote[] = [];
const typeOf = new Map<string, string>();

for (const l of loaded) {
  const noteType = classifyNote(l.abs, config.vaultPath, wikiCfg, registry);
  typeOf.set(l.abs, noteType);
  const fm = l.fm;
  const aliasField = l.aliases.length > 0 ? { aliases: l.aliases } : {};
  const abstraction =
    typeof fm.abstraction === "string" && fm.abstraction.trim().length > 0 ? { abstraction: fm.abstraction.trim() } : {};
  if (noteType === "source") {
    const domain = inferSourceDomain(l.abs, config.vaultPath, registry);
    const anchors = extractWikilinkDisplayTexts(l.body);
    sources.push({
      title: basename(l.abs, ".md"),
      path: l.abs,
      domain,
      scope: "public", // set from the shard below
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      concepts: [...new Set([...extractFrontmatterWikilinks(fm.concepts), ...extractWikilinks(l.body)])],
      mocs: extractFrontmatterWikilinks(fm.mocs),
      buildsOn: extractFrontmatterWikilinks(fm.builds_on),
      comparesWith: extractFrontmatterWikilinks(fm.compares_with),
      usesMethod: extractFrontmatterWikilinks(fm.uses_method),
      ...aliasField,
      ...abstraction,
      ...(anchors.length > 0 ? { anchors } : {}),
    });
  } else if (noteType === "concept") {
    const compiledFrom = Array.isArray(fm.compiledFrom)
      ? fm.compiledFrom
          .filter((e): e is { path: unknown; hash: unknown } => typeof e === "object" && e !== null)
          .map((e) => ({ path: String(e.path), hash: String(e.hash) }))
      : [];
    const anchors = extractWikilinkDisplayTexts(l.body);
    concepts.push({
      name: basename(l.abs, ".md"),
      path: l.abs,
      domains: [],
      backlinkCount: 0,
      isStub: computeIsStub(l.body, fm, abstractionsEnabled),
      ...aliasField,
      ...abstraction,
      ...(anchors.length > 0 ? { anchors } : {}),
      ...(compiledFrom.length > 0 ? { compiledFrom } : {}),
    });
  } else if (noteType === "moc") {
    const countMatch = l.body.match(/##\s+(?:Papers|Sources|Notes|Items|Entries)\s*\((\d+)\)/i);
    mocs.push({
      name: basename(l.abs, ".md"),
      path: l.abs,
      domains: [],
      sourceCount: 0,
      sources: [],
      declaredCount: countMatch ? parseInt(countMatch[1], 10) : null,
    });
  }
}

mark("legacy-records");
// Concept resolution (stem > alias > path), from cached aliases — v1 re-read
// every file here, twice, which dominated the rebuild at scale.
const conceptNames = buildNames(concepts.map((c, id) => ({ id, path: c.path, title: "", aliases: c.aliases ?? [] })));
const resolveConceptRef = (target: string): string | null => {
  const id = resolve(conceptNames, target);
  return id === null ? null : concepts[id].name;
};
const domainConceptRefs = new Map<string, Set<string>>();
const refsFor = (d: string) => {
  let s = domainConceptRefs.get(d);
  if (!s) domainConceptRefs.set(d, (s = new Set()));
  return s;
};
for (const s of sources) {
  const resolved = new Set<string>();
  for (const ref of s.concepts) {
    const c = resolveConceptRef(ref);
    if (c) resolved.add(c);
  }
  s.concepts = [...resolved];
  const set = refsFor(s.domain);
  for (const c of s.concepts) set.add(c);
}

const byAbs = new Map(loaded.map((l, i) => [l.abs, i]));
const fileNames = buildNames(loaded.map((l, id) => ({ id, path: l.abs, title: "", aliases: l.aliases })));
const backlinkIndex = new Map<string, Map<string, number>>();
const backlinkCounts = new Map<string, number>();
const wikilinkPattern = /\[\[([^\[\]|]+)(?:\|[^\[\]]+)?\]\]/g;

for (const l of loaded) {
  const noteType = typeOf.get(l.abs);
  const counts = new Map<string, number>();
  wikilinkPattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = wikilinkPattern.exec(l.body)) !== null) {
    const raw = m[1].trim();
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  for (const [raw, count] of counts) {
    const targetId = resolve(fileNames, raw);
    if (targetId === null) continue;
    const targetPath = loaded[targetId].abs;
    if (targetPath === l.abs) continue;
    let map = backlinkIndex.get(targetPath);
    if (!map) backlinkIndex.set(targetPath, (map = new Map()));
    map.set(l.abs, (map.get(l.abs) ?? 0) + count);
  }
  if (noteType === "concept") continue;
  const referenced = new Set<string>();
  for (const name of new Set([...extractFrontmatterWikilinks(l.fm.concepts), ...extractWikilinks(l.body)])) {
    const c = resolveConceptRef(name);
    if (c) referenced.add(c);
  }
  for (const c of referenced) backlinkCounts.set(c, (backlinkCounts.get(c) ?? 0) + 1);
  if (noteType !== "source") {
    const domain = inferSourceDomain(l.abs, config.vaultPath, registry);
    if (domain) {
      const set = refsFor(domain);
      for (const c of referenced) set.add(c);
    }
  }
}
for (const c of concepts) {
  c.backlinkCount = backlinkCounts.get(c.name) ?? 0;
  c.domains = inferConceptDomains(c.name, domainConceptRefs);
}

mark("legacy-links");
// ---------------------------------------------------------------------------
// v2 build
// ---------------------------------------------------------------------------
function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}
function readJsonl<T>(p: string): T[] {
  try {
    return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((x) => JSON.parse(x) as T);
  } catch {
    return [];
  }
}

const prevManifest = readJson<Manifest>(W(P.manifest));
const firstV2 = !prevManifest;
const prevSentinels = readJson<{ sentinels: Record<string, number> }>(W(P.sentinels))?.sentinels ?? {};
const prevIds = new Map<string, number>();
for (const f of readJsonl<{ p: string; id: number }>(W(P.files))) prevIds.set(f.p, f.id);
for (const shard of Object.keys(prevSentinels)) {
  for (const f of readJson<{ files: Array<{ p: string; id: number }> }>(W(P.shard(shard)))?.files ?? []) prevIds.set(f.p, f.id);
}
const prev: PrevIds | undefined = prevManifest
  ? { nextId: prevManifest.nextId, ids: prevIds, sentinels: new Map(Object.entries(prevSentinels)) }
  : undefined;

// Migration overrides (§4.1): concepts the v1 rule marked private stay private.
const overrides = new Map<string, string>(
  Object.entries(readJson<{ overrides: Record<string, string> }>(W(P.overrides))?.overrides ?? {}),
);
if (firstV2 && !existsSync(W(P.overrides))) {
  for (const c of concepts) {
    const privateRefs = c.domains.filter((d) => domains[d]?.scope === "private").sort();
    if (privateRefs.length === 0) continue;
    overrides.set(toRel(c.path), shardOfDomain(domains, privateRefs[0]));
  }
}
for (const rel of [...overrides.keys()]) if (!byAbs.has(join(config.vaultPath, rel))) overrides.delete(rel);

const structure = wikiCfg?.structure;
const domainPaths = Object.values(domains).map((d) => d.path ?? "").filter(Boolean);
const indexNotes: IndexNote[] = loaded.map((l) => {
  const parsed = parseIndexNote(l.rel, l.raw, {
    structure,
    domainPaths,
    frontmatter: l.fm as never,
  });
  return {
    rel: l.rel,
    parsed,
    mt: l.mt,
    sz: l.sz,
    stub: parsed.kind === "concept" ? computeIsStub(l.body, l.fm, abstractionsEnabled) : false,
  };
});

mark("parse-v2");
const version = (prevManifest?.version ?? 0) + 1;
const builtAt = new Date().toISOString();
const built = buildIndex(indexNotes, {
  domains,
  version,
  builtAt,
  prev,
  overrides,
  knownLoose: prevManifest ? new Set(prevManifest.knownLoose) : undefined,
  structureDirs: [structure?.concepts, structure?.mocs].filter((s): s is string => Boolean(s)),
});

mark("build-v2");
const shardOfAbs = (abs: string) => built.shardOf.get(toRel(abs)) ?? MAIN;
for (const s of sources) s.scope = shardOfAbs(s.path) === MAIN ? "public" : "private";
for (const c of concepts) c.scope = shardOfAbs(c.path) === MAIN ? "public" : "private";

// MOC counts (public sources only), via a name → sources map instead of a
// filter over every source per MOC.
const mocSources = new Map<string, SourceNote[]>();
for (const s of sources) {
  if (s.scope === "private") continue;
  for (const name of s.mocs) {
    let list = mocSources.get(name);
    if (!list) mocSources.set(name, (list = []));
    list.push(s);
  }
}
for (const moc of mocs) {
  const refs = mocSources.get(moc.name) ?? [];
  moc.sourceCount = refs.length;
  moc.sources = refs.map((s) => s.title);
  moc.domains = [...new Set(refs.map((s) => s.domain))];
}

const sourceCountByDomain = new Map<string, number>();
for (const s of sources) sourceCountByDomain.set(s.domain, (sourceCountByDomain.get(s.domain) ?? 0) + 1);
const conceptCountByDomain = new Map<string, number>();
for (const c of concepts) for (const d of c.domains) conceptCountByDomain.set(d, (conceptCountByDomain.get(d) ?? 0) + 1);
const domainSummaries: DomainSummary[] = Object.entries(registry.domains).map(([slug, entry]) => ({
  slug,
  path: entry.path,
  scope: entry.scope,
  sourceCount: sourceCountByDomain.get(slug) ?? 0,
  conceptCount: conceptCountByDomain.get(slug) ?? 0,
}));

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const backlinkRecords = [...backlinkIndex.entries()]
  .map(([target, srcs]) => [toRel(target), srcs] as const)
  .sort(([a], [b]) => cmp(a, b))
  .map(([target, srcs]) => ({
    target,
    backlinks: [...srcs.entries()]
      .map(([source, count]) => ({ source: toRel(source), count }))
      .sort((a, b) => cmp(a.source, b.source)),
  }));

// HITS over the body-wikilink graph, on the typed-array implementation
// (same semantics as scripts/lib/hits.ts; the Map version took seconds at scale).
mark("moc-domain-backlinks");
const relId = new Map(loaded.map((l, i) => [l.rel, i]));
const hitsEdges: EdgeInput[] = backlinkRecords.flatMap((r) =>
  r.backlinks.map((b) => ({ from: relId.get(b.source)!, to: relId.get(r.target)!, kind: "body" as const, w: b.count })),
);
const hits = hitsCsr(buildCsr(loaded.length, hitsEdges));
const hitsScores = new Map<string, { hub: number; authority: number }>();
for (const [rel, i] of relId) {
  if (hits.hub[i] || hits.auth[i]) hitsScores.set(rel, { hub: hits.hub[i], authority: hits.auth[i] });
}
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
function withHits<T extends { path: string }>(record: T): T {
  const s = hitsScores.get(record.path);
  if (!s || (s.hub === 0 && s.authority === 0)) return record;
  return { ...record, hub: round6(s.hub), authority: round6(s.authority) };
}

mark("hits");
// ---------------------------------------------------------------------------
// Write — atomic per file; legacy first, v2 graph after, manifest last
// ---------------------------------------------------------------------------
function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
const toJsonl = (arr: unknown[]) => (arr.length ? arr.map((x) => JSON.stringify(x)).join("\n") + "\n" : "");
const isPrivRel = (rel: string) => (built.shardOf.get(rel) ?? MAIN) !== MAIN;

const sourcesOut = sources.map((s) => withHits({ ...s, path: toRel(s.path) }));
const conceptsOut = concepts.map((c) => withHits({ ...c, path: toRel(c.path) }));
const mocsOut = mocs.map((m) => withHits({ ...m, path: toRel(m.path) }));
const shardRel = (rel: string) => built.shardOf.get(rel) ?? MAIN;
// Private rows carry their `shard`, so a reader can merge exactly the shards a
// session has opened (scripts/lib/vault.ts `openShardsFromEnv`).
const split = <T extends { path: string }>(rows: T[]): [T[], Array<T & { shard: string }>] => [
  rows.filter((r) => !isPrivRel(r.path)),
  rows.filter((r) => isPrivRel(r.path)).map((r) => ({ ...r, shard: shardRel(r.path) })),
];
const [srcPub, srcPriv] = split(sourcesOut);
const [conPub, conPriv] = split(conceptsOut);
const [mocPub, mocPriv] = split(mocsOut);
const domPub = domainSummaries.filter((d) => d.scope !== "private");
const domPriv = domainSummaries
  .filter((d) => d.scope === "private")
  .map((d) => ({ ...d, shard: shardOfDomain(domains, d.slug) }));
const blPub: typeof backlinkRecords = [];
const blPriv: Array<(typeof backlinkRecords)[number] & { shard: string }> = [];
for (const r of backlinkRecords) {
  if (isPrivRel(r.target)) {
    blPriv.push({ ...r, shard: shardRel(r.target) });
    continue;
  }
  const pubB = r.backlinks.filter((b) => !isPrivRel(b.source));
  if (pubB.length) blPub.push({ target: r.target, backlinks: pubB });
  // One private row per source shard: opening gamma must not reveal delta's backlinks.
  const byShard = new Map<string, typeof r.backlinks>();
  for (const b of r.backlinks) {
    if (!isPrivRel(b.source)) continue;
    const sh = shardRel(b.source);
    byShard.set(sh, [...(byShard.get(sh) ?? []), b]);
  }
  for (const [shard, backlinks] of byShard) blPriv.push({ target: r.target, backlinks, shard });
}

// Maintenance records (hooks/lib/index/records.ts): ONE typed file per shard.
// v1's five public `*-index.jsonl` files (and v2.0-2.3's sealed/legacy split)
// are no longer written; stale copies are removed so nothing reads them.
const recKinds: Array<[RecordKind, unknown[], Array<{ shard: string }>]> = [
  ["source", srcPub, srcPriv],
  ["concept", conPub, conPriv],
  ["moc", mocPub, mocPriv],
  ["domain", domPub, domPriv],
  ["backlink", blPub, blPriv],
];
let publicRecords = "";
const shardRecords = new Map<string, string>();
for (const [kind, pub, priv] of recKinds) {
  publicRecords += recordLines(kind, pub as object[]);
  const byShard = new Map<string, object[]>();
  for (const { shard, ...row } of priv) byShard.set(shard, [...(byShard.get(shard) ?? []), row]);
  for (const [shard, rows] of byShard) shardRecords.set(shard, (shardRecords.get(shard) ?? "") + recordLines(kind, rows));
}
writeAtomic(W(P.records), publicRecords);
const sealedRoot = W("sealed");
if (existsSync(sealedRoot)) {
  for (const e of readdirSync(sealedRoot, { withFileTypes: true })) {
    if (e.isDirectory() && !shardRecords.has(e.name)) rmSync(join(sealedRoot, e.name, "records.jsonl"), { force: true });
  }
}
for (const [shard, text] of shardRecords) writeAtomic(W(P.shardRecords(shard)), text);
for (const kind of RECORD_KINDS) rmSync(W(`${kind}-index.jsonl`), { force: true });
rmSync(W("sealed/legacy"), { recursive: true, force: true });

mark("write-legacy");
writeAtomic(W(P.overrides), JSON.stringify({ v: 2, overrides: Object.fromEntries([...overrides].sort()) }));
const files = serializeIndex(built, { version, builtAt });
for (const [rel, text] of files) writeAtomic(W(rel), text);
// Chunk files a previous build cut at another size (or for more ids) are not
// in this set; left behind they would be read for ids they no longer hold.
const written = new Set(files.map(([rel]) => rel));
for (const dir of ["graph/cards", "graph/linkctx"]) {
  if (!existsSync(W(dir))) continue;
  for (const f of readdirSync(W(dir))) if (!written.has(`${dir}/${f}`)) rmSync(W(`${dir}/${f}`), { force: true });
}
writeFileSync(W(".last-index"), String(Date.now()));

mark("write");
// Genre discovery (unchanged from v1).
const genreStructureDirs = new Set(
  [wikiCfg?.structure.concepts, wikiCfg?.structure.mocs].filter((s): s is string => Boolean(s)),
);
const genreSamples = await loadGenreSamples(config.vaultPath);
const genreResult = discoverGenres(genreSamples, genreStructureDirs, config.wikiPath);
if (genreResult.changed) {
  writeFileSync(W("conventions.json"), JSON.stringify(genreResult.conventions, null, 2) + "\n");
}

mark("genres");
const summary = {
  status: "ok",
  filesProcessed: loaded.length,
  sources: sources.length,
  concepts: concepts.length,
  mocs: mocs.length,
  domains: domainSummaries.length,
  graph: { version, ...built.stats, shards: built.shards.size },
  ms: Date.now() - t0,
  ...(process.env.COMMONPLACE_INDEX_PROFILE ? { marks } : {}),
  timestamp: builtAt,
};
if (process.env.COMMONPLACE_INDEX_PROFILE) console.error(JSON.stringify(marks));
if (values.json) {
  console.log(JSON.stringify(summary));
} else {
  console.log(
    `Indexed ${loaded.length} files: ${sources.length} sources, ${concepts.length} concepts, ${mocs.length} MOCs, ${domainSummaries.length} domains, ${backlinkRecords.length} backlink targets · graph v${version} (${built.stats.publicNodes} public notes, ${built.shards.size} sealed shard${built.shards.size === 1 ? "" : "s"}) in ${summary.ms} ms`,
  );
  if (genreResult.newGenres.length > 0) {
    console.log(
      `Discovered ${genreResult.newGenres.length} new genre(s): ${genreResult.newGenres.join(", ")} — dispatch wiki-conventions-tuner to propose rules.`,
    );
  }
}
