/**
 * The accepted projection (docs/revision-design.md, "Accepted projection"):
 * what the reducer has accepted, rebuilt from committed accept events. The CLI
 * writes it to `.wiki/revision/projection.json` (and per private shard under
 * `.wiki/sealed/<shard>/revision/`); readers decide from it which frontmatter
 * edges are reviewed. Sandbox-safe.
 *
 * Modes:
 *   - auto:   only the reducer creates accepted state. A frontmatter edge with
 *             no accept is a candidate and is not shown as a status, except
 *             edges that predate revision (the baseline), shown unreviewed.
 *   - manual: every frontmatter edge shows, marked unreviewed.
 */

import { edgeKey, targetKey, type EdgeRel, type RevisionRelation, type RevisionStatus } from "./edges.ts";

export type AcceptedEdge = {
  key: string;
  /** Vault-relative path of the newer note carrying the edge. */
  from: string;
  relation: RevisionRelation;
  /** Title of the older note. */
  to: string;
  rel: EdgeRel;
  event: string;
  seq: number;
  commit?: string;
};

export type StaleMark = {
  /** Vault-relative path of a concept/MOC that may rely on a displaced claim. */
  rel: string;
  /** Title of the note whose claim was displaced. */
  displaced: string;
  event: string;
};

export type Projection = {
  v: 1;
  /** This file's scope's mode (the public file's is the vault's). */
  mode: "auto" | "manual";
  /** Scopes ("main" or shard ids) whose edges run in auto mode; merged across files. */
  autoScopes: string[];
  builtAt: string;
  accepted: AcceptedEdge[];
  /** Edge keys present when revision was enabled: legacy, shown unreviewed. */
  baseline: string[];
  stale: StaleMark[];
};

export const PROJECTION_FILE = "revision/projection.json";
export const shardProjectionFile = (shard: string) => `sealed/${shard}/revision/projection.json`;

export const EMPTY_PROJECTION: Projection = { v: 1, mode: "manual", autoScopes: [], builtAt: "", accepted: [], baseline: [], stale: [] };

export function parseProjection(text: string | null): Projection | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Projection;
    if (!p || p.v !== 1 || !Array.isArray(p.accepted)) return null;
    return { ...p, autoScopes: Array.isArray(p.autoScopes) ? p.autoScopes : [] };
  } catch {
    return null;
  }
}

/** Merge the public projection with open shards' ones (mode from the public file). */
export function mergeProjections(list: ReadonlyArray<Projection | null>): Projection {
  const base = list[0] ?? EMPTY_PROJECTION;
  const out: Projection = { ...base, autoScopes: [...base.autoScopes], accepted: [...base.accepted], baseline: [...base.baseline], stale: [...base.stale] };
  for (const p of list.slice(1)) {
    if (!p) continue;
    out.autoScopes.push(...p.autoScopes);
    out.accepted.push(...p.accepted);
    out.baseline.push(...p.baseline);
    out.stale.push(...p.stale);
  }
  return out;
}

/** One frontmatter edge into a note, as read from the graph. */
export type GraphEdge = { fromRel: string; fromTitle: string; relation: RevisionRelation; rel?: EdgeRel; /** The newer note's scope ("main" or a shard). */ fromShard?: string };

/**
 * The statuses a note shows: frontmatter edges filtered by mode, plus accepted
 * edges whose frontmatter was removed by someone other than the reducer (the
 * accepted state stands until the reducer itself changes it).
 */
export function statusesFor(
  noteTitle: string,
  noteAliases: readonly string[],
  edges: readonly GraphEdge[],
  proj: Projection,
  titleOfRel: (rel: string) => string | undefined,
): RevisionStatus[] {
  const out: RevisionStatus[] = [];
  const accepted = new Map(proj.accepted.map((a) => [a.key, a]));
  const baseline = new Set(proj.baseline);
  const seen = new Set<string>();
  for (const e of edges) {
    const key = edgeKey(e.fromRel, e.relation, noteTitle, e.rel?.claim);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!proj.autoScopes.includes(e.fromShard ?? "main")) {
      out.push({ relation: e.relation, by: e.fromTitle, ...(e.rel ? { rel: e.rel } : {}), reviewed: false });
      continue;
    }
    const a = accepted.get(key);
    if (a) out.push({ relation: e.relation, by: e.fromTitle, rel: a.rel, reviewed: true });
    else if (baseline.has(key)) out.push({ relation: e.relation, by: e.fromTitle, ...(e.rel ? { rel: e.rel } : {}), reviewed: false });
    // else: a candidate nobody accepted — not a status.
  }
  {
    const keys = new Set([noteTitle, ...noteAliases].map(targetKey));
    for (const a of proj.accepted) {
      if (seen.has(a.key) || !keys.has(targetKey(a.to))) continue;
      const by = titleOfRel(a.from);
      if (!by) continue; // the newer note is gone or not visible
      seen.add(a.key);
      out.push({ relation: a.relation, by, rel: a.rel, reviewed: true });
    }
  }
  const order: Record<RevisionRelation, number> = { supersedes: 0, withdrawsSupport: 1, bounds: 2, contests: 3 };
  return out.sort((x, y) => order[x.relation] - order[y.relation] || (x.by < y.by ? -1 : x.by > y.by ? 1 : 0));
}

/** Stale marks for one note path. */
export const staleFor = (rel: string, proj: Projection): StaleMark[] => proj.stale.filter((s) => s.rel === rel);
