#!/usr/bin/env tsx
/**
 * Deterministic MOC reconciliation. Updates each MOC's "## Papers (N)"
 * header to match the indexed sourceCount and ensures every source in
 * the index appears as a bullet in the Papers section.
 *
 * MOCs are public-only — private sources are filtered out and a warning
 * is emitted (latent scope violation).
 */

import { readFileSync, writeFileSync } from "fs";
import { parseArgs } from "util";
import { resolveVault, ensureIndex, loadIndexes } from "./lib/vault.js";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
  },
});

const config = resolveVault();
if (!ensureIndex(config)) {
  console.error("moc:sync: index not built — run `commonplace index` first");
  process.exit(1);
}

const { sources, mocs } = loadIndexes(config);
const sourceScopeByTitle = new Map(sources.map((s) => [s.title, s.scope]));

let modified = 0;

for (const moc of mocs) {
  let raw: string;
  try {
    raw = readFileSync(moc.path, "utf-8");
  } catch {
    continue;
  }

  // Filter out private sources; warn loudly on each (latent scope violation).
  const publicSources: string[] = [];
  for (const title of moc.sources) {
    const scope = sourceScopeByTitle.get(title);
    if (scope === "private") {
      console.error(
        `moc:sync: WARNING — MOC "${moc.name}" lists private source "${title}" — filtering out (scope violation)`,
      );
      continue;
    }
    publicSources.push(title);
  }

  const desiredCount = publicSources.length;

  // Locate "## Papers (N)" header line.
  const headerRegex = /^##[ \t]+Papers[ \t]*\(\d+\)[ \t]*$/m;
  const headerMatch = raw.match(headerRegex);
  if (!headerMatch || headerMatch.index === undefined) {
    // No Papers header — skip rather than synthesize one.
    continue;
  }

  const headerStart = headerMatch.index;
  const headerEnd = headerStart + headerMatch[0].length;

  // Section runs to the next "## " header or end of file.
  const remainder = raw.slice(headerEnd);
  const nextHeaderMatch = remainder.match(/\n##\s+/);
  const sectionEnd = nextHeaderMatch
    ? headerEnd + (nextHeaderMatch.index ?? 0) + 1 // include the leading \n
    : raw.length;

  const section = raw.slice(headerEnd, sectionEnd);

  // Existing wikilink targets in this section.
  const linkRegex = /\[\[([^\[\]|]+?)(?:\|[^\]]+)?\]\]/g;
  const existing = new Set<string>();
  for (const m of section.matchAll(linkRegex)) {
    existing.add(m[1].trim());
  }

  const missing = publicSources.filter((t) => !existing.has(t));

  // Compute new header line.
  const newHeader = `## Papers (${desiredCount})`;

  // If nothing changes (count + no missing + no private listed in section),
  // skip writing. Note: a private source might still be present in section
  // text — handle that by removing its bullet line if found.
  const privateListedInSection: string[] = [];
  for (const m of section.matchAll(linkRegex)) {
    const t = m[1].trim();
    if (sourceScopeByTitle.get(t) === "private") privateListedInSection.push(t);
  }

  let newSection = section;

  // Remove bullet lines that wikilink a private source.
  if (privateListedInSection.length > 0) {
    const lines = newSection.split("\n");
    const kept = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("- ") && !trimmed.startsWith("* ")) return true;
      // Does this bullet wikilink a private source?
      const m = [...line.matchAll(linkRegex)];
      return !m.some((mm) => sourceScopeByTitle.get(mm[1].trim()) === "private");
    });
    newSection = kept.join("\n");
  }

  // Append missing sources as bullets at end of section.
  if (missing.length > 0) {
    // Trim trailing whitespace/newlines, append bullets, restore one trailing
    // newline before the next header (or EOF).
    const trimmed = newSection.replace(/\n+$/, "");
    const additions = missing.map((t) => `- [[${t}]]`).join("\n");
    newSection = `${trimmed}\n${additions}\n`;
  }

  const headerChanged = headerMatch[0] !== newHeader;
  const sectionChanged = newSection !== section;
  if (!headerChanged && !sectionChanged) continue;

  const newRaw =
    raw.slice(0, headerStart) + newHeader + newSection + raw.slice(sectionEnd);

  if (!values["dry-run"]) writeFileSync(moc.path, newRaw, "utf-8");
  modified++;
  const tag = values["dry-run"] ? " (dry-run)" : "";
  const detail =
    (headerChanged ? `count ${headerMatch[0]} → ${newHeader}` : "") +
    (headerChanged && missing.length > 0 ? "; " : "") +
    (missing.length > 0 ? `+${missing.length} bullet${missing.length > 1 ? "s" : ""}` : "") +
    (privateListedInSection.length > 0 ? `; -${privateListedInSection.length} private` : "");
  console.log(`${moc.path}${tag}${detail ? ` (${detail})` : ""}`);
}

if (modified === 0) {
  console.log("No drift");
}
