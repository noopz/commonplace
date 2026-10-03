/**
 * eval:scale rows for the hooks module's own code paths, timed in-process
 * against a synthetic vault the CLI has already indexed. These are the
 * operations a session pays for inside the sandbox — no process start — so
 * they are reported without the `cli.startup` floor.
 *
 * Node ports stand in for `$.fs` / `$.process`; the plan's P0 probe measured
 * those within noise of plain fs reads at these sizes.
 */
import { readFileSync, appendFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseNote } from "../../hooks/lib/index/parse.js";
import { buildIndex, shardFor, type IndexNote } from "../../hooks/lib/index/model.js";
import { serializeIndex } from "../../hooks/lib/index/layout.js";
import { journalNote } from "../../hooks/lib/index/journal.js";
import { VaultIndex, type IndexPorts } from "../../hooks/lib/index/load.js";
import { findNotesArgv } from "../../hooks/lib/index/exclude.js";
import type { DomainMap } from "../../hooks/lib/core/scope.js";
import * as noun from "../../hooks/lib/core/noun.js";

export type ModuleRows = {
  graphRebuild: number;
  patchP50: number;
  sweep: number;
  journalReplay: number;
  linksP50: number;
  pathP50: number;
  neighbourhoodP50: number;
  memory: number;
};

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function ports(wiki: string): IndexPorts {
  const safe = <T>(f: () => T): T | null => {
    try {
      return f();
    } catch {
      return null;
    }
  };
  return {
    read: async (rel) => safe(() => readFileSync(join(wiki, rel), "utf-8")),
    head: async (rel, n) => safe(() => readFileSync(join(wiki, rel), "utf-8").slice(0, n)),
    size: async (rel) => safe(() => statSync(join(wiki, rel)).size),
    append: async (rel, line) => appendFileSync(join(wiki, rel), `${line}\n`),
    now: () => Date.now(),
  };
}

export async function measureModule(vault: string, samples = 20): Promise<ModuleRows> {
  const wiki = join(vault, ".wiki");
  const domains = (JSON.parse(readFileSync(join(wiki, "domains.json"), "utf-8")).domains ?? {}) as DomainMap;
  const cfg = JSON.parse(readFileSync(join(wiki, "config.json"), "utf-8")) as { structure?: { sources?: string; concepts?: string; mocs?: string } };
  const structure = cfg.structure ?? {};
  const opts = { structure, domainPaths: Object.values(domains).map((d) => d.path ?? "").filter(Boolean) };
  const structureDirs = [structure.concepts, structure.mocs].filter((x): x is string => Boolean(x));

  // Sweep: the one find exec a 60 s tick costs.
  let t = performance.now();
  const [cmd, ...argv] = findNotesArgv(vault);
  const listing = execFileSync(cmd, [...argv.slice(0, 1), ...argv.slice(1), "-newer", join(wiki, "graph", "manifest.json")], { encoding: "utf-8" });
  const sweep = performance.now() - t;
  void listing;

  // Graph rebuild in-process: parse + build + serialize (reads excluded).
  const all = execFileSync(cmd, argv, { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
  const texts = all.map((abs) => ({ rel: abs.slice(vault.length + 1), text: readFileSync(abs, "utf-8") }));
  t = performance.now();
  const notes: IndexNote[] = texts.map(({ rel, text }) => ({ rel, parsed: parseNote(rel, text, opts), mt: 1, sz: text.length, stub: false }));
  const built = buildIndex(notes, { domains, version: 1, builtAt: "eval" });
  serializeIndex(built, { version: 1, builtAt: "eval" });
  const graphRebuild = performance.now() - t;

  // Load + memory.
  const heap0 = process.memoryUsage().heapUsed;
  const idx = new VaultIndex(ports(wiki), domains);
  await idx.load();
  const memory = Math.max(0, process.memoryUsage().heapUsed - heap0);
  const view = idx.view!;
  const knownLoose = new Set(idx.manifest?.knownLoose ?? []);

  // Patch p50: re-parse a spread of public notes with one added link.
  const publicRels = texts.filter(({ rel }) => {
    const id = view.idOfRel(rel);
    return id !== undefined && view.shard(id) === "main";
  });
  const step = Math.max(1, Math.floor(publicRels.length / samples));
  const patchMs: number[] = [];
  const titles: string[] = [];
  for (let i = 0; i < samples && i * step < publicRels.length; i++) {
    const { rel, text } = publicRels[i * step];
    titles.push(rel.split("/").pop()!.replace(/\.md$/, ""));
    const t0 = performance.now();
    const parsed = parseNote(rel, `${text}\n\nSee also [[${titles[0]}]].\n`, opts);
    const shard = shardFor(rel, parsed.fm.scope, { domains, knownLoose, structureDirs });
    await idx.patch(rel, journalNote(parsed, false), { mt: Date.now(), sz: text.length, shard });
    patchMs.push(performance.now() - t0);
  }

  // Journal replay: a fresh load now replays those patches.
  t = performance.now();
  const replayed = new VaultIndex(ports(wiki), domains);
  await replayed.load();
  const journalReplay = performance.now() - t;

  // Tool p50s over the same spread of notes.
  const ctx: noun.NounCtx = {
    vaultId: "scale",
    index: replayed,
    domains,
    open: new Set(),
    sealedNames: [],
    readNote: async (rel) => readFileSync(join(vault, rel), "utf-8"),
    now: () => performance.now(),
  };
  const time = async (f: () => Promise<unknown>) => {
    const t0 = performance.now();
    await f();
    return performance.now() - t0;
  };
  const linksMs: number[] = [];
  const pathMs: number[] = [];
  const nbMs: number[] = [];
  for (let i = 0; i < titles.length; i++) {
    const a = titles[i];
    const b = titles[(i + Math.floor(titles.length / 2)) % titles.length];
    linksMs.push(await time(() => noun.links(ctx, { note: a })));
    pathMs.push(await time(() => noun.path(ctx, { from: a, to: b })));
    nbMs.push(await time(() => noun.neighbourhood(ctx, { seeds: [a] })));
  }

  return {
    graphRebuild,
    patchP50: median(patchMs),
    sweep,
    journalReplay,
    linksP50: median(linksMs),
    pathP50: median(pathMs),
    neighbourhoodP50: median(nbMs),
    memory,
  };
}
