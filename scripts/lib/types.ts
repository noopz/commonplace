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
}

export interface DomainEntry {
  slug: string;
  path: string;
  scope: "professional" | "hobby";
}

export interface DomainRegistry {
  domains: Record<string, { path: string; scope: "professional" | "hobby" }>;
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
  scope: "professional" | "hobby";
  tags: string[];
  concepts: string[];
  mocs: string[];
  buildsOn: string[];
  comparesWith: string[];
  usesMethod: string[];
}

export interface ConceptNote {
  name: string;
  path: string;
  domains: string[];
  backlinkCount: number;
  isStub: boolean;
}

export interface MocNote {
  name: string;
  path: string;
  domains: string[];
  sourceCount: number;
  declaredCount: number | null;
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
  scope: "professional" | "hobby";
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
  sourceScope: "professional" | "hobby";
  targetScope: "professional" | "hobby";
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
