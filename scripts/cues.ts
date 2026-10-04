#!/usr/bin/env tsx
/**
 * `commonplace cues` — draft `cues:` for notes (scripts/lib/cues.ts), without
 * touching a note.
 *
 *   commonplace cues [--limit N] [--match <path text>] [--concurrency 4] [--model haiku]
 *       generate: public, non-stub source + concept notes with no `cues:` yet,
 *       BATCH notes per model call, appended to the raw file (resumable)
 *   commonplace cues --filter-only
 *       re-run the filter over the raw file
 *   commonplace cues --write [--dry-run]
 *       write the draft's kept cues into notes as `cues: [...]`, the last
 *       frontmatter line (every other byte kept; a note that already has
 *       `cues:` or no frontmatter is skipped). Run `commonplace index` after.
 *
 * Every run ends with the filter, which writes the draft wholesale:
 *   $VAULT/.wiki/evals/cues-raw.jsonl    {p, cues}             generated
 *   $VAULT/.wiki/evals/cues-draft.jsonl  {p, kept, dropped}    filtered
 * `commonplace eval:search --cues <draft>` measures a draft before anything is
 * written into notes. Sealed notes are never sent to the model.
 *
 * The model runs as `claude -p` with commonplace itself disabled, so the
 * generation calls do not trigger the plugin's own end-of-turn pass.
 */

import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { parseArgs } from "node:util";
import matter from "gray-matter";
import { resolveVault } from "./lib/vault.js";
import { loadIndexNotes, viewInMemory } from "./lib/index-notes.js";
import { cuesPrompt, parseCues, filterCues, insertFrontmatterCues, CUES_SYSTEM, BATCH, KEEP_TOP, type CueNote } from "./lib/cues.js";

const { values: args } = parseArgs({
  options: {
    vault: { type: "string" },
    limit: { type: "string" },
    match: { type: "string" },
    concurrency: { type: "string", default: "4" },
    model: { type: "string", default: "haiku" },
    "filter-only": { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const config = resolveVault(args.vault);
const dir = join(config.wikiPath, "evals");
mkdirSync(dir, { recursive: true });
const RAW = join(dir, "cues-raw.jsonl");
const DRAFT = join(dir, "cues-draft.jsonl");

const readRaw = (): Map<string, string[]> => {
  const m = new Map<string, string[]>();
  if (!existsSync(RAW)) return m;
  for (const l of readFileSync(RAW, "utf-8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l) as { p: string; cues: string[] };
      m.set(r.p, r.cues);
    } catch {
      // a torn last line from an interrupted run
    }
  }
  return m;
};

if (args.write) {
  if (!existsSync(DRAFT)) {
    console.error(`error: no draft at ${DRAFT} — run \`commonplace cues\` first`);
    process.exit(1);
  }
  let written = 0;
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  for (const l of readFileSync(DRAFT, "utf-8").split("\n")) {
    if (!l.trim()) continue;
    const d = JSON.parse(l) as { p: string; kept: string[] };
    if (!d.kept.length) {
      skip("none-kept");
      continue;
    }
    const abs = join(config.vaultPath, d.p);
    let raw: string;
    try {
      raw = readFileSync(abs, "utf-8");
    } catch {
      skip("missing");
      continue;
    }
    if (/^cues:/m.test(raw.slice(0, Math.max(0, raw.indexOf("\n---\n", 4))))) {
      skip("has-cues");
      continue;
    }
    const next = insertFrontmatterCues(raw, d.kept);
    if (!next) {
      skip("no-frontmatter");
      continue;
    }
    if (!args["dry-run"]) writeFileSync(abs, next);
    written++;
  }
  console.log(JSON.stringify({ written, skipped, dryRun: args["dry-run"] }));
  process.exit(0);
}

const loaded = await loadIndexNotes(config);
const { view: base } = viewInMemory(loaded);
const isPublic = (rel: string) => {
  const id = base.idOfRel(rel);
  return id !== undefined && base.visible(id);
};

function callModel(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(
      "claude",
      [
        "-p", prompt,
        "--model", args.model!,
        "--system-prompt", CUES_SYSTEM,
        "--tools", "",
        "--settings", JSON.stringify({ enabledPlugins: { "commonplace@stray-bits-sanctuary": false } }),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    const timer = setTimeout(() => p.kill(), 180_000);
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

if (!args["filter-only"]) {
  const done = readRaw();
  let todo = loaded.notes.filter(
    (n) =>
      (n.parsed.kind === "source" || n.parsed.kind === "concept") &&
      !n.stub &&
      !n.parsed.cues &&
      !done.has(n.rel) &&
      isPublic(n.rel) &&
      (!args.match || n.rel.includes(args.match)),
  );
  if (args.limit) todo = todo.slice(0, Number(args.limit));
  const batches: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  console.error(`cues: ${todo.length} notes in ${batches.length} calls (${done.size} already drafted)`);

  let next = 0;
  let ok = 0;
  const worker = async () => {
    while (next < batches.length) {
      const at = next++;
      const b = batches[at];
      const notes: CueNote[] = b.map((n, i) => {
        let body = "";
        try {
          body = matter(readFileSync(join(config.vaultPath, n.rel), "utf-8")).content;
        } catch {
          // unreadable: title and abstraction only
        }
        return { key: `N${i + 1}`, title: n.parsed.title, abstraction: n.parsed.abstractionFallback ? "" : n.parsed.abstraction, body };
      });
      const got = parseCues(await callModel(cuesPrompt(notes)), notes.map((n) => n.key));
      const lines = b.flatMap((n, i) => {
        const c = got.get(`N${i + 1}`);
        return c ? [JSON.stringify({ p: n.rel, cues: c })] : [];
      });
      if (lines.length) appendFileSync(RAW, lines.join("\n") + "\n");
      ok += lines.length;
      console.error(`  call ${at + 1}/${batches.length}: ${lines.length}/${b.length} notes`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency)) }, worker));
  console.error(`cues: generated for ${ok}/${todo.length} notes`);
}

// ---- filter: index every generated cue, keep those that find their own note
const raw = readRaw();
for (const n of loaded.notes) {
  const c = raw.get(n.rel);
  if (c && !n.parsed.cues) n.parsed = { ...n.parsed, cues: c };
}
const { view } = viewInMemory(loaded);
let kept = 0;
let total = 0;
const out: string[] = [];
for (const n of loaded.notes) {
  const c = raw.get(n.rel);
  const id = view.idOfRel(n.rel);
  if (!c || id === undefined || !view.visible(id)) continue;
  const f = filterCues(id, c, n.parsed.title, n.parsed.aliases, (q) => view.search(q, { limit: KEEP_TOP }).map((h) => h.id));
  kept += f.kept.length;
  total += c.length;
  out.push(JSON.stringify({ p: n.rel, ...f }));
}
writeFileSync(DRAFT, out.length ? out.join("\n") + "\n" : "");
console.log(
  JSON.stringify({ notes: out.length, cues: total, kept, keptRatio: total ? Number((kept / total).toFixed(3)) : 0, raw: RAW, draft: DRAFT }),
);
