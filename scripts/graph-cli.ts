#!/usr/bin/env tsx
/**
 * CLI twins of the vault tools (plan §10.5): `commonplace search|note|links|
 * path|neighbourhood`. Same `hooks/lib` code, same formatters and scope rules
 * as the in-process tools, so a session without the module (or a script, or a
 * person at a terminal) gets byte-identical answers.
 *
 * Scope: private shards stay sealed unless named with `--open <domain>`
 * (repeatable). A terminal flag is the person's own explicit choice — the same
 * standing as `/vault open` — never something a pointer or a prompt can set.
 *
 * Usage:
 *   commonplace search --query "<text>" [--limit N] [--domain d]
 *   commonplace note --ref "<title|path>" [--max-chars N]
 *   commonplace links --ref "<title|path>" [--direction out|in|both] [--limit N]
 *   commonplace path --from "<ref>" --to "<ref>" [--max-hops N] [--no-avoid-hubs]
 *   commonplace neighbourhood --seed "<ref>" [--seed …] [--k N]
 * Common: [--vault <id|path>] [--open <domain>]… [--json]
 */

import { parseArgs } from "node:util";
import { readFileSync, statSync, appendFileSync } from "fs";
import { join, basename } from "path";
import { resolveVault, loadDomainRegistry } from "./lib/vault.js";
import { VaultIndex, type IndexPorts } from "../hooks/lib/index/load.js";
import { P } from "../hooks/lib/index/layout.js";
import { shardOfDomain, isPrivate } from "../hooks/lib/core/scope.js";
import type { DomainMap } from "../hooks/lib/core/scope.js";
import * as noun from "../hooks/lib/core/noun.js";
import { formatSearch, formatNote, formatLinks, formatPath, formatNeighbourhood } from "../hooks/lib/tools/format.js";

export const COMMANDS = ["search", "note", "links", "path", "neighbourhood"] as const;
export type Cmd = (typeof COMMANDS)[number];

/** Entry for the thin `scripts/{search,note,links,path,neighbourhood}.ts` wrappers. */
export async function run(cmd: Cmd, argv: string[]): Promise<void> {
const { values } = parseArgs({
  args: argv,
  options: {
    vault: { type: "string" },
    open: { type: "string", multiple: true, default: [] },
    json: { type: "boolean", default: false },
    query: { type: "string" },
    limit: { type: "string" },
    domain: { type: "string" },
    ref: { type: "string" },
    "max-chars": { type: "string" },
    direction: { type: "string", default: "both" },
    from: { type: "string" },
    to: { type: "string" },
    "max-hops": { type: "string", default: "4" },
    "no-avoid-hubs": { type: "boolean", default: false },
    seed: { type: "string", multiple: true, default: [] },
    k: { type: "string", default: "12" },
  },
});

const config = resolveVault(values.vault);
const root = config.vaultPath;
const wiki = config.wikiPath;
const domains = (loadDomainRegistry(wiki).domains ?? {}) as DomainMap;

const ports: IndexPorts = {
  read: async (rel) => {
    try {
      return readFileSync(join(wiki, rel), "utf-8");
    } catch {
      return null;
    }
  },
  head: async (rel, n) => {
    try {
      return readFileSync(join(wiki, rel), "utf-8").slice(0, n);
    } catch {
      return null;
    }
  },
  size: async (rel) => {
    try {
      return statSync(join(wiki, rel)).size;
    } catch {
      return null;
    }
  },
  append: async (rel, text) => {
    appendFileSync(join(wiki, rel), text);
  },
  now: () => Date.now(),
};

function fail(msg: string): never {
  if (values.json) console.log(JSON.stringify({ error: msg }));
  else console.error(`error: ${msg}`);
  process.exit(1);
}

const index = new VaultIndex(ports, domains);
const state = await index.load();
if (state !== "ready") fail("vault index not built — run `commonplace index`");

// --open names domains; a shard opens only for a domain that is private and real.
const open = new Set<string>();
for (const d of values.open as string[]) {
  if (!domains[d] || !isPrivate(domains[d])) fail(`no private domain "${d}"`);
  const shard = shardOfDomain(domains, d);
  open.add(shard);
  await index.openShard(shard);
}

let sealedNames: string[] = [];
try {
  const sn = JSON.parse(readFileSync(join(wiki, P.sealedNames), "utf-8")) as { names?: Array<{ t: string; al?: string[]; shard: string }> };
  sealedNames = (sn.names ?? []).filter((n) => !open.has(n.shard)).flatMap((n) => [n.t, ...(n.al ?? [])]);
} catch {
  /* no private notes */
}

const ctx: noun.NounCtx = {
  vaultId: basename(root),
  index,
  domains,
  open,
  sealedNames,
  readNote: async (rel) => {
    if (rel.includes("..") || rel.startsWith("/")) return null;
    try {
      return readFileSync(join(root, rel), "utf-8");
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
};

const need = (v: string | undefined, flag: string): string => v ?? fail(`--${flag} is required`);
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

let result: unknown;
let text: string;
switch (cmd) {
  case "search": {
    const q = need(values.query, "query");
    const r = await noun.search(ctx, { query: q, limit: num(values.limit), domain: values.domain });
    if ("error" in r) fail(r.error);
    result = r;
    text = formatSearch(r, q);
    break;
  }
  case "note": {
    const r = await noun.note(ctx, { ref: need(values.ref, "ref"), maxChars: num(values["max-chars"]) });
    if ("error" in r) fail(r.error);
    result = r;
    text = formatNote(r);
    break;
  }
  case "links": {
    const dir = values.direction as "out" | "in" | "both";
    const r = await noun.links(ctx, { note: need(values.ref, "ref"), direction: dir, limit: num(values.limit) });
    if ("error" in r) fail(r.error);
    result = r;
    text = formatLinks(r, dir);
    break;
  }
  case "path": {
    const from = need(values.from, "from");
    const to = need(values.to, "to");
    const maxHops = Number(values["max-hops"]);
    const r = await noun.path(ctx, { from, to, maxHops, avoidHubs: !values["no-avoid-hubs"] });
    if ("error" in r) fail(r.error);
    result = r;
    text = formatPath(r, from, to, maxHops);
    break;
  }
  case "neighbourhood": {
    const seeds = values.seed as string[];
    if (seeds.length === 0) fail("--seed is required");
    const r = await noun.neighbourhood(ctx, { seeds, k: Number(values.k) });
    if ("error" in r) fail(r.error);
    result = r;
    text = formatNeighbourhood(r, seeds);
    break;
  }
}

console.log(values.json ? JSON.stringify(result) : text!);
}
