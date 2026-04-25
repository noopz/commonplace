#!/usr/bin/env tsx
/**
 * Discover genre signals from the vault and write `.wiki/conventions.json`.
 *
 * Standalone version of the discovery step also run by `commonplace init`
 * and the indexer. Use this command when you've added new content that
 * may have crossed the ≥3-note threshold for a new genre, or to refresh
 * conventions.json after restructuring directories.
 *
 * Usage: commonplace discover-genres [--vault <path>]
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";
import { resolveVault, loadWikiConfig } from "./lib/vault.js";
import { discoverGenres, loadGenreSamples } from "./lib/genre-discovery.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const config = resolveVault(values.vault);
const cfg = loadWikiConfig(config);

// Concept and MOC dirs have their own classification — exclude from
// path-prefix discovery. Sources dir IS a meaningful genre.
const structureDirs = new Set(
  [cfg?.structure.concepts, cfg?.structure.mocs].filter((s): s is string => Boolean(s)),
);

const samples = await loadGenreSamples(config.vaultPath);
const result = discoverGenres(samples, structureDirs, config.wikiPath);

writeFileSync(
  join(config.wikiPath, "conventions.json"),
  JSON.stringify(result.conventions, null, 2) + "\n",
);

if (values.json) {
  console.log(
    JSON.stringify(
      {
        status: "ok",
        total: result.conventions.genres.length,
        new: result.newGenres,
        untuned: result.untunedGenres,
        changed: result.changed,
      },
      null,
      2,
    ),
  );
} else {
  const total = result.conventions.genres.length;
  if (result.newGenres.length > 0) {
    console.log(
      `Discovered ${result.newGenres.length} new genre(s): ${result.newGenres.join(", ")}`,
    );
    console.log(`conventions.json now has ${total} genre(s).`);
  } else if (result.changed) {
    console.log(`Genre set unchanged in count, but order or detection signals shifted.`);
  } else {
    console.log(`No new genres. ${total} genre(s) already registered.`);
  }
  if (result.untunedGenres.length > 0) {
    console.log("");
    console.log(
      `${result.untunedGenres.length} genre(s) need rules: ${result.untunedGenres.join(", ")}`,
    );
    console.log(`Dispatch the wiki-conventions-tuner agent to propose rules.`);
  }
}
