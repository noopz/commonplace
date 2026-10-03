// types/index.d.ts — the `$.commonplace` contract.
//
// Self-contained on purpose: no import, no reference. A plugin that lists
// commonplace under `dependencies` gets this file laid into its own
// `.claude-plugin/types/commonplace/index.d.ts`, so nothing here may point
// elsewhere. Exported names are led by `Commonplace`.
//
// apiVersion 1. Semver: removing a method or a field is a major; adding an
// optional field is a minor.
//
// STATUS (v2 Phase 0): the contract is declared, the noun is NOT yet added to
// `$` — no `engine.create` registration ships until probe P4 settles how a
// noun's methods run. Until then `$.commonplace` is absent at run time, and a
// dependent must not call it. The `band` state key below IS live.
//
// Privacy rules the contract is shaped by:
//   - No method changes scope, names a sealed domain, or returns anything a
//     sealed session could not see. There is no `open`, `close`, `useVault`
//     or `privateNames`, deliberately.
//   - A plugin hooking `commonplace.search` (or any `commonplace.<method>`)
//     above commonplace sees only the already-filtered `value`: it can narrow
//     or deny a result, never widen it.
//   - `$.state` is readable by every plugin, so nothing private and nothing
//     scope-authoritative is kept there.

/** The contract's version, as `version()` reports it. */
export type CommonplaceApiVersion = 1;

export type CommonplaceVaultInfo = {
  id: string;
  label: string;
  path: string;
  aliases: string[];
  isDefault: boolean;
  isActive: boolean;
  isPrivate: boolean;
  index: CommonplaceIndexStatus;
};

export type CommonplaceIndexStatus = {
  state: "absent" | "stale" | "building" | "ready";
  version: number;
  journalSeq: number;
  nodes: number;
  edges: number;
  builtAt: string | null;
  lastPatchMs: number | null;
};

/** Redacted on purpose: no domain ids. The real scope lives in commonplace's module memory. */
export type CommonplaceScope = { vault: string; openCount: number };

export type CommonplaceNodeKind = "source" | "concept" | "moc" | "other";

export type CommonplaceEdgeKind =
  | "body"
  | "concept"
  | "moc"
  | "buildsOn"
  | "comparesWith"
  | "usesMethod"
  | "supersedes";

export type CommonplaceCard = {
  id: number;
  vault: string;
  path: string;
  title: string;
  kind: CommonplaceNodeKind;
  domain: string;
  abstraction: string;
  inDegree: number;
  outDegree: number;
  tags: string[];
  isStub: boolean;
  isRetired: boolean;
  /** Present only for an OPEN private note; a sealed note never appears. */
  isPrivate?: true;
};

export type CommonplaceSearchArgs = {
  query: string;
  limit?: number;
  vault?: string;
  kinds?: CommonplaceNodeKind[];
  domain?: string;
};
export type CommonplaceSearchHit = CommonplaceCard & { rank: number; matched: string[] };
export type CommonplaceSearchResult = { hits: CommonplaceSearchHit[]; vault: string; tookMs: number };

export type CommonplaceNoteArgs = { ref: string; vault?: string; maxChars?: number };

export type CommonplaceLink = {
  from: CommonplaceCard;
  to: CommonplaceCard;
  kind: CommonplaceEdgeKind;
  weight: number;
  /** "Why this link exists": heading + first sentence, "" when unavailable. Pointer text, not evidence. */
  why: string;
  heading: string;
};

export type CommonplaceNote = {
  card: CommonplaceCard;
  text: string;
  truncated: boolean;
  out: CommonplaceLink[];
  in: CommonplaceLink[];
  moreOut: number;
  moreIn: number;
  unread: CommonplaceCard[];
};

export type CommonplaceLinksArgs = {
  note: string;
  direction?: "out" | "in" | "both";
  kinds?: CommonplaceEdgeKind[];
  limit?: number;
  vault?: string;
  withWhy?: boolean;
};
export type CommonplaceLinksResult = { card: CommonplaceCard; links: CommonplaceLink[]; tookMs: number };

