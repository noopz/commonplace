import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { ParsedNote } from "./types.js";

/**
 * Vault-specific quality conventions, read from `.wiki/conventions.json`.
 *
 * The plugin code is a generic harness — it knows how to evaluate predicates
 * and apply per-genre rules, but it doesn't know what *your* blog posts look
 * like or which paths are research. That lives in the vault, alongside
 * domains.json, so each vault declares its own legality spec.
 *
 * AutoHarness analogy: the lint checks are action verifiers; conventions.json
 * is the per-vault constraint specification they validate against.
 */

export type GenrePredicate =
  | { "cssclasses-contains": string }
  | { "tags-contains": string }
  | { "frontmatter-has": string }
  | { "frontmatter-equals": { key: string; value: string | number | boolean } }
  | { "path-prefix": string }
  | { all: GenrePredicate[] }
  | { any: GenrePredicate[] };

export type LeadLinkMode = "strict" | "lenient" | "skip";
export type CitationMode = "required" | "skip";

export interface GenreRules {
  "lead-link"?: LeadLinkMode;
  "external-source-citation"?: CitationMode;
}

export interface GenreDefinition {
  name: string;
  detect: GenrePredicate;
  rules: GenreRules;
}

export interface SingletonConceptConfig { enabled: boolean; "min-backlinks": number; }
export interface LeadLinkConfig { "lenient-paragraphs": number; "summary-headings": string[]; }
export interface OverlinkedConfig { enabled: boolean; "max-density": number; }
export interface SingletonMocConfig { enabled: boolean; "min-sources": number; }

export interface CheckConfig {
  "singleton-concept": SingletonConceptConfig;
  "lead-link": LeadLinkConfig;
  overlinked: OverlinkedConfig;
  "singleton-moc": SingletonMocConfig;
}

export interface Conventions {
  version: number;
  genres: GenreDefinition[];
  default: GenreRules;
  checks: CheckConfig;
}

export const DEFAULT_CONVENTIONS: Conventions = {
  version: 1,
  genres: [],
  default: { "lead-link": "strict", "external-source-citation": "skip" },
  checks: {
    "singleton-concept": { enabled: true, "min-backlinks": 2 },
    "lead-link": {
      "lenient-paragraphs": 3,
      "summary-headings": ["Summary", "Overview", "TL;DR"],
    },
    overlinked: { enabled: false, "max-density": 0.05 },
    "singleton-moc": { enabled: true, "min-sources": 2 },
  },
};

export interface MatchedGenre {
  name: string;
  rules: Required<GenreRules>;
}

export function loadConventions(wikiPath: string): Conventions {
  const path = join(wikiPath, "conventions.json");
  if (!existsSync(path)) return DEFAULT_CONVENTIONS;
  try {
    const partial = JSON.parse(readFileSync(path, "utf-8")) as Partial<Conventions>;
    return mergeWithDefaults(partial);
  } catch {
    console.error("Warning: could not parse conventions.json, using defaults");
    return DEFAULT_CONVENTIONS;
  }
}

function mergeWithDefaults(partial: Partial<Conventions>): Conventions {
  const dc = DEFAULT_CONVENTIONS.checks;
  const pc = partial.checks ?? ({} as Partial<CheckConfig>);
  return {
    version: partial.version ?? 1,
    genres: partial.genres ?? [],
    default: { ...DEFAULT_CONVENTIONS.default, ...(partial.default ?? {}) },
    checks: {
      "singleton-concept": { ...dc["singleton-concept"], ...(pc["singleton-concept"] ?? {}) },
      "lead-link": { ...dc["lead-link"], ...(pc["lead-link"] ?? {}) },
      overlinked: { ...dc.overlinked, ...(pc.overlinked ?? {}) },
      "singleton-moc": { ...dc["singleton-moc"], ...(pc["singleton-moc"] ?? {}) },
    },
  };
}

/**
 * Returns the first genre whose predicate matches the note. If no genre
 * matches, returns the synthetic "default" genre using `conventions.default`.
 *
 * Rules are merged: a genre's `rules` override the default for any keys it
 * specifies, but unspecified keys fall back to `default`.
 */
export function matchGenre(
  note: ParsedNote,
  vaultPath: string,
  conventions: Conventions,
): MatchedGenre {
  for (const genre of conventions.genres) {
    if (evaluatePredicate(genre.detect, note, vaultPath)) {
      return {
        name: genre.name,
        rules: resolveRules(conventions.default, genre.rules),
      };
    }
  }
  return { name: "default", rules: resolveRules(conventions.default, {}) };
}

function resolveRules(
  base: GenreRules,
  override: GenreRules,
): Required<GenreRules> {
  return {
    "lead-link": override["lead-link"] ?? base["lead-link"] ?? "strict",
    "external-source-citation":
      override["external-source-citation"] ?? base["external-source-citation"] ?? "skip",
  };
}

function evaluatePredicate(
  pred: GenrePredicate,
  note: ParsedNote,
  vaultPath: string,
): boolean {
  if ("all" in pred) return pred.all.every((p) => evaluatePredicate(p, note, vaultPath));
  if ("any" in pred) return pred.any.some((p) => evaluatePredicate(p, note, vaultPath));
  if ("cssclasses-contains" in pred) {
    const cls = note.frontmatter.cssclasses;
    return Array.isArray(cls) && cls.some((c) => String(c) === pred["cssclasses-contains"]);
  }
  if ("tags-contains" in pred) {
    const tags = note.frontmatter.tags;
    return Array.isArray(tags) && tags.some((t) => String(t) === pred["tags-contains"]);
  }
  if ("frontmatter-has" in pred) {
    const v = note.frontmatter[pred["frontmatter-has"]];
    return v !== undefined && v !== null && v !== "";
  }
  if ("frontmatter-equals" in pred) {
    const { key, value } = pred["frontmatter-equals"];
    return note.frontmatter[key] === value;
  }
  if ("path-prefix" in pred) {
    const rel = note.filePath.startsWith(vaultPath + "/")
      ? note.filePath.slice(vaultPath.length + 1)
      : note.filePath;
    return rel.startsWith(pred["path-prefix"]);
  }
  return false;
}
