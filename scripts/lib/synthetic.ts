/**
 * Deterministic synthetic vault generator — the corpus `eval:scale` measures.
 *
 * Every word is drawn from the fixed LEXICON below; nothing is copied from,
 * or derived from, any real vault (the repo is public). Only the STRUCTURE
 * imitates a commonplace vault:
 *
 *   - base 1× ≈ 340 sources, 450 concepts, 50 MOCs (839 notes, the plan's
 *     §3.7 base), multiplied by `scale`
 *   - ~8 body wikilinks per note on average, with concept targets drawn from a
 *     Zipf distribution so a few hub concepts collect hundreds of in-links
 *   - `aliases:` on ~10% of concepts, some links written through the alias or
 *     with a `|display` text
 *   - typed relations (`builds_on`/`compares_with`/`uses_method`) on ~20% of
 *     sources
 *   - eight domains in `.wiki/domains.json`: five public, three private (two
 *     sharing a linkGroup)
 *   - scaffolding the indexer must EXCLUDE: a `_templates/` dir and `_raw/`
 *     dumps (underscore dirs), and `.trash/` (dot dir), all holding
 *     source-shaped notes that would pollute the index if discovered
 *
 * Same (scale, seed) → byte-identical tree; `hash` is a sha256 over the
 * sorted (path, content) pairs so tests can assert it.
 */
import { mkdirSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";

export const BASE = { sources: 340, concepts: 450, mocs: 50, journal: 10 } as const;

export const LEXICON = [
  "alpha", "gamma", "drift", "lattice", "vector", "anchor", "ember", "quorum",
  "signal", "sparse", "kernel", "orbit", "flux", "prism", "cascade", "ridge",
  "harbor", "meadow", "cipher", "relay", "mosaic", "vertex", "fabric", "pulse",
  "tide", "glyph", "beacon", "thorn", "willow", "basalt", "lumen", "cobalt",
  "falcon", "marble", "nimbus", "quartz", "rune", "sable", "tundra", "umber",
  "vale", "wisp", "zephyr", "amber", "bramble", "cinder", "dune", "fern",
  "granite", "heron", "iris", "jade", "kestrel", "lichen", "mesa", "nectar",
  "onyx", "pebble", "quill", "russet", "spire", "tallow", "vortex", "yarrow",
] as const;

const FILLER = ["of", "and", "with", "under", "across", "for", "via", "in"] as const;
const SOURCE_TAGS = ["paper", "article", "report", "project", "note", "whitepaper"] as const;

export interface SyntheticDomain {
  slug: string;
  path: string;
  scope: "public" | "private";
  linkGroup?: string;
  /** relative share of sources */
  weight: number;
}

export const DOMAINS: SyntheticDomain[] = [
  { slug: "alpha", path: "02 - Research/Alpha", scope: "public", weight: 6 },
  { slug: "beta", path: "02 - Research/Beta", scope: "public", weight: 4 },
  { slug: "gamma", path: "02 - Research/Gamma", scope: "public", weight: 3 },
  { slug: "delta", path: "02 - Research/Delta", scope: "public", weight: 2 },
  { slug: "kappa", path: "02 - Research/Kappa", scope: "public", weight: 2 },
  { slug: "sigma", path: "06 - Private/Sigma", scope: "private", weight: 1 },
  { slug: "tau", path: "06 - Private/Tau", scope: "private", linkGroup: "ledger", weight: 1 },
  { slug: "upsilon", path: "06 - Private/Upsilon", scope: "private", linkGroup: "ledger", weight: 1 },
];

export const STRUCTURE = {
  sources: "02 - Research",
  concepts: "03 - Concepts",
  mocs: "04 - Maps",
} as const;

export const EXCLUDED_DIRS = ["_templates", "02 - Research/Alpha/_raw", ".trash"] as const;

export interface SyntheticOptions {
  scale: number;
  out: string;
  seed?: number;
  /** skip writing to disk (tests that only need the manifest) */
  dryRun?: boolean;
}

export interface SyntheticResult {
  out: string;
  scale: number;
  seed: number;
  counts: {
    sources: number;
    concepts: number;
    mocs: number;
    journal: number;
    excluded: number;
    files: number;
    bodyLinks: number;
    aliasedConcepts: number;
    typedSources: number;
    stubs: number;
  };
  /** in-degree (body links) of the most-linked concept */
  maxConceptInDegree: number;
  hubName: string;
  hash: string;
  ms: number;
}

/** mulberry32 — tiny, fast, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cap = (w: string) => w[0].toUpperCase() + w.slice(1);

/**
 * Lexicon-only query strings for seed/connect benchmarks. Separate stream
 * from the generator so changing the query count never perturbs the vault.
 */
export function sampleQueries(n: number, seed = 1): string[] {
  const r = rng(seed ^ 0x9e3779b9);
  const pick = () => LEXICON[Math.floor(r() * LEXICON.length)];
  return Array.from({ length: n }, () => {
    const k = 2 + Math.floor(r() * 3);
    return Array.from({ length: k }, pick).join(" ");
  });
}

export function generateSynthetic(opts: SyntheticOptions): SyntheticResult {
  const t0 = performance.now();
  const seed = opts.seed ?? 1;
  const scale = opts.scale;
  if (!(scale > 0)) throw new Error("scale must be > 0");
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T>(arr: readonly T[]): T => arr[int(arr.length)];
  const word = () => pick(LEXICON);

  const nSources = Math.max(1, Math.round(BASE.sources * scale));
  const nConcepts = Math.max(1, Math.round(BASE.concepts * scale));
  const nMocs = Math.max(1, Math.round(BASE.mocs * scale));
  const nJournal = Math.max(1, Math.round(BASE.journal * scale));

  // Every resolvable key (title + alias) is unique case-insensitively, as the
  // resolver keys on the lowercased stem.
  const taken = new Set<string>();
  const uniqueName = (min: number, span: number, suffix = ""): string => {
    for (let words = min; ; words++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const k = words + int(span);
        const parts = Array.from({ length: k }, () => cap(word()));
        const name = parts.join(" ") + suffix;
        const key = name.toLowerCase();
        if (!taken.has(key)) { taken.add(key); return name; }
      }
    }
  };

  const concepts = Array.from({ length: nConcepts }, () => uniqueName(2, 2));
  const sources = Array.from({ length: nSources }, () => {
    // Source titles read like sentences: Word Word filler Word Word
    for (;;) {
      const t = `${cap(word())} ${cap(word())} ${pick(FILLER)} ${cap(word())} ${cap(word())}`;
      if (!taken.has(t.toLowerCase())) { taken.add(t.toLowerCase()); return t; }
    }
  });
  const mocs = Array.from({ length: nMocs }, () => uniqueName(1, 2, " Map"));

  // Aliases: ~10% of concepts, reversed word order or initials-style.
  const aliases: (string | null)[] = concepts.map((c) => {
    if (r() >= 0.1) return null;
    const parts = c.split(" ");
    const candidates = [
      parts.slice().reverse().join(" "),
      parts.map((p) => p[0]).join("").toUpperCase() + "-" + cap(word()),
    ];
    for (const a of candidates) {
      if (!taken.has(a.toLowerCase())) { taken.add(a.toLowerCase()); return a; }
    }
    return null;
  });

  // Zipf(s=1) over a random permutation of concepts → a handful of hubs.
  const perm = concepts.map((_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const cum = new Float64Array(nConcepts);
  let acc = 0;
  for (let rank = 0; rank < nConcepts; rank++) { acc += 1 / (rank + 1); cum[rank] = acc; }
  const zipfConcept = (): number => {
    const x = r() * acc;
    let lo = 0, hi = nConcepts - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; }
    return perm[lo];
  };
  const conceptIn = new Int32Array(nConcepts);
  const linkConcept = (i: number): string => {
    conceptIn[i]++;
    const a = aliases[i];
    const roll = r();
    if (a && roll < 0.3) return `[[${a}]]`;
    if (roll > 0.9) return `[[${concepts[i]}|${concepts[i].toLowerCase()}]]`;
    return `[[${concepts[i]}]]`;
  };

  const sentence = (n: number) => {
    const ws = Array.from({ length: n }, () => (r() < 0.15 ? pick(FILLER) : word()));
    return cap(ws.join(" ")) + ".";
  };
  const abstraction = () => Array.from({ length: 6 + int(5) }, () => (r() < 0.2 ? pick(FILLER) : word())).join(" ");
  const date = () => {
    const y = 2023 + int(3), m = 1 + int(12), d = 1 + int(28);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  const q = (s: string) => JSON.stringify(s);
  const yamlList = (key: string, items: string[]) =>
    items.length ? `${key}:\n${items.map((i) => `  - ${q(i)}`).join("\n")}\n` : "";

  // Domain picker by weight.
  const totalW = DOMAINS.reduce((s, d) => s + d.weight, 0);
  const pickDomain = () => {
    let x = r() * totalW;
    for (const d of DOMAINS) { if ((x -= d.weight) < 0) return d; }
    return DOMAINS[0];
  };

  const files: Array<[string, string]> = [];
  let bodyLinks = 0;
  let typedSources = 0;
  let stubs = 0;

  // Sources ---------------------------------------------------------------
  const sourceMoc = new Int32Array(nSources);
  const mocMembers: number[][] = Array.from({ length: nMocs }, () => []);
  const conceptSources: number[][] = Array.from({ length: nConcepts }, () => []);
  for (let i = 0; i < nSources; i++) {
    const dom = pickDomain();
    const m = int(nMocs);
    sourceMoc[i] = m;
    mocMembers[m].push(i);
    const fmConcepts = new Set<number>();
    const nFm = 3 + int(4);
    while (fmConcepts.size < Math.min(nFm, nConcepts)) fmConcepts.add(zipfConcept());
    for (const c of fmConcepts) conceptSources[c].push(i);

    let typed = "";
    if (r() < 0.2 && i > 0) {
      typedSources++;
      const rels: string[] = [];
      const kinds = 1 + int(3);
      rels.push(yamlList("builds_on", [`[[${sources[int(i)]}]]`]));
      if (kinds >= 2) rels.push(yamlList("compares_with", [`[[${sources[int(i)]}]]`]));
      if (kinds >= 3) rels.push(yamlList("uses_method", [`[[${concepts[zipfConcept()]}]]`]));
      typed = rels.join("");
    }

    const keyPoints: string[] = [];
    const nBody = 6 + int(5); // 6..10 body links
    for (let k = 0; k < nBody - 2; k++) {
      keyPoints.push(`- ${sentence(5 + int(6))} ${linkConcept(zipfConcept())}`);
    }
    // one link to a sibling source, one to the MOC
    const sib = sources[int(nSources)];
    keyPoints.push(`- Compare [[${sib}]].`);
    bodyLinks += nBody;

    const fm =
      `---\n` +
      `type: source\n` +
      `title: ${q(sources[i])}\n` +
      `tags:\n  - ${pick(SOURCE_TAGS)}\n  - ${dom.slug}\n` +
      `created: ${date()}\n` +
      `source: ${q(`https://example.org/${dom.slug}/${seed}-${i}`)}\n` +
      `abstraction: ${q(abstraction())}\n` +
      yamlList("concepts", [...fmConcepts].map((c) => `[[${concepts[c]}]]`)) +
      yamlList("mocs", [`[[${mocs[m]}]]`]) +
      typed +
      `---\n`;
    const body =
      `# ${sources[i]}\n\n## Summary\n\n${sentence(18)} ${sentence(14)}\n\n` +
      `## Key Points\n\n${keyPoints.join("\n")}\n\n` +
      `## Connections\n\n- Part of [[${mocs[m]}]]\n`;
    const path = `${dom.path}/${sources[i]}.md`;
    files.push([path, fm + body]);
  }

  // Concepts --------------------------------------------------------------
  for (let i = 0; i < nConcepts; i++) {
    const isStub = r() < 0.08;
    const al = aliases[i];
    const fmHead =
      `---\n` +
      `type: concept\n` +
      (al ? `aliases:\n  - ${q(al)}\n` : "") +
      `tags:\n  - concept\n` +
      `created: ${date()}\n`;
    if (isStub) {
      stubs++;
      files.push([
        `${STRUCTURE.concepts}/${concepts[i]}.md`,
        fmHead + `---\n# ${concepts[i]}\n\nDefinition pending - please update.\n`,
      ]);
      continue;
    }
    const related: string[] = [];
    const nRel = 4 + int(5); // 4..8
    for (let k = 0; k < nRel; k++) {
      let c = zipfConcept();
      if (c === i) c = (c + 1) % nConcepts;
      related.push(`- ${linkConcept(c)} — ${sentence(4 + int(5))}`);
    }
    const srcs = conceptSources[i].slice(0, 3).map((s) => `- [[${sources[s]}]]`);
    bodyLinks += nRel + srcs.length;
    files.push([
      `${STRUCTURE.concepts}/${concepts[i]}.md`,
      fmHead +
        `abstraction: ${q(abstraction())}\n` +
        `---\n# ${concepts[i]}\n\n## Definition\n\n${sentence(16)} ${sentence(12)}\n\n` +
        `## Related\n\n${related.join("\n")}\n` +
        (srcs.length ? `\n## Sources\n\n${srcs.join("\n")}\n` : ""),
    ]);
  }

  // MOCs ------------------------------------------------------------------
  for (let i = 0; i < nMocs; i++) {
    const members = mocMembers[i];
    const keyConcepts = new Set<number>();
    while (keyConcepts.size < Math.min(4, nConcepts)) keyConcepts.add(zipfConcept());
    bodyLinks += members.length + keyConcepts.size;
    files.push([
      `${STRUCTURE.mocs}/${mocs[i]}.md`,
      `---\ntype: moc\ntags:\n  - moc\ncreated: ${date()}\n---\n# ${mocs[i]}\n\n${sentence(12)}\n\n` +
        `## Sources (${members.length})\n\n${members.map((s) => `- [[${sources[s]}]]`).join("\n")}\n\n` +
        `## Key Concepts\n\n${[...keyConcepts].map((c) => `- ${linkConcept(c)}`).join("\n")}\n`,
    ]);
  }

  // Journal ("other" notes outside any domain that still link concepts) ---
  for (let i = 0; i < nJournal; i++) {
    const links = Array.from({ length: 4 }, () => `- ${linkConcept(zipfConcept())}`);
    bodyLinks += links.length;
    files.push([
      `01 - Journal/Entry ${String(i + 1).padStart(5, "0")}.md`,
      `---\ntags:\n  - journal\ncreated: ${date()}\n---\n# Entry ${i + 1}\n\n${sentence(10)}\n\n${links.join("\n")}\n`,
    ]);
  }

  // Excluded scaffolding — source-shaped so discovering it would show. ----
  const nExcluded = Math.max(3, Math.round(3 * scale));
  const junk = (title: string) =>
    `---\ntype: source\ntitle: ${q(title)}\nconcepts:\n  - "[[${concepts[0]}]]"\n---\n# ${title}\n\n[[${concepts[zipfConcept()]}]] ${sentence(8)}\n`;
  let excluded = 0;
  files.push(["_templates/Source Template.md", junk("Source Template")]);
  excluded++;
  for (let i = 0; i < nExcluded; i++) {
    files.push([`02 - Research/Alpha/_raw/Raw Dump ${i + 1}.md`, junk(`Raw Dump ${i + 1}`)]);
    files.push([`.trash/Discarded ${i + 1}.md`, junk(`Discarded ${i + 1}`)]);
    excluded += 2;
  }

  // .wiki config + domain registry ---------------------------------------
  const domainsJson = {
    domains: Object.fromEntries(
      DOMAINS.map((d) => [d.slug, { path: d.path, scope: d.scope, ...(d.linkGroup ? { linkGroup: d.linkGroup } : {}) }]),
    ),
  };
  const configJson = {
    structure: STRUCTURE,
    stubPattern: "Definition pending",
    mocCountPattern: "## Sources (N)",
    abstractions: true,
  };
  files.push([".wiki/domains.json", JSON.stringify(domainsJson, null, 2) + "\n"]);
  files.push([".wiki/config.json", JSON.stringify(configJson, null, 2) + "\n"]);
  files.push([".obsidian/app.json", "{}\n"]);

  // Hash over sorted (path, content).
  const sorted = files.slice().sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash("sha256");
  for (const [p, c] of sorted) { h.update(p); h.update("\0"); h.update(c); h.update("\0"); }
  const hash = h.digest("hex");

  if (!opts.dryRun) {
    const made = new Set<string>();
    for (const [p, c] of files) {
      const abs = join(opts.out, p);
      const dir = dirname(abs);
      if (!made.has(dir)) { mkdirSync(dir, { recursive: true }); made.add(dir); }
      writeFileSync(abs, c);
    }
  }

  let hub = 0;
  for (let i = 1; i < nConcepts; i++) if (conceptIn[i] > conceptIn[hub]) hub = i;

  return {
    out: opts.out,
    scale,
    seed,
    counts: {
      sources: nSources,
      concepts: nConcepts,
      mocs: nMocs,
      journal: nJournal,
      excluded,
      files: files.length,
      bodyLinks,
      aliasedConcepts: aliases.filter(Boolean).length,
      typedSources,
      stubs,
    },
    maxConceptInDegree: conceptIn[hub],
    hubName: concepts[hub],
    hash,
    ms: Math.round(performance.now() - t0),
  };
}
