#!/usr/bin/env tsx
/**
 * commonplace records --kind source|concept|moc|domain|backlink [--match <text>] [--path <rel>]
 *
 * Print maintenance records (hooks/lib/index/records.ts) as JSONL, one record
 * per line: the public shard's, plus those of shards open in COMMONPLACE_OPEN
 * (set by the plugin to the session's open domains — never by hand).
 * `--match` keeps records whose JSON contains the text (case-insensitive);
 * `--path` keeps the record for one vault-relative path. The replacement for
 * grepping v1's `.wiki/*-index.jsonl`, which v2 no longer writes.
 */
import { parseArgs } from "node:util";
import { resolveVault, readLegacyIndex } from "./lib/vault.js";
import { RECORD_KINDS, type RecordKind } from "../hooks/lib/index/records.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    kind: { type: "string" },
    match: { type: "string" },
    path: { type: "string" },
  },
});

const kind = values.kind as RecordKind;
if (!RECORD_KINDS.includes(kind)) {
  console.error(`error: --kind must be one of ${RECORD_KINDS.join(", ")}`);
  process.exit(2);
}
const config = resolveVault(values.vault);
const needle = values.match?.toLowerCase();
for (const r of readLegacyIndex<Record<string, unknown>>(config, kind)) {
  if (values.path && r.path !== values.path && r.target !== values.path) continue;
  const line = JSON.stringify(r);
  if (needle && !line.toLowerCase().includes(needle)) continue;
  console.log(line);
}
