#!/usr/bin/env tsx
/**
 * `commonplace dates [--dry-run] [--json]` — backfill `published:` on source
 * notes from their labelled source line (scripts/lib/dates.ts). A note that
 * already has `published:` or `date:` is left alone, and so is one with no
 * labelled evidence: no date is ever guessed. Run `commonplace index` after.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "node:util";
import matter from "gray-matter";
import { resolveVault } from "./lib/vault.js";
import { loadIndexNotes } from "./lib/index-notes.js";
import { derivePublished, insertFrontmatterPublished } from "./lib/dates.js";

const { values: args } = parseArgs({
  options: {
    vault: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

const config = resolveVault(args.vault);
const loaded = await loadIndexNotes(config);
const written: Array<{ path: string; published: string; from: string }> = [];
let present = 0;
let noEvidence = 0;
let noFrontmatter = 0;
for (const n of loaded.notes) {
  if (n.parsed.kind !== "source") continue;
  if (n.parsed.published) {
    present++;
    continue;
  }
  const abs = join(config.vaultPath, n.rel);
  const raw = readFileSync(abs, "utf-8");
  const d = derivePublished(matter(raw).content);
  if (!d) {
    noEvidence++;
    continue;
  }
  const next = insertFrontmatterPublished(raw, d.published);
  if (!next) {
    noFrontmatter++;
    continue;
  }
  if (!args["dry-run"]) writeFileSync(abs, next);
  written.push({ path: n.rel, ...d });
}

const summary = { written: written.length, present, noEvidence, noFrontmatter, dryRun: args["dry-run"] };
if (args.json) console.log(JSON.stringify({ ...summary, notes: written }, null, 2));
else {
  console.log(JSON.stringify(summary));
  for (const w of written.slice(0, 15)) console.log(`  ${w.published}  (${w.from})  ${w.path}`);
  if (written.length > 15) console.log(`  … ${written.length - 15} more`);
}
