export interface PaperMetadata {
  title: string;
  authors: string[];
  abstract: string;
  arxivId: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  pdfUrl: string | null;
  totalPages: number;
}

export interface DetectedSection {
  sectionType: string;
  sectionName: string;
  startPage: number;
  endPage: number;
  pageCount: number;
  importance: "critical" | "high" | "medium" | "low";
}

export interface SectionDetectionResult {
  totalPages: number;
  detectedSections: DetectedSection[];
  sectionCount: number;
}

export interface ExtractionStrategy {
  name: "full_extraction" | "critical_sections" | "critical_only" | "smart_overview_fallback";
  totalPages: number;
  sectionsToExtract: string[];
  estimatedTokens: number;
}

export interface ExtractedContent {
  strategy: ExtractionStrategy;
  sections: {
    name: string;
    pages: string;
    text: string;
  }[];
}

export interface CitationInfo {
  referenceNumber: number;
  count: number;
  fullText: string;
  author: string | null;
  year: string | null;
  arxivId: string | null;
}

export interface CitationAnalysis {
  referencesFound: boolean;
  statistics: {
    totalReferences: number;
    arxivPapers: number;
    yearRange: string;
    averageYear: number | null;
    totalInTextCitations: number;
  };
  keyPapers: CitationInfo[];
  allReferences: CitationInfo[];
}

export interface EnrichmentResult {
  sourcesChecked: string[];
  metadata: {
    arxiv?: {
      title: string;
      authors: string[];
      abstract: string;
      published: string;
      updated: string;
      categories: string[];
    };
    semanticScholar?: {
      title: string;
      authors: string[];
      year: number;
      citationCount: number;
      influentialCitationCount: number;
      abstract: string;
      venue: string;
    };
    github?: {
      name: string;
      url: string;
      stars: number;
      language: string;
      description: string;
    }[];
  };
}

export interface QualityScore {
  score: number;
  passed: boolean;
  grade: "EXCELLENT" | "GOOD" | "ACCEPTABLE" | "NEEDS_IMPROVEMENT";
  checks: { name: string; passed: boolean; points: number }[];
  warnings: string[];
  errors: string[];
}
