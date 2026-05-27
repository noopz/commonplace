#!/usr/bin/env tsx
/**
 * Inspect the vault registry.
 *   commonplace vaults [--list] [--json]
 *   commonplace vaults --match "<phrase>" [--json]
 *
 * --match returns the entries whose id/label/alias appears in the phrase.
 * The wiki-query skill uses it to resolve "search in <name>": 0 matches →
 * ask which vault; 1 → use it; >1 → ask the user to disambiguate.
 */
import { parseArgs } from "node:util";
import { loadVaultRegistry } from "./lib/vault.js";
import { matchByPhrase } from "./lib/registry.js";

const { values } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    match: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const reg = loadVaultRegistry();
const entries = values.match ? matchByPhrase(reg, values.match) : reg.vaults;

if (values.json) {
  console.log(JSON.stringify({ default: reg.default, matches: entries }));
} else if (entries.length === 0) {
  console.log(reg.vaults.length === 0 ? "No vaults registered. Run `commonplace init`." : "No matching vault.");
} else {
  for (const v of entries) {
    const tag = v.id === reg.default ? " (default)" : "";
    const aliases = v.aliases.length ? `  aliases: ${v.aliases.join(", ")}` : "";
    console.log(`${v.id}${tag}\t${v.label}\t${v.path}${aliases}`);
  }
}
