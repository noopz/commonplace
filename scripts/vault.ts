#!/usr/bin/env tsx
/**
 * Inspect and choose vaults.
 *
 *   commonplace vault [show] [--json]        which vault this cwd resolves to, and why
 *   commonplace vault list [--json]          registered vaults
 *   commonplace vault use <id|alias>         pin this project to a vault
 *   commonplace vault use <id> --default     make it the registry default (never a private vault)
 *   commonplace vault unpin                  remove this project's pin
 *
 * "This project" is the caller's cwd. The pin file is shared with the
 * in-process module's `/vault use`, so the CLI and a session agree.
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  chooseVault,
  loadVaultRegistry,
  saveVaultRegistry,
  loadVaultPins,
  saveVaultPins,
} from "./lib/vault.js";
import { findByRef, setDefault, pinFor } from "./lib/registry.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean", default: false },
    default: { type: "boolean", default: false },
  },
});

const [sub = "show", arg] = positionals;
const cwd = resolve(process.env.COMMONPLACE_CALLER_CWD || process.cwd());
const reg = loadVaultRegistry();

function fail(msg: string): never {
  console.error(`commonplace vault: ${msg}`);
  process.exit(1);
}

switch (sub) {
  case "show": {
    const choice = chooseVault(undefined, cwd);
    if (values.json) {
      console.log(JSON.stringify(choice));
    } else if (!choice) {
      console.log("No vault resolves here. Run `commonplace init --vault <path>`.");
    } else {
      const why = {
        explicit: "--vault",
        pin: "pinned for this project",
        cwd: "cwd is inside it",
        default: "registry default",
      }[choice.via];
      console.log(`${choice.id ?? "(unregistered)"}\t${choice.path}\t(${why})`);
    }
    break;
  }
  case "list": {
    if (values.json) {
      console.log(JSON.stringify({ default: reg.default, vaults: reg.vaults }));
      break;
    }
    if (reg.vaults.length === 0) {
      console.log("No vaults registered. Run `commonplace init`.");
      break;
    }
    const active = chooseVault(undefined, cwd);
    for (const v of reg.vaults) {
      const tags = [
        v.id === reg.default ? "default" : "",
        v.isPrivate ? "private" : "",
        active?.id === v.id ? "active" : "",
      ].filter(Boolean);
      const aliases = v.aliases.length ? `  aliases: ${v.aliases.join(", ")}` : "";
      console.log(`${v.id}${tags.length ? ` (${tags.join(", ")})` : ""}\t${v.label}\t${v.path}${aliases}`);
    }
    break;
  }
  case "use": {
    if (!arg) fail("usage: commonplace vault use <id|alias> [--default]");
    const entry = findByRef(reg, arg);
    if (!entry) fail(`no registered vault matches "${arg}" — see \`commonplace vault list\``);
    if (values.default) {
      const next = setDefault(reg, entry.id);
      if (typeof next === "string") fail(next);
      saveVaultRegistry(next);
      console.log(`Default vault is now ${entry.id}.`);
    } else {
      const pins = loadVaultPins();
      pins[cwd] = entry.id;
      saveVaultPins(pins);
      console.log(`Pinned ${cwd} → ${entry.id}.`);
    }
    break;
  }
  case "unpin": {
    const pins = loadVaultPins();
    const had = pinFor(pins, cwd);
    if (!(cwd in pins)) {
      console.log(had ? `No pin on ${cwd} itself (an ancestor pins ${had}).` : "No pin here.");
      break;
    }
    delete pins[cwd];
    saveVaultPins(pins);
    console.log(`Unpinned ${cwd}.`);
    break;
  }
  default:
    fail(`unknown subcommand "${sub}" (show | list | use | unpin)`);
}
