/**
 * Read-only in-memory v2 build, for evals that must vary the index shape
 * (`eval:search --tune`) without touching the vault's `.wiki/graph/`.
 *
 * Mirrors `scripts/index.ts`'s read → parse → buildIndex steps, minus every
 * write and side effect (no lock, no domain auto-registration, no artefacts).
 * Ids are fresh, so nothing here is comparable to the on-disk index by id —
 * compare by vault-relative path.
 */

import { readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import matter from "gray-matter";
import { findAllNotes, loadDomainRegistry, loadWikiConfig } from "./vault.js";
import type { VaultConfig } from "./types.js";
import { computeIsStub } from "./frontmatter.js";
import { parseNote } from "../../hooks/lib/index/parse.js";
import { buildIndex, type IndexNote, type BuildResult } from "../../hooks/lib/index/model.js";
import { P, type Manifest } from "../../hooks/lib/index/layout.js";
import type { TermConfig } from "../../hooks/lib/index/postings.js";
import type { DomainMap } from "../../hooks/lib/core/scope.js";
import { VaultView } from "../../hooks/lib/index/view.js";
import { unpackCsr } from "../../hooks/lib/graph/csr.js";

export type LoadedVault = {
  notes: IndexNote[];
  domains: DomainMap;
  knownLoose?: Set<string>;
  overrides: Map<string, string>;
  structureDirs: string[];
};

const readJson = <T,>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
};

export async function loadIndexNotes(config: VaultConfig): Promise<LoadedVault> {
  const wikiCfg = loadWikiConfig(config);
  const abstractionsEnabled = wikiCfg?.abstractions === true;
  const domains = (loadDomainRegistry(config.wikiPath).domains ?? {}) as DomainMap;
  const structure = wikiCfg?.structure;
  const domainPaths = Object.values(domains).map((d) => d.path ?? "").filter(Boolean);
  const toRel = (abs: string) => {
    const rel = relative(config.vaultPath, abs);
    return sep === "\\" ? rel.split(sep).join("/") : rel;
  };
  const notes: IndexNote[] = [];
  for (const abs of (await findAllNotes(config.vaultPath)).sort()) {
    try {
      const raw = readFileSync(abs, "utf-8");
      const st = statSync(abs);
      const { data, content } = matter(raw.replace(/^P\d{2}-\d{2}-\d{2}$/gm, ""));
      const rel = toRel(abs);
      const parsed = parseNote(rel, raw, { structure, domainPaths, frontmatter: data as never });
      notes.push({
        rel,
        parsed,
        mt: Math.round(st.mtimeMs),
        sz: st.size,
        stub: parsed.kind === "concept" ? computeIsStub(content, data, abstractionsEnabled) : false,
      });
    } catch {
      // unreadable or unparseable — skipped, as the indexer does
    }
  }
  const manifest = readJson<Manifest>(join(config.wikiPath, P.manifest));
  const overrides = new Map(Object.entries(readJson<{ overrides: Record<string, string> }>(join(config.wikiPath, P.overrides))?.overrides ?? {}));
  return {
    notes,
    domains,
    knownLoose: manifest ? new Set(manifest.knownLoose) : undefined,
    overrides,
    structureDirs: [structure?.concepts, structure?.mocs].filter((s): s is string => Boolean(s)),
  };
}

export function buildInMemory(v: LoadedVault, terms?: TermConfig): BuildResult {
  return buildIndex(v.notes, {
    domains: v.domains,
    version: 1,
    builtAt: new Date(0).toISOString(),
    overrides: v.overrides,
    knownLoose: v.knownLoose,
    structureDirs: v.structureDirs,
    terms,
  });
}

/** The public view of an in-memory build, as the module would load it, plus each id's kind. */
export function viewInMemory(v: LoadedVault, terms?: TermConfig): { view: VaultView; kind: Map<number, string> } {
  const r = buildInMemory(v, terms);
  const pub = r.public;
  const view = new VaultView({
    base: unpackCsr(pub.csr),
    sentinels: pub.sentinels,
    names: pub.names,
    aliases: pub.aliases,
    unresolved: pub.unresolved,
    postings: pub.postings,
    files: pub.files,
    nextId: r.nextId,
    domains: v.domains,
    hub: pub.hub,
    auth: pub.auth,
    terms,
  });
  return { view, kind: new Map(pub.cards.map((c) => [c.id, c.k])) };
}
