#!/usr/bin/env tsx
/**
 * `commonplace eval:search` — measures the path the model actually calls:
 * `vault_search` (field-weighted postings, hooks/lib/index/postings.ts) over
 * the Find gold set, and the in-module Connect pool (hooks/lib/core/connect.ts)
 * over the Connect gold set. Zero LLM tokens; the vault is only READ — the
 * index is rebuilt in memory, never written.
 *
 *   commonplace eval:search                    current defaults vs legacy (v2.0) scoring
 *   commonplace eval:search --tune             coordinate ascent + 2-fold held-out check
 *   commonplace eval:search --json [--history]
 *
 * Gold (per vault, NEVER committed): $VAULT/.wiki/evals/gold.jsonl
 * ({id, question, expected_notes, type}) and connect-gold.jsonl
 * ({id, question, seed_notes?, expected_notes, type}; type "negative" skipped).
 */

import { readFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "node:util";
import { resolveVault } from "../../scripts/lib/vault.js";
import { loadIndexNotes, buildInMemory } from "../../scripts/lib/index-notes.js";
import { VaultView } from "../../hooks/lib/index/view.js";
import { unpackCsr } from "../../hooks/lib/graph/csr.js";
import { connectPool, CONNECT } from "../../hooks/lib/core/connect.js";
import { TERMS, RANK, termSig, type TermConfig, type RankConfig } from "../../hooks/lib/index/postings.js";
import { targetsOf, type ConnectGold } from "../connect/score.js";
import {
  findMetrics,
  poolResult,
  summarize,
  coordinateAscent,
  foldOf,
  KS,
  type Grid,
  type Summary,
  type FindResult,
  type PoolResult,
} from "./score.js";

const { values: args } = parseArgs({
  options: {
    vault: { type: "string" },
    gold: { type: "string" },
    "connect-gold": { type: "string" },
    tune: { type: "boolean", default: false },
    /** Print the top 8 for a query under LEGACY and CURRENT, then exit. Repeatable. */
    show: { type: "string", multiple: true, default: [] },
    /** Evaluate CURRENT with overrides, e.g. --cfg '{"coverage":2,"seedK":12}'. Repeatable. */
    cfg: { type: "string", multiple: true, default: [] },
    k: { type: "string", default: "20" },
    history: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

type Cfg = {
  stem: TermConfig["stem"];
  phrases: boolean;
  wTitle: number;
  wAlias: number;
  wAbs: number;
  wHead: number;
  wOther: number;
  k1: number;
  coverage: number;
  phrase: number;
  seedK: number;
  restart: number;
  docSeed: number;
  lambda: number;
};

const LEGACY: Cfg = {
  stem: "none", phrases: false, wTitle: 4, wAlias: 4, wAbs: 3, wHead: 2, wOther: 1,
  k1: Infinity, coverage: 0, phrase: 0, seedK: 5, restart: 0.15, docSeed: 1, lambda: 0.25,
};
const CURRENT: Cfg = {
  stem: TERMS.stem, phrases: TERMS.phrases,
  wTitle: TERMS.weights.title, wAlias: TERMS.weights.alias, wAbs: TERMS.weights.abstraction,
  wHead: TERMS.weights.heading, wOther: TERMS.weights.other,
  k1: RANK.k1, coverage: RANK.coverage, phrase: RANK.phrase,
  seedK: CONNECT.seedK, restart: CONNECT.restart, docSeed: CONNECT.docSeed, lambda: CONNECT.lambda,
};
const GRID: Grid<Cfg> = {
  stem: ["none", "s"],
  phrases: [false, true],
  wTitle: [2, 3, 4, 6],
  wAlias: [2, 4],
  wAbs: [2, 3, 4, 6],
  wHead: [0, 1, 2, 3],
  wOther: [0, 0.5, 1, 2],
  k1: [Infinity, 1, 2, 4, 8],
  coverage: [0, 0.5, 1, 2],
  phrase: [0, 0.5, 1, 2],
  seedK: [3, 5, 8, 12],
  restart: [0.15, 0.3, 0.5],
  docSeed: [0.05, 0.2, 0.5, 1],
  lambda: [0, 0.25, 0.5, 1],
};

const termsOf = (c: Cfg): TermConfig => ({
  stem: c.stem,
  phrases: c.phrases,
  weights: { title: c.wTitle, alias: c.wAlias, abstraction: c.wAbs, heading: c.wHead, other: c.wOther },
});
const rankOf = (c: Cfg): RankConfig => ({ k1: c.k1, coverage: c.coverage, phrase: c.phrase });

const config = resolveVault(args.vault);
const readJsonl = <T,>(p: string): T[] =>
  existsSync(p) ? readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T) : [];
type FindGold = { id: string; question: string; expected_notes: string[]; type?: string };
const findGold = readJsonl<FindGold>(args.gold ?? join(config.wikiPath, "evals", "gold.jsonl"));
const connectGold = readJsonl<ConnectGold>(args["connect-gold"] ?? join(config.wikiPath, "evals", "connect-gold.jsonl")).filter(
  (g) => g.type !== "negative",
);
if (findGold.length === 0 && connectGold.length === 0) {
  console.error(`error: no gold at ${join(config.wikiPath, "evals")} (gold.jsonl / connect-gold.jsonl)`);
  process.exit(1);
}
const K = Number(args.k);

const loaded = await loadIndexNotes(config);
const views = new Map<string, { view: VaultView; kind: Map<number, string> }>();
function viewFor(t: TermConfig) {
  const sig = termSig(t);
  let v = views.get(sig);
  if (!v) {
    const r = buildInMemory(loaded, t);
    const pub = r.public;
    const view = new VaultView({
      base: unpackCsr(pub.csr),
      sentinels: pub.sentinels,
      names: pub.names,
      aliases: pub.aliases,
      unresolved: pub.unresolved,
      postings: pub.postings,
      files: pub.files,
      nextId: r.nextId,
      domains: loaded.domains,
      hub: pub.hub,
      auth: pub.auth,
      terms: t,
    });
    v = { view, kind: new Map(pub.cards.map((c) => [c.id, c.k])) };
    views.set(sig, v);
  }
  return v;
}

function run(c: Cfg, keep: (id: string) => boolean = () => true): { s: Summary; find: FindResult[]; pool: PoolResult[] } {
  const { view, kind } = viewFor(termsOf(c));
  view.rank = rankOf(c);
  const rel = (id: number) => view.relOfId(id) ?? "";
  const find = findGold
    .filter((g) => keep(g.id))
    .map((g) => findMetrics(g.id, g.type ?? "untyped", g.expected_notes, view.search(g.question, { limit: KS[KS.length - 1] }).map((h) => rel(h.id))));
  const pool = connectGold
    .filter((g) => keep(g.id))
    .map((g) => {
      const p = connectPool(view, g.question, {
        k: K, seedK: c.seedK, restart: c.restart, docSeed: c.docSeed, lambda: c.lambda, kindOf: (id) => kind.get(id),
      });
      return poolResult(g.id, g.type, targetsOf(g), p.map((x) => rel(x.id)));
    });
  return { s: summarize(find, pool), find, pool };
}

const fmt = (x: number) => x.toFixed(3);
function report(label: string, s: Summary) {
  console.log(`\n${label}  objective ${fmt(s.objective)}`);
  console.log(`  find (${s.find.n}): MRR ${fmt(s.find.mrr)}  ` + KS.map((k) => `R@${k} ${fmt(s.find.recall[k])}`).join("  "));
  for (const [t, v] of Object.entries(s.find.byType)) console.log(`    ${t.padEnd(22)} n=${v.n}  MRR ${fmt(v.mrr)}  R@8 ${fmt(v.r8)}`);
  console.log(`  connect (${s.connect.n}): pool recall@${K} ${fmt(s.connect.recall)}  MRR ${fmt(s.connect.mrr)}`);
  for (const [t, v] of Object.entries(s.connect.byType)) console.log(`    ${t.padEnd(22)} n=${v.n}  recall ${fmt(v.recall)}  MRR ${fmt(v.mrr)}`);
}
const diff = (a: Cfg, b: Cfg) =>
  (Object.keys(a) as (keyof Cfg)[]).filter((k) => !Object.is(a[k], b[k])).map((k) => `${k}=${String(b[k])}`).join(" ") || "(no change)";

if ((args.show as string[]).length) {
  for (const q of args.show as string[]) {
    console.log(`\n"${q}"`);
    for (const [label, c] of [["legacy", LEGACY], ["current", CURRENT]] as const) {
      const { view } = viewFor(termsOf(c));
      view.rank = rankOf(c);
      console.log(`  ${label}:`);
      for (const h of view.search(q, { limit: 8 })) console.log(`    ${(view.relOfId(h.id) ?? "").split("/").pop()}  [${h.matched.join(", ")}]`);
    }
  }
  process.exit(0);
}

const legacy = run(LEGACY);
const current = run(CURRENT);
const out: Record<string, unknown> = { legacy: legacy.s, current: current.s, currentCfg: CURRENT };

const variants = (args.cfg as string[]).map((j) => {
  const c = { ...CURRENT, ...(JSON.parse(j) as Partial<Cfg>) };
  if (c.k1 === null) c.k1 = Infinity;
  return { cfg: c, ...run(c) };
});
if (variants.length) out.variants = variants.map((v) => ({ cfg: v.cfg, summary: v.s }));

if (args.tune) {
  const held: Array<{ fold: number; legacy: number; tuned: number; cfg: string }> = [];
  for (const f of [0, 1] as const) {
    const train = (id: string) => foldOf(id) !== f;
    const test = (id: string) => foldOf(id) === f;
    const t = coordinateAscent(LEGACY, GRID, (c) => run(c, train).s.objective);
    held.push({ fold: f, legacy: run(LEGACY, test).s.objective, tuned: run(t.best, test).s.objective, cfg: diff(LEGACY, t.best) });
  }
  const full = coordinateAscent(LEGACY, GRID, (c) => run(c).s.objective);
  out.heldOut = held;
  out.tuned = { cfg: full.best, summary: run(full.best).s, evaluations: full.evaluations };
}

if (args.history) {
  appendFileSync(join(config.wikiPath, "search-eval-history.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...out }) + "\n");
}

if (args.json) {
  console.log(JSON.stringify({ ...out, perQuestion: { find: current.find, connect: current.pool } }, null, 2));
} else {
  console.log(`eval:search — ${loaded.notes.length} notes read (in-memory build), ${findGold.length} find / ${connectGold.length} connect questions`);
  report("LEGACY (v2.0 scoring)", legacy.s);
  report(`CURRENT  ${diff(LEGACY, CURRENT)}`, current.s);
  const misses = current.find.filter((f) => f.firstRank === null || f.firstRank > 8);
  if (misses.length) {
    console.log(`\n  find misses outside the first page (current):`);
    for (const m of misses) console.log(`    ${m.id} (${m.type}): ${m.firstRank === null ? "not in top 25" : `rank ${m.firstRank}`}`);
  }
  for (const v of variants) {
    report(`VARIANT  ${diff(CURRENT, v.cfg)}`, v.s);
    const fo = (c: Cfg, f: 0 | 1) => fmt(run(c, (id) => foldOf(id) === f).s.objective);
    console.log(`  per fold vs legacy: fold 0 ${fo(LEGACY, 0)} → ${fo(v.cfg, 0)}   fold 1 ${fo(LEGACY, 1)} → ${fo(v.cfg, 1)}`);
  }
  if (args.tune) {
    const held = out.heldOut as Array<{ fold: number; legacy: number; tuned: number; cfg: string }>;
    console.log(`\n  HELD-OUT (tuned on one half, scored on the other):`);
    for (const h of held) console.log(`    fold ${h.fold}: legacy ${fmt(h.legacy)} → tuned ${fmt(h.tuned)}   [${h.cfg}]`);
    const t = out.tuned as { cfg: Cfg; summary: Summary; evaluations: number };
    report(`TUNED on all (${t.evaluations} evaluations)  ${diff(LEGACY, t.cfg)}`, t.summary);
  }
}
