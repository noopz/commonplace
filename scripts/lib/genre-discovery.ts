import { readFileSync } from "fs";
import { glob } from "glob";
import type { Conventions, GenreDefinition } from "./conventions.js";
import { DEFAULT_CONVENTIONS, loadConventions } from "./conventions.js";

/**
 * Genre discovery: deterministic scan over a sample of vault notes that
 * surfaces candidate genres for `.wiki/conventions.json`. The synthesis
 * half — what rules each genre should follow — is delegated to the
 * wiki-conventions-tuner agent.
 *
 * Used by `commonplace init` (initial bootstrap), the indexer (incremental
 * auto-discovery as new genres cross the threshold), and the standalone
 * `commonplace discover-genres` CLI.
 */

const SAMPLE_LIMIT = 200;
const MIN_GENRE_NOTES = 3;

export interface NoteSample {
  /** Up to 2 path segments deep, e.g. "07 - Blog" or "02 - Research/AI Development" */
  relDir: string;
  /** Raw frontmatter text between the leading and trailing --- */
  fm: string;
}

export interface GenreDiscoveryResult {
  conventions: Conventions;
  /** Genres newly added by this discovery pass (didn't exist before) */
  newGenres: string[];
  /** Genres in the result with empty `rules: {}` (need the tuner agent) */
  untunedGenres: string[];
  /** True if `conventions.json` would change versus what's currently on disk */
  changed: boolean;
}

export function parseCssclasses(fmText: string): string[] {
  const out: string[] = [];
  const inline = fmText.match(/^cssclasses:\s*\[([^\]]*)\]/m);
  if (inline) {
    for (const v of inline[1].split(",").map((t) => t.trim().replace(/['"]/g, ""))) {
      if (v) out.push(v);
    }
  }
  const block = fmText.match(/^cssclasses:\s*\n((?:\s+-[^\n]+\n?)*)/m);
  if (block) {
    for (const m of block[1].matchAll(/^\s+-\s+(.+)$/gm)) {
      const v = m[1].trim().replace(/['"]/g, "");
      if (v) out.push(v);
    }
  }
  return out;
}

/**
 * Sample the vault for genre discovery. Reads up to SAMPLE_LIMIT notes,
 * extracts frontmatter text + 2-segment relative directory.
 */
export async function loadGenreSamples(vaultPath: string): Promise<NoteSample[]> {
  const allFiles = await glob("**/*.md", {
    cwd: vaultPath,
    absolute: true,
    ignore: [".obsidian/**", ".wiki/**", "node_modules/**"],
  });
  const samples: NoteSample[] = [];
  for (const filePath of allFiles.slice(0, SAMPLE_LIMIT)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      const fm = fmMatch ? fmMatch[1] : "";
      const parts = filePath.slice(vaultPath.length + 1).split("/");
      const relDir =
        parts.length >= 3 ? parts.slice(0, 2).join("/") : parts.slice(0, 1).join("/");
      samples.push({ relDir, fm });
    } catch {
      /* skip unreadable files */
    }
  }
  return samples;
}

/**
 * Run genre discovery against a set of samples. Preserves user-tuned rules
 * across runs by matching genres on `name`. Genre order is deterministic:
 * cssclass-based genres first (most explicit signal), then path-prefix.
 */
export function discoverGenres(
  samples: NoteSample[],
  structureDirs: Set<string>,
  wikiPath: string,
): GenreDiscoveryResult {
  const cssCounts = new Map<string, number>();
  const dirCounts = new Map<string, number>();

  for (const s of samples) {
    for (const v of parseCssclasses(s.fm)) {
      cssCounts.set(v, (cssCounts.get(v) ?? 0) + 1);
    }
    if (s.relDir && /^tags:/m.test(s.fm)) {
      const top = s.relDir.split("/")[0];
      if (top && top !== "raw") {
        dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
      }
    }
  }

  const existing = loadConventions(wikiPath);
  const existingByName = new Map<string, GenreDefinition>();
  for (const g of existing.genres) existingByName.set(g.name, g);

  const discovered: GenreDefinition[] = [];
  const newGenres: string[] = [];

  // Pass 1: cssclasses-based genres (explicit user marking, strongest signal)
  for (const [value, count] of [...cssCounts.entries()].sort((a, b) => b[1] - a[1])) {
    if (count < MIN_GENRE_NOTES) continue;
    const prior = existingByName.get(value);
    if (prior) {
      discovered.push(prior);
      existingByName.delete(value);
    } else {
      discovered.push({ name: value, detect: { "cssclasses-contains": value }, rules: {} });
      newGenres.push(value);
    }
  }

  // Pass 2: path-prefix genres (top-level dirs, excluding concept/MOC dirs)
  for (const [dir, count] of [...dirCounts.entries()].sort((a, b) => b[1] - a[1])) {
    if (count < MIN_GENRE_NOTES) continue;
    if (structureDirs.has(dir)) continue;
    const cleanName = dir.replace(/^\d+\s*-\s*/, "");
    const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) continue;
    const prior = existingByName.get(slug);
    if (prior) {
      discovered.push(prior);
      existingByName.delete(slug);
      continue;
    }
    discovered.push({ name: slug, detect: { "path-prefix": `${dir}/` }, rules: {} });
    newGenres.push(slug);
  }

  // Preserve any custom user-defined genres init didn't rediscover (e.g.
  // user added a custom predicate by hand-editing conventions.json)
  for (const g of existingByName.values()) discovered.push(g);

  const conventions: Conventions = {
    version: 1,
    genres: discovered,
    default: existing.default,
    checks: existing.checks,
  };

  const untunedGenres = discovered
    .filter((g) => Object.keys(g.rules).length === 0)
    .map((g) => g.name);

  // Detect if anything actually changed — compares the genre set + rules.
  // Order-sensitive on purpose; cssclass→path-prefix ordering matters for
  // first-match-wins semantics.
  const changed =
    JSON.stringify(existing.genres) !== JSON.stringify(discovered) ||
    newGenres.length > 0;

  return { conventions, newGenres, untunedGenres, changed };
}
