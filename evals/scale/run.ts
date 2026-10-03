#!/usr/bin/env tsx
/**
 * commonplace eval:scale [--scales 1,10,50] [--seed S] [--json] [--keep]
 *
 * For each scale: generate a synthetic vault (scripts/lib/synthetic.ts —
 * invented lexicon text, never real content) into a temp dir, then time the
 * real CLI against it and record `.wiki/` artefact sizes. Nothing about the
 * user's vault is read or recorded: every child gets `--vault <tmp>` and a
 * scratch HOME / CLAUDE_PLUGIN_DATA so registry lookups see nothing.
 *
 * Timings are wall-clock of a spawned `node bin/commonplace <cmd>`, so they
 * include process start (tsx, or the dist bundle when fresh). The
 * `cli.startup` row measures that floor so the per-op rows can be read net.
 *
 * The OPS table is the extension point: later phases flip a `pending` row to
 * a `measure` function (graph rebuild, patch p50, sweep, journal replay,
 * vault_links/path/neighbourhood p50, module memory).
 */
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSynthetic, sampleQueries, type SyntheticResult } from "../../scripts/lib/synthetic.js";
import { measureModule, type ModuleRows } from "./module-ops.js";

const ROOT = join(import.meta.dirname!, "..", "..");
const BIN = join(ROOT, "bin", "commonplace");

export interface Ctx {
  scale: number;
  vault: string;
  gen: SyntheticResult;
  seed: number;
  env: NodeJS.ProcessEnv;
  /** In-process module timings, measured once per scale after the index exists. */
  mod?: Promise<ModuleRows>;
}

/** A measurement yields one number, or several named sub-rows (`id.sub`). */
export type Measurement = number | Record<string, number>;

export interface Op {
  id: string;
  label: string;
  unit: "ms" | "bytes" | "count";
  measure?: (ctx: Ctx) => Measurement | Promise<Measurement>;
  /** set instead of `measure` for rows a later phase will build */
  pending?: string;
}

