export interface VaultConfig {
  vaultPath: string;
  wikiPath: string;
  claudeMdPath: string;
}

export interface WikiStructure {
  sources: string;   // relative path from vault root, e.g. "02 - Areas/Research"
  concepts: string;  // e.g. "02 - Areas/Concepts"
  mocs: string;      // e.g. "02 - Areas/MOCs"
}

export interface WikiConfig {
  structure: WikiStructure;
  stubPattern: string;      // e.g. "Definition pending"
  mocCountPattern: string;  // e.g. "**Papers:** N"
  lintExclude?: string[];   // path substrings to skip during lint (e.g. ["99 - Meta", "Templates"])
  rawFolder?: string;       // folder for uningested raw files, default "raw"
  abstractions?: boolean;  // true once `commonplace abstract` has backfilled this vault
  /** MOC size governance caps (moc-size lint). All optional; defaults 20/25/10/3. */
  moc?: {
    softCap?: number;              // sources per MOC before a split is recommended
    hardCap?: number;              // sources per MOC before a split is required
    requireSubsectionsAt?: number; // listing size at which ### subsections are expected
    minSourcesForNewMoc?: number;  // minimum sources to justify creating a sub-MOC
  };
  /** Ingest consolidation-as-flag (near-duplicate-content lint, impact.ts). */
  consolidation?: {
    threshold?: number; // abstraction Jaccard similarity at which two sources flag as candidates (default 0.5)
  };
}

export interface DomainEntry {
  slug: string;
  path: string;
  scope: "public" | "private";
  linkGroup?: string;
}

export interface DomainRegistry {
  domains: Record<string, { path: string; scope: "public" | "private"; linkGroup?: string }>;
}

export type NoteType = "source" | "concept" | "moc" | "other";

export type SourceTag =
  | "paper"
  | "article"
  | "report"
  | "model-card"
  | "whitepaper"
  | "technical-report"
  | "data"
  | "project"
  | "note";

export interface ParsedNote {
  filePath: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
  noteType: NoteType;
}

export interface SourceNote {
  title: string;
  path: string;
  domain: string;
  scope: "public" | "private";
  tags: string[];
  concepts: string[];
  mocs: string[];
  buildsOn: string[];
  comparesWith: string[];
  usesMethod: string[];
  /** Indexed retrieval key: ~6-12 word noun-phrase descriptor. Absent on un-migrated notes. */
  abstraction?: string;
  /** Outgoing wikilink display texts — the note's cue anchors (Tier B seed keys). */
  anchors?: string[];
  /** HITS scores over the body-wikilink graph; omitted when the note has no link presence. */
  hub?: number;
  authority?: number;
}

export interface CompiledFromEntry {
  path: string;
  hash: string;
}

export interface ConceptNote {
  name: string;
  path: string;
  domains: string[];
  backlinkCount: number;
  isStub: boolean;
  /** Indexed retrieval key: ~6-12 word noun-phrase descriptor. Absent on un-migrated notes. */
  abstraction?: string;
  /** Outgoing wikilink display texts — the note's cue anchors (Tier B seed keys). */
  anchors?: string[];
  /** HITS scores over the body-wikilink graph; omitted when the note has no link presence. */
  hub?: number;
  authority?: number;
  compiledFrom?: CompiledFromEntry[];
}

export interface MocNote {
  name: string;
  path: string;
  domains: string[];
  sourceCount: number;
  sources: string[];
  declaredCount: number | null;
  /** HITS scores over the body-wikilink graph; omitted when the note has no link presence. */
  hub?: number;
  authority?: number;
}

export interface IndexData {
  sources: SourceNote[];
  concepts: ConceptNote[];
  mocs: MocNote[];
  domains: DomainSummary[];
  timestamp: string;
}

export interface DomainSummary {
  slug: string;
  path: string;
  scope: "public" | "private";
  sourceCount: number;
  conceptCount: number;
}

export type LintSeverity = "critical" | "improvement" | "suggestion";

export interface LintIssue {
  check: string;
  severity: LintSeverity;
  file: string;
  message: string;
  fixable: boolean;
  scope?: "public" | "private";
  suggestion?: string;
}

export interface LintResult {
  critical: LintIssue[];
  improvement: LintIssue[];
  suggestion: LintIssue[];
  summary: {
    total: number;
    critical: number;
    fixable: number;
  };
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ScopeViolation {
  sourceFile: string;
  targetFile: string;
  sourceDomain: string;
  targetDomain: string;
  sourceScope: string;
  targetScope: string;
  reason: string;
}

export interface VaultScoreDimension {
  name: string;
  score: number; // 0-1
  weight: number; // points out of 100
  weighted: number; // score * weight, rounded
  details: Record<string, number>;
}

export interface VaultScore {
  score: number; // 0-100
  grade: string; // A/B/C/D/F
  dimensions: VaultScoreDimension[];
  counts: {
    sources: number;
    concepts: number;
    stubs: number;
    mocs: number;
    criticalIssues: number;
  };
  timestamp: string;
}

export interface PruneResult {
  deleted: Array<{ concept: string; path: string; reason: string }>;
  wouldDelete?: Array<{ concept: string; path: string; reason: string }>;
  cleanup: Array<{
    file: string;
    concept: string;
    location: "frontmatter" | "body";
    instruction: string;
    replacement?: string;
  }>;
  review: Array<{
    concept: string;
    path: string;
    backlinkCount: number;
    referencedBy: string[];
  }>;
  summary: { deleted: number; cleanupNeeded: number; reviewCount: number };
}
