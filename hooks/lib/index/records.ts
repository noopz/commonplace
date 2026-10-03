/**
 * Maintenance records: the per-note facts the CLI's lint, impact, prune,
 * score, supersede and MOC tools work from (a source's concepts and MOCs, a
 * concept's domains and backlink count, a MOC's declared count, HITS scores).
 *
 * v1 kept these in five public `.wiki/*-index.jsonl` files, which also held
 * private rows. v2 keeps ONE typed file per shard, beside that shard's other
 * artefacts — `graph/records.jsonl` (public) and `sealed/<shard>/records.jsonl`
 * — so a private record lives where every other private byte lives, and is
 * read only when its shard is open. The `k` field names the record type; the
 * rest of the row is the v1 record unchanged, so readers need no translation.
 *
 * Sandbox-safe.
 */

export const RECORD_KINDS = ["source", "concept", "moc", "domain", "backlink"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** Serialise rows of one kind as tagged JSONL lines. */
export function recordLines(kind: RecordKind, rows: readonly object[]): string {
  return rows.map((r) => JSON.stringify({ k: kind, ...r })).join("\n") + (rows.length ? "\n" : "");
}

/** Rows of one kind from a records file, with the tag stripped. Malformed lines are skipped. */
export function recordsOfKind<T>(text: string | null | undefined, kind: RecordKind): T[] {
  const out: T[] = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    // Cheap prefix test before parsing: every line starts with its tag.
    if (!line.startsWith(`{"k":"${kind}"`)) continue;
    try {
      const { k: _k, ...rest } = JSON.parse(line) as { k: string } & Record<string, unknown>;
      out.push(rest as T);
    } catch {
      /* skip */
    }
  }
  return out;
}
