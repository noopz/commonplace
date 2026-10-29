/**
 * The v2 graph from the CLI, for revision work: the same `VaultIndex` the
 * module and the vault-tool twins load, opened to exactly the shards this
 * process may see (COMMONPLACE_OPEN, injected by the module from the
 * session's own open set).
 */

import { appendFileSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { loadDomainRegistry } from "../vault.ts";
import { VaultIndex, type IndexPorts } from "../../../hooks/lib/index/load.ts";
import type { DomainMap } from "../../../hooks/lib/core/scope.ts";

export function openShardsFromEnv(): string[] {
  return String(process.env.COMMONPLACE_OPEN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_.-]+$/.test(s));
}

export async function loadIndex(vault: string, shards: readonly string[]): Promise<{ index: VaultIndex; domains: DomainMap } | null> {
  const wiki = join(vault, ".wiki");
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
  const index = new VaultIndex(ports, domains);
  if ((await index.load()) !== "ready") return null;
  for (const s of shards) await index.openShard(s);
  return { index, domains };
}
