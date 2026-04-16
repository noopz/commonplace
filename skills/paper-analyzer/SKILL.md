---
name: paper-analyzer
description: "Deep analysis of research papers using smart PDF extraction and multi-agent analysis. This skill is called internally by wiki-ingest for paper sources — it produces a raw analysis document but does NOT write vault files itself. Can also be used standalone when the user wants a paper breakdown without vault integration. Handles papers of any length — adapts extraction strategy for short (<20 pages), medium (20-50), and long (50+) papers. Produces structured markdown with methodology, results, figures, citations, and quality scoring."
---

# Paper Analyzer

Analyze research papers with intelligent extraction that never loads entire PDFs into context. Uses section-based extraction adapted to paper length, multi-agent analysis for complex papers, and quality scoring to ensure thorough coverage.

## Key Innovation

Smart extraction adapts to paper structure. Even 100+ page papers stay within token budget because we extract only the critical sections (methods, results, experiments), never the full document.

## Quick Start

When you receive a paper to analyze (arXiv ID, URL, or PDF path):

1. **Acquire the paper** if needed:
   ```bash
   commonplace paper:fetch <arxiv-id-or-url>
   ```

2. **Get paper info** (minimal tokens):
   ```bash
   commonplace paper:extract <pdf> info
   ```

3. **Smart extraction** (adapts to paper length):
   ```bash
   commonplace paper:smart-extract <pdf>
   ```
   - <20 pages: Extracts everything except references
   - 20-50 pages: Critical + high-importance sections only
   - 50+ pages: Introduction + critical sections only

4. **Enrich metadata** from external sources:
   ```bash
   commonplace paper:enrich --arxiv-id <id>
   ```

5. **Extract figure/table captions** for reference:
   ```bash
   commonplace paper:figures <pdf>
   ```

6. **Analyze citations** to understand the paper's context:
   ```bash
   commonplace paper:citations <pdf>
   ```

## Analysis Workflow

### Simple Papers (< 20 pages, single domain)

Use single-agent analysis:
1. Run smart-extract (gets nearly everything)
2. Read `${CLAUDE_SKILL_DIR}/references/analysis_structure.md` for the analysis framework
3. Write the analysis following the output template at `${CLAUDE_SKILL_DIR}/assets/output_template.md`
4. Run quality check

### Complex Papers (20+ pages, multi-domain, dense methodology)

Use multi-agent analysis for deeper coverage:
1. Run smart-extract
2. Dispatch `paper-methodology-analyst` and `paper-results-interpreter` agents **in parallel**
3. Synthesize their outputs into a cohesive narrative
4. Dispatch `paper-reflection-agent` to review quality (scores 0-100)
5. If score < 80: extract additional sections identified as gaps, revise, re-score
6. Write final analysis using the output template

**Critical — agent context isolation**: Subagents have completely isolated context windows. They cannot see the parent conversation, files you've read, or scripts you've run. Every agent prompt must be self-contained and include:
- The absolute PDF path (e.g. `/tmp/papers/foo.pdf`)
- The extracted section text you want them to analyze (paste it inline)
- A clear task description (agents can run `commonplace` commands directly — it's on PATH)

Agents do have full tool access (Bash, Read, etc.) — the problem is they won't know what to operate on unless you tell them explicitly in the prompt.

The reflection loop is what makes analyses thorough — the reflection agent catches missing details, unsupported claims, and gaps that a single pass would miss.

### Multi-Paper Comparison

When comparing multiple papers:
1. Read `${CLAUDE_SKILL_DIR}/references/comparison_framework.md`
2. Run comparison script:
   ```bash
   commonplace paper:compare <analysis1.md> <analysis2.md>
   ```
3. Synthesize cross-paper insights using the framework's dimensions

## Quality Check

After writing an analysis, verify its completeness:
```bash
commonplace paper:quality <analysis.md> --min-score 60
```

The quality scorer checks for:
- Required sections (Core Contribution, Methodology, Results, etc.)
- Content depth (specific numbers, metrics, comparisons)
- Adequate length (target 2000+ words)
- No unfilled template placeholders

Target score: 80+ for production analyses. Scores below 60 indicate significant gaps.

## Output Format

Analyses use the template at `${CLAUDE_SKILL_DIR}/assets/output_template.md`. Key sections:
- **Metadata**: Title, authors, publication, links, tags
- **Core Contribution**: 2-3 sentences on what's new and why it matters
- **Background & Motivation**: Problem, limitations, why this matters
- **Methodology**: Overview, key components, architecture, equations, experimental setup
- **Results**: Main findings with tables, ablation studies, surprising findings
- **Critical Assessment**: Strengths, weaknesses, methodological quality
- **Key Takeaways**: 5 main points
- **Connections**: Papers this builds on, related contemporary work

## PDF Extraction Limitations

The TypeScript PDF extraction (`pdfjs-dist`) handles most academic papers well but has known issues with:
- **Scanned PDFs**: No OCR — text extraction will be empty or garbled
- **Heavy math notation**: Complex equations may not extract cleanly
- **Multi-column layouts**: Generally handled but some IEEE/ACM formats may have text ordering issues

If extracted text looks garbled or truncated, note this in the analysis and work with whatever is available. The metadata enrichment (arXiv abstract, Semantic Scholar) can fill gaps.

## Reference Files

- `${CLAUDE_SKILL_DIR}/references/analysis_structure.md` — Detailed guide on structuring paper analyses with examples
- `${CLAUDE_SKILL_DIR}/references/comparison_framework.md` — Framework for multi-paper comparative analysis
- `${CLAUDE_SKILL_DIR}/assets/output_template.md` — Markdown template for analysis output
