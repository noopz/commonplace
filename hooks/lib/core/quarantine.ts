/**
 * Quarantined folders: top-level folders that appeared after the first v2
 * index and belong to no domain (model.ts `shardFor`). Their notes stay sealed
 * until the person classifies the folder, which registers it as a domain —
 * there is no domain entry to flip, so `/vault domain public|private` takes a
 * folder name too, and the quarantine pane offers the same per folder.
 *
 * From paths alone: nothing here reads a sealed note.
 */
import { shardFor } from "../index/model.ts";
import type { DomainMap } from "./scope.ts";

export type QuarantinedFolder = { folder: string; notes: number };

/** The quarantined top folders among `rels` (vault-relative note paths), largest first. */
export function quarantinedFolders(
  rels: readonly string[],
  opts: { domains: DomainMap; knownLoose: ReadonlySet<string>; structureDirs: readonly string[] },
): QuarantinedFolder[] {
  const count = new Map<string, number>();
  for (const rel of rels) {
    if (shardFor(rel, undefined, opts) !== "quarantine") continue;
    const top = rel.slice(0, rel.indexOf("/"));
    count.set(top, (count.get(top) ?? 0) + 1);
  }
  return [...count].map(([folder, notes]) => ({ folder, notes })).sort((a, b) => b.notes - a.notes || a.folder.localeCompare(b.folder));
}

/** A new domain id for `folder`: a slug of its name, unique in `domains`. */
export function domainIdFor(domains: DomainMap, folder: string): string {
  const base =
    folder
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "folder";
  let id = base;
  for (let i = 2; id in domains; i++) id = `${base}-${i}`;
  return id;
}
