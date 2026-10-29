#!/usr/bin/env node
/**
 * Commit one unit of agent work to the vault's git repository.
 *
 *   commonplace commit --message "<what the unit did>"   (the module adds --unit)
 *   commonplace commit --unit <id> --message "…" [--json]
 *   commonplace commit --list [--json]                    open (uncommitted) units
 *
 * Only the files the unit wrote are committed, and only when each still holds
 * exactly what the unit wrote and the branch still holds what it started from
 * (scripts/lib/git-unit.ts). A conflict commits nothing and changes nothing.
 */

import { readdirSync } from "fs";
import { parseArgs } from "util";
import { resolveVault } from "./lib/vault.ts";
import { commitUnit, readUnit, unitsDir } from "./lib/git-unit.ts";

const { values } = parseArgs({
  options: {
    vault: { type: "string" },
    unit: { type: "string" },
    message: { type: "string", short: "m" },
    list: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    open: { type: "string" }, // injected by the module for every commonplace command; unused here
  },
});

const vault = resolveVault(values.vault).vaultPath;
const out = (obj: unknown, text: string) => console.log(values.json ? JSON.stringify(obj) : text);

if (values.list) {
  let files: string[] = [];
  try {
    files = readdirSync(unitsDir(vault)).filter((f) => f.endsWith(".json"));
  } catch {}
  const open = files
    .map((f) => readUnit(vault, f.replace(/\.json$/, "")))
    .filter((u) => u && !u.commit)
    .map((u) => ({ id: u!.id, actor: u!.actor, startedAt: u!.startedAt, paths: Object.keys(u!.paths) }));
  out(open, open.length ? open.map((u) => `${u.id} · ${u.actor} · ${u.paths.length} file(s) · ${u.startedAt}`).join("\n") : "No open units.");
  process.exit(0);
}

const unitId = values.unit || process.env.COMMONPLACE_UNIT;
if (!unitId) {
  console.error("commonplace commit: no unit. In a session the module supplies it; by hand pass --unit <id> (see --list).");
  process.exit(2);
}
if (!values.message?.trim()) {
  console.error('commonplace commit: --message "<what this unit did>" is required.');
  process.exit(2);
}

const r = commitUnit(vault, unitId, { message: values.message });
switch (r.status) {
  case "committed":
    out(r, `Committed ${r.paths.length} file(s) as ${r.commit.slice(0, 10)}.`);
    break;
  case "empty":
    out(r, "Nothing to commit: this unit's files already match the branch.");
    break;
  case "conflict":
    out(
      r,
      `Not committed — left in the working tree as it is:\n${r.conflicts.map((c) => `- ${c.path || "(branch)"}: ${c.reason}`).join("\n")}`,
    );
    process.exitCode = 1;
    break;
  case "missing":
    out(r, `No unit ${unitId}: this session has written no vault files under it.`);
    break;
  case "no-repo":
    out(r, "The vault is not a git repository; nothing was committed. (`git init` in the vault turns unit commits on.)");
    break;
  case "detached":
    out(r, "The vault's HEAD is detached; agents commit only to a branch. Nothing was committed.");
    process.exitCode = 1;
    break;
}
