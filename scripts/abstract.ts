#!/usr/bin/env tsx
/**
 * Backfill `abstraction:` frontmatter across a vault's source + concept
 * notes, deriving deterministically from existing body text (## Summary
 * first sentence for sources; definition paragraph for concepts). Stubs
 * are skipped by design — an absent abstraction is what marks them.
 *
 * On successful non-dry-run completion, sets `"abstractions": true` in
 * .wiki/config.json — the adoption flag that switches isStub semantics
 * and validation to require the field. Run `commonplace index` afterwards
 * to re-emit the indexes with the new field.
 *
 * Byte-safety: the only change ever written is one inserted frontmatter
 * line; notes without closed frontmatter are skipped and reported.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { parseArgs } from "node:util";
import { resolveVault, findAllNotes, classifyNote } from "./lib/vault.js";
import { parseNote, isStub } from "./lib/frontmatter.js";
import {
  deriveAbstraction,
  extractSummaryParagraph,
  extractConceptDefinition,
  insertFrontmatterAbstraction,
} from "./lib/abstract.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

const config = resolveVault(values.vault);
const files = await findAllNotes(config.vaultPath);

const written: Array<{ path: string; abstraction: string }> = [];
const skipped: Array<{ path: string; reason: string }> = [];
let present = 0;

for (const f of files) {
  const noteType = classifyNote(f, config.vaultPath);
  if (noteType !== "source" && noteType !== "concept") continue;

  let parsed;
  try {
    parsed = parseNote(f, config.vaultPath);
  } catch {
    skipped.push({ path: f, reason: "parse-error" });
    continue;
  }

  const existing = parsed.frontmatter.abstraction;
  if (typeof existing === "string" && existing.trim().length > 0) {
    present++;
    continue;
  }
  if (noteType === "concept" && isStub(parsed.body)) {
    skipped.push({ path: f, reason: "stub" });
    continue;
  }

  const para =
    noteType === "source"
      ? extractSummaryParagraph(parsed.body)
      : extractConceptDefinition(parsed.body);
  if (!para) {
    skipped.push({ path: f, reason: "no-derivable-text" });
    continue;
  }
  const abstraction = deriveAbstraction(para);
  if (!abstraction) {
    skipped.push({ path: f, reason: "too-thin" });
    continue;
  }
  const newRaw = insertFrontmatterAbstraction(parsed.raw, abstraction);
  if (!newRaw) {
    skipped.push({ path: f, reason: "no-frontmatter" });
    continue;
  }
  if (!values["dry-run"]) writeFileSync(f, newRaw);
  written.push({ path: f, abstraction });
}

if (!values["dry-run"]) {
  const cfgPath = join(config.wikiPath, "config.json");
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf-8")) : {};
  if (cfg.abstractions !== true) {
    cfg.abstractions = true;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  }
}

const summary = {
  dryRun: values["dry-run"],
  written: written.length,
  alreadyPresent: present,
  skipped,
  notes: written,
};

if (values.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const verb = values["dry-run"] ? "Would write" : "Wrote";
  console.log(`${verb} ${written.length} abstractions (${present} already present, ${skipped.length} skipped)`);
  for (const s of skipped) console.log(`  skipped (${s.reason}): ${s.path}`);
  if (!values["dry-run"]) {
    console.log(`Vault flagged abstractions: true — run \`commonplace index\` to re-emit indexes.`);
  }
}
