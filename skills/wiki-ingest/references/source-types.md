# Source Type Handling Guide

## Papers (arXiv, PDF, academic URLs)

**Detection signals:**
- arXiv IDs: `2501.12345`, `arxiv.org/abs/2501.12345`
- HuggingFace: `huggingface.co/papers/2501.12345`
- PDF URLs ending in `.pdf`
- User says "paper", "research", "study", "publication"

**Pipeline:**
1. Extract arXiv ID if present
2. Chain to paper-analyzer skill for deep analysis
3. Transform analysis into vault source note
4. Place in appropriate domain under `{structure.sources}/` (read from `.wiki/config.json`)

**Domain inference:**
- Financial/trading topics → `Financial Trading AI`
- Agent/LLM architecture → `Agent Foundations`
- AI dev tools/coding → `AI Development`
- Ask user if ambiguous

## Raw/ Files — Technical Reports, Model Cards, Data Files

Files in `raw/` are local copies of materials that may be hard to recover if the original source disappears (company blog PDFs, one-off CSV exports, saved pages). Treat the local file as canonical.

**Detection signals:**
- Path starts with `raw/` (most reliable signal)
- User says "model card", "system card", "whitepaper", "report", "I downloaded this"
- PDF with no arXiv ID and no academic venue
- CSV, TSV, or other data file

**Do NOT run the paper-analyzer pipeline for these.**

### PDFs (model cards, reports, whitepapers)

1. **Get the structure first:**
   ```bash
   commonplace paper:extract <pdf> info
   ```
2. **Orient with an overview:**
   ```bash
   commonplace paper:extract <pdf> overview
   ```
3. **Extract selectively** — target sections relevant to the user's interest, not the whole doc:
   ```bash
   commonplace paper:extract <pdf> range <start> <end>
   ```
4. **Synthesize a source note** — structure around what makes this document distinctive. For a model card: capabilities, safety evaluations, limitations, key design decisions. For a whitepaper: core thesis, key claims, evidence.

**Note body template:**
```markdown
# {Title}

**Publisher:** {org}
**Type:** model-card | whitepaper | technical-report
**Published:** {date}
**PDF:** [[raw/{filename}]]

## Summary
...

## Key Capabilities / Findings
...

## Safety & Deployment
(model cards / system cards only)

## Benchmark Results
(if applicable — use a table)

## Connections
...

## Notes
...
```

**Frontmatter:**
```yaml
tags: [report, topic1, topic2]  # or model-card, whitepaper, technical-report
```

### CSV / TSV / Data Files

1. **Small files (< 1MB):** read the file directly with the Read tool
2. **Large files:** read just the first 50-100 rows to understand schema and content
3. **Synthesize a data note** — include: what the data represents, schema/columns, key statistics or findings, source/provenance, date range if applicable

**Note body template:**
```markdown
# {Dataset Name}

**Source:** {where it came from}
**File:** [[raw/{filename}]]
**Date:** {export date or data range}
**Rows:** approx N
**Format:** CSV / TSV

## Schema
| Column | Type | Description |
|--------|------|-------------|
| ...    | ...  | ...         |

## Key Findings / Stats
...

## Connections
...

## Notes
...
```

**Frontmatter:**
```yaml
tags: [data, topic1, topic2]
```

### Saved HTML / EPUB

1. Try WebFetch on the original URL first — if still live, use that
2. If the saved file is the only copy, read it directly
3. Synthesize as a web article note (lighter treatment)

## Web Articles / Blog Posts

**Detection signals:**
- HTTP URLs (not arXiv or PDF)
- User shares a link and discusses it
- Patch notes, changelog, blog post mentions

**Pipeline:**
1. WebFetch the URL
2. Extract: title, author, date, key content
3. Synthesize into source note (shorter than paper notes)
4. Concepts are lighter — typically 2-5 per article vs 5-15 per paper

**Frontmatter differs slightly:**
```yaml
tags: [article, topic1, topic2]  # 'article' instead of 'paper'
```

## Coding Projects

**Detection signals:**
- User mentions a GitHub repo, project, or codebase
- User says "save this project", "add this to the vault"
- References to personal projects

**Pipeline:**
1. Read README.md, CLAUDE.md, package.json, key source files
2. Extract: purpose, architecture, dependencies, patterns, key decisions
3. Place in the projects directory — check vault CLAUDE.md Vault Structure section for the actual path

**Frontmatter:**
```yaml
tags: [project, language, framework]
cssclasses: []
created: YYYY-MM-DD
```

## Conversations / Direct Input

**Detection signals:**
- User describes a finding without a URL or paper
- "I learned that...", "Here's something interesting..."
- User pastes text content directly

**Pipeline:**
1. Ask clarifying questions if the domain or context is unclear
2. Structure into a source note
3. Use tag `[note]` instead of `[paper]` or `[article]`
4. Lighter treatment — may not need full concept extraction

## Patch Notes / Changelogs

**Detection signals:**
- Game patch notes, software releases
- URLs to changelog or release notes pages

**Pipeline:**
1. WebFetch the content
2. Extract: version, date, key changes
3. Focus on what changed and why it matters
4. Typically goes in a hobby domain (games) or coding-projects