export function p50(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function cli(ctx: Ctx, cmd: string, args: string[], allowFail = false): number {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [BIN, cmd, ...args], {
    cwd: ctx.vault,
    env: ctx.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  const ms = performance.now() - t0;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} exited ${r.status}: ${String(r.stderr).slice(0, 500)}`);
  }
  return ms;
}

function timedP50(ctx: Ctx, cmd: string, n: number, extra: string[] = []): number {
  return p50(sampleQueries(n, ctx.seed).map((q) => cli(ctx, cmd, ["--vault", ctx.vault, "--query", q, ...extra])));
}

function wikiSizes(ctx: Ctx): Record<string, number> {
  const wiki = join(ctx.vault, ".wiki");
  const out: Record<string, number> = {};
  let total = 0;
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
      else {
        const sz = statSync(p).size;
        // Chunked artefacts (graph/cards/, graph/linkctx/) are one row per
        // directory: hundreds of chunk files at 50x would bury the table.
        const key = /^graph\/(cards|linkctx)\/$/.test(prefix) ? `${prefix}*` : `${prefix}${e.name}`;
        out[key] = (out[key] ?? 0) + sz;
        total += sz;
      }
    }
  };
  walk(wiki, "");
  out.total = total;
  return out;
}

const mod = (c: Ctx) => (c.mod ??= measureModule(c.vault));

export const OPS: Op[] = [
  { id: "vault.notes", label: "managed notes", unit: "count", measure: (c) => c.gen.counts.sources + c.gen.counts.concepts + c.gen.counts.mocs + c.gen.counts.journal },
  { id: "vault.links", label: "body wikilinks", unit: "count", measure: (c) => c.gen.counts.bodyLinks },
  { id: "vault.hub_in", label: "max concept in-degree", unit: "count", measure: (c) => c.gen.maxConceptInDegree },
  { id: "synthetic.gen", label: "synthetic generate", unit: "ms", measure: (c) => c.gen.ms },
  // Process floor: `seed` with no --query exits 1 after parsing args, before
  // touching the vault — start-up cost only.
  { id: "cli.startup", label: "CLI start-up p50 (floor)", unit: "ms", measure: (c) => p50(Array.from({ length: 5 }, () => cli(c, "seed", [], true))) },
  { id: "index.full", label: "index full rebuild", unit: "ms", measure: (c) => cli(c, "index", ["--vault", c.vault]) },
  { id: "seed.p50", label: "seed p50 (20 q)", unit: "ms", measure: (c) => timedP50(c, "seed", 20, ["--json"]) },
  { id: "connect.p50", label: "connect p50 (10 q)", unit: "ms", measure: (c) => timedP50(c, "connect", 10, ["--json"]) },
  // In-module rows (no process start): see ./module-ops.ts.
  { id: "graph.rebuild", label: "graph rebuild (in-process)", unit: "ms", measure: async (c) => (await mod(c)).graphRebuild },
  { id: "patch.p50", label: "post-write patch p50", unit: "ms", measure: async (c) => (await mod(c)).patchP50 },
  { id: "sweep", label: "idle sweep (find -newer)", unit: "ms", measure: async (c) => (await mod(c)).sweep },
  { id: "journal.replay", label: "load + journal replay (20)", unit: "ms", measure: async (c) => (await mod(c)).journalReplay },
  { id: "vault_links.p50", label: "vault_links p50", unit: "ms", measure: async (c) => (await mod(c)).linksP50 },
  { id: "vault_path.p50", label: "vault_path p50", unit: "ms", measure: async (c) => (await mod(c)).pathP50 },
  { id: "vault_neighbourhood.p50", label: "vault_neighbourhood p50", unit: "ms", measure: async (c) => (await mod(c)).neighbourhoodP50 },
  { id: "module.memory", label: "module heap after load", unit: "bytes", measure: async (c) => (await mod(c)).memory },
  // Last, so it sees everything the ops above wrote.
  { id: "wiki", label: ".wiki/", unit: "bytes", measure: wikiSizes },
];

export type ScaleResult = Record<string, number | null>;

export async function runScale(scale: number, seed: number, keep: boolean, log: (s: string) => void): Promise<{ result: ScaleResult; vault: string }> {
  const base = mkdtempSync(join(tmpdir(), `commonplace-scale-${scale}x-`));
  const vault = join(base, "vault");
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: home };
  delete env.COMMONPLACE_CALLER_CWD;
  const result: ScaleResult = {};
  try {
    log(`[${scale}x] generating…`);
    const gen = generateSynthetic({ scale, out: vault, seed });
    const ctx: Ctx = { scale, vault, gen, seed, env };
    for (const op of OPS) {
      if (!op.measure) { result[op.id] = null; continue; }
      log(`[${scale}x] ${op.label}…`);
      const m = await op.measure(ctx);
      if (typeof m === "number") result[op.id] = Math.round(m);
      else for (const [k, v] of Object.entries(m)) result[`${op.id}.${k}`] = Math.round(v);
    }
  } finally {
    if (!keep) rmSync(base, { recursive: true, force: true });
  }
  return { result, vault };
}

function fmt(v: number | null | undefined, unit: Op["unit"], pending?: string): string {
  if (v === null || v === undefined) return pending ?? "—";
  if (unit === "bytes") {
    if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MiB`;
    if (v >= 1024) return `${(v / 1024).toFixed(0)} KiB`;
    return `${v} B`;
  }
  if (unit === "ms") return v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`;
  return String(v);
}

export function renderTable(scales: number[], results: Record<string, ScaleResult>): string {
  const rows: string[][] = [];
  for (const op of OPS) {
    const keys = op.measure
      ? [...new Set(scales.flatMap((s) => Object.keys(results[s] ?? {}).filter((k) => k === op.id || k.startsWith(op.id + "."))))]
      : [op.id];
    for (const k of keys) {
      const label = k === op.id ? op.label : `${op.label}${k.slice(op.id.length + 1)}`;
      rows.push([label, ...scales.map((s) => fmt(results[s]?.[k], op.unit, op.pending))]);
    }
  }
  const head = ["metric", ...scales.map((s) => `${s}×`)];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [line(head), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...rows.map(line)].join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      scales: { type: "string", default: "1,10,50" },
      seed: { type: "string", default: "1" },
      json: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
    },
  });
  const scales = values.scales!.split(",").map((s) => Number(s.trim()));
  if (scales.some((s) => !Number.isFinite(s) || s <= 0)) {
    console.error("error: --scales must be a comma list of positive numbers, e.g. 1,10,50");
    process.exit(1);
  }
  const seed = Number(values.seed);
  const log = (s: string) => { if (!values.json) process.stderr.write(s + "\n"); };
  const distFresh = existsSync(join(ROOT, "dist", "stamp.json")) && !process.env.COMMONPLACE_NO_DIST;

  const results: Record<string, ScaleResult> = {};
  for (const s of scales) {
    const { result, vault } = await runScale(s, seed, values.keep!, log);
    results[s] = result;
    if (values.keep) log(`[${s}x] kept ${vault}`);
  }

  if (values.json) {
    console.log(JSON.stringify({ scales, seed, results }, null, 2));
  } else {
    console.log(renderTable(scales, results));
    console.log(`\nseed ${seed}; CLI runner: ${distFresh ? "dist bundle if fresh, else tsx" : "tsx"}; node ${process.version}`);
  }
}

await main();
