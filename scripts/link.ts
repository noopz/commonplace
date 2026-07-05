#!/usr/bin/env tsx
/**
 * Deterministic wikilink insertion across vault notes.
 *
 * Replaces the wiki-concept-linker agent's destructive Edit path. For each
 * note in scope, find the first safe occurrence of each known link target
 * (concepts, sources, MOCs) and wrap it in `[[ ]]`. Frontmatter, code
 * blocks, headings, and existing links are off-limits — enforced by the
 * pure-function lib in `scripts/lib/linker.ts`, not by prompt rules.
 *
 * Usage:
 *   commonplace link                       # link all source/concept/moc notes
 *   commonplace link --note <path>         # restrict to specific note(s) — repeatable
 *   commonplace link --target <name>       # restrict to specific link target(s) — repeatable
 *   commonplace link --dry-run             # show edits without writing
 *   commonplace link --json                # machine-parseable output
 */

import { readFileSync, writeFileSync } from "fs";
import { join, basename, relative } from "path";
import { parseArgs } from "util";
import { resolveVault, loadDomainRegistry, findAllNotes, classifyNote } from "./lib/vault.js";
import { inferSourceDomain } from "./lib/domain.js";
import { linkNoteContent, type LinkTarget } from "./lib/linker.js";
import { appendLineage } from "./lib/lineage.js";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    note: { type: "string", multiple: true },
    target: { type: "string", multiple: true },
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log(`Usage: commonplace link [options]
  --note <path>     Restrict to specific note(s); repeat to add more. Default: all notes.
  --target <name>   Restrict to specific link target name(s); repeat. Default: all index entries.
  --dry-run         Show planned edits without writing.
  --json            Emit JSON instead of human summary.
  --vault <path>    Override vault discovery.`);
  process.exit(0);
}

const config = resolveVault(values.vault);
const registry = loadDomainRegistry(config.wikiPath);

// ---- Load link targets from indexes ----

function readJsonl<T>(path: string): T[] {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

interface ConceptRecord { name: string; path?: string; isStub?: boolean; domains?: string[] }
interface SourceRecord { title: string; path: string; domain?: string }
interface MocRecord { name: string }

const concepts = readJsonl<ConceptRecord>(join(config.wikiPath, "concept-index.jsonl"));
const sources = readJsonl<SourceRecord>(join(config.wikiPath, "source-index.jsonl"));
const mocs = readJsonl<MocRecord>(join(config.wikiPath, "moc-index.jsonl"));

// A concept's scope = the domains whose notes reference it (index `domains`,
// "unknown" dropped) plus the domain of its own folder. Passing this through
// lets the linker refuse to wire a public paper's bare string to a
// private-domain homonym (see canLink in lib/linker.ts).
function conceptDomains(c: ConceptRecord): string[] {
  const set = new Set<string>((c.domains ?? []).filter((d) => d && d !== "unknown"));
  if (c.path) {
    const abs = c.path.startsWith("/") ? c.path : join(config.vaultPath, c.path);
    const own = inferSourceDomain(abs, config.vaultPath, registry);
    if (own && own !== "unknown") set.add(own);
  }
  return [...set];
}

const allTargets: LinkTarget[] = [
  ...concepts
    .filter((c) => !c.isStub)
    .map((c) => ({ name: c.name, type: "concept" as const, domains: conceptDomains(c) })),
  ...sources.map((s) => ({ name: s.title, domain: s.domain ?? null, type: "source" as const })),
  ...mocs.map((m) => ({ name: m.name, type: "moc" as const })),
];

// Dedup by name (concepts + sources can collide); keep first
const seen = new Set<string>();
const targets = allTargets.filter((t) => {
  const k = t.name.toLowerCase();
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// Apply --target filter
const targetFilter = values.target ? new Set(values.target.map((s) => s.toLowerCase())) : null;
const filteredTargets = targetFilter
  ? targets.filter((t) => targetFilter.has(t.name.toLowerCase()))
  : targets;

// ---- Pick notes to scan ----

let notesToScan: string[];
if (values.note && values.note.length > 0) {
  notesToScan = values.note.map((p) => (p.startsWith("/") ? p : join(config.vaultPath, p)));
} else {
  const all = await findAllNotes(config.vaultPath);
  notesToScan = all.filter((p) => {
    const t = classifyNote(p, config.vaultPath);
    return t === "source" || t === "concept" || t === "moc";
  });
}

// ---- Walk and edit ----

const report: Array<{ path: string; added: number; edits: string[]; skipped: number }> = [];
let totalAdded = 0;

for (const filePath of notesToScan) {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    continue;
  }
  const noteTitle = basename(filePath, ".md");
  const noteType = classifyNote(filePath, config.vaultPath);
  const noteDomain =
    noteType === "source" ? inferSourceDomain(filePath, config.vaultPath, registry) : null;

  const result = linkNoteContent(
    raw,
    filteredTargets,
    noteTitle,
    noteDomain && noteDomain !== "unknown" ? noteDomain : null,
    registry,
  );

  if (result.newContent && !values["dry-run"]) {
    writeFileSync(filePath, result.newContent);
    appendLineage(config.wikiPath, {
      note: relative(config.vaultPath, filePath),
      source: `link (${result.edits.map((e) => e.name).join(", ")})`,
      writer: "link",
    });
  }

  if (result.edits.length > 0) {
    totalAdded += result.edits.length;
    report.push({
      path: filePath.startsWith(config.vaultPath + "/")
        ? filePath.slice(config.vaultPath.length + 1)
        : filePath,
      added: result.edits.length,
      edits: result.edits.map((e) => `${e.name}${e.matched !== e.name ? ` (as "${e.matched}")` : ""}`),
      skipped: result.skipped.filter((s) => s.reason !== "no-match").length,
    });
  }
}

if (values.json) {
  console.log(
    JSON.stringify(
      {
        status: "ok",
        notesScanned: notesToScan.length,
        notesEdited: report.length,
        linksAdded: totalAdded,
        dryRun: values["dry-run"],
        report,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `${values["dry-run"] ? "[dry-run] " : ""}Scanned ${notesToScan.length} note(s); added ${totalAdded} link(s) across ${report.length} note(s).`,
  );
  for (const r of report.slice(0, 20)) {
    console.log(`  ${r.path}: +${r.added} (${r.edits.slice(0, 5).join(", ")}${r.edits.length > 5 ? "…" : ""})`);
  }
  if (report.length > 20) console.log(`  …and ${report.length - 20} more.`);
}
