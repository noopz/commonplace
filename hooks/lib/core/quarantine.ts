/**
 * Quarantined folders: top-level folders that appeared after the first v2
 * index and belong to no domain (model.ts `shardFor`). Their notes stay sealed
 * until the person classifies the folder, which registers it as a domain —
 * there is no domain entry to flip, so `/vault domain public|private` takes a
 * folder name too, and the quarantine pane offers the same per folder, as a
 * tree of what the folder holds so the person can tell what it is.
 *
 * From paths alone: nothing here reads a sealed note.
 */
import { shardFor } from "../index/model.ts";
import type { DomainMap } from "./scope.ts";

export type QuarantinedFolder = { folder: string; notes: number; rels: string[] };

const push = <T,>(m: Map<string, T[]>, k: string, v: T) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

/** The quarantined top folders among `rels` (vault-relative note paths), largest first. */
export function quarantinedFolders(
  rels: readonly string[],
  opts: { domains: DomainMap; knownLoose: ReadonlySet<string>; structureDirs: readonly string[] },
): QuarantinedFolder[] {
  const byFolder = new Map<string, string[]>();
  for (const rel of rels) {
    if (shardFor(rel, undefined, opts) === "quarantine") push(byFolder, rel.slice(0, rel.indexOf("/")), rel);
  }
  return [...byFolder]
    .map(([folder, list]) => ({ folder, notes: list.length, rels: list }))
    .sort((a, b) => b.notes - a.notes || a.folder.localeCompare(b.folder));
}

/** One line of the tree: a folder (`notes` beneath it) or a note. `path` is what expanding toggles. */
export type TreeRow = { depth: number; name: string; path: string; notes: number | null; open: boolean };

/** Notes drawn per folder: enough to tell what it is, and a pane of thousands of rows would redraw them all. */
const TREE_NOTES_MAX = 100;

/** The folders as tree lines, descending only into `open` paths; subfolders first, then notes, by name. */
export function treeRows(folders: readonly QuarantinedFolder[], open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (path: string, rels: readonly string[], depth: number) => {
    const dirs = new Map<string, string[]>();
    const notes: string[] = [];
    for (const rel of rels) {
      const tail = rel.slice(path.length + 1);
      const cut = tail.indexOf("/");
      if (cut < 0) notes.push(tail);
      else push(dirs, tail.slice(0, cut), rel);
    }
    for (const [dir, list] of [...dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const sub = `${path}/${dir}`;
      rows.push({ depth, name: dir, path: sub, notes: list.length, open: open.has(sub) });
      if (open.has(sub)) walk(sub, list, depth + 1);
    }
    for (const note of notes.sort((a, b) => a.localeCompare(b)).slice(0, TREE_NOTES_MAX)) {
      rows.push({ depth, name: note.replace(/\.md$/, ""), path: `${path}/${note}`, notes: null, open: false });
    }
    if (notes.length > TREE_NOTES_MAX) rows.push({ depth, name: `… ${notes.length - TREE_NOTES_MAX} more`, path: `${path}/…`, notes: null, open: false });
  };
  for (const f of folders) {
    rows.push({ depth: 0, name: f.folder, path: f.folder, notes: f.notes, open: open.has(f.folder) });
    if (open.has(f.folder)) walk(f.folder, f.rels, 1);
  }
  return rows;
}

/** Mark `folder` as `scope` in the registry, adding a domain if it has none. Returns its id. */
export function applyClassification(domains: Record<string, Record<string, unknown>>, folder: string, scope: "public" | "private"): string {
  const id = Object.keys(domains).find((d) => String(domains[d].path ?? "").replace(/\/+$/, "") === folder) ?? domainIdFor(domains as never, folder);
  domains[id] = { ...(domains[id] ?? { path: folder }), scope };
  return id;
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