export type CommonplacePathArgs = {
  from: string;
  to: string;
  maxHops?: number;
  avoidHubs?: boolean;
  vault?: string;
};
export type CommonplacePathResult = { path: CommonplaceLink[] | null; cost: number | null; tookMs: number };

export type CommonplaceNeighbourhoodArgs = { seeds: string[]; k?: number; vault?: string };
export type CommonplaceNeighbour = { card: CommonplaceCard; rank: number; via: CommonplaceLink | null };
export type CommonplaceNeighbourhoodResult = { pool: CommonplaceNeighbour[]; tookMs: number };

export type CommonplaceListArgs = {
  what: "domains" | "mocs" | "recent" | "stubs" | "vaults";
  vault?: string;
  limit?: number;
};
export type CommonplaceListResult = { items: Array<Record<string, string | number | boolean>> };

export type CommonplaceSkillInfo = { name: string; description: string; vault: string; trusted: boolean };
export type CommonplaceSkillBody = CommonplaceSkillInfo & { text: string };

export type CommonplaceReindexArgs = { vault?: string; paths?: string[]; full?: boolean };

/** A recoverable failure is a value, not a refusal; policy refusals arrive as the event's `{ deny }`. */
export type CommonplaceError = { error: string };

/**
 * The status band above the prompt, as commonplace draws it.
 *
 * A receipt, not a dashboard: raised when the vault was actually consulted,
 * lowered at the next `prompt.submit`. The breaker's error text is NOT here —
 * it can carry a note path, and this value is readable by every plugin — so
 * commonplace keeps it in module memory and composes the line at render time.
 */
export type CommonplaceBand = {
  /** Whether the band is drawn right now. */
  visible: boolean;
  phase: "idle" | "ok" | "warn";
  /** Index record counts from the last load. */
  sources: number;
  concepts: number;
  /** Connections surfaced this session. */
  surfaced: number;
  /** A fixed outcome label ("off-topic", "surfaced a connection", ...). */
  lastOutcome: string;
  /** The circuit breaker has stopped the ambient pass. */
  paused: boolean;
};

export type Commonplace = {
  version(): Promise<{ apiVersion: CommonplaceApiVersion; plugin: string }>;
  vaults(): Promise<CommonplaceVaultInfo[]>;
  activeVault(): Promise<CommonplaceVaultInfo | null>;
  scope(args?: { vault?: string }): Promise<CommonplaceScope>;
  search(args: CommonplaceSearchArgs): Promise<CommonplaceSearchResult>;
  note(args: CommonplaceNoteArgs): Promise<CommonplaceNote | CommonplaceError>;
  links(args: CommonplaceLinksArgs): Promise<CommonplaceLinksResult | CommonplaceError>;
  path(args: CommonplacePathArgs): Promise<CommonplacePathResult | CommonplaceError>;
  neighbourhood(args: CommonplaceNeighbourhoodArgs): Promise<CommonplaceNeighbourhoodResult | CommonplaceError>;
  list(args: CommonplaceListArgs): Promise<CommonplaceListResult>;
  skills(args?: { vault?: string }): Promise<CommonplaceSkillInfo[]>;
  skill(args: { name: string; vault?: string }): Promise<CommonplaceSkillBody | CommonplaceError>;
  reindex(args: CommonplaceReindexArgs): Promise<CommonplaceIndexStatus>;
  status(args?: { vault?: string }): Promise<CommonplaceIndexStatus>;
};

declare module "claude-code" {
  interface EngineInterface {
    commonplace: Commonplace;
  }
  interface PluginState {
    commonplace: {
      // Live. Dependents: on("state.set", { plugin: "commonplace", key: "band" }).
      band: CommonplaceBand;
      // Planned with their writers (index engine, scope, tool activity):
      // index: CommonplaceIndexStatus; scope: CommonplaceScope;
      // activity: { tool: string; startedAt: number } | null;
    };
  }
}
