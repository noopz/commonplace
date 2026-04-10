# commonplace

A Claude Code plugin that turns any folder into an LLM-maintained knowledge base. Inspired by the commonplace book tradition and [Karpathy's approach](https://x.com/karpathy/status/1899559051789553968) to using LLMs for personal wiki management.

Works on any directory — Obsidian vault, plain folder, whatever. Obsidian is not required; it's just a good browser for `[[wikilink]]` markdown if you use it.

## What it does

- **wiki-ingest**: Share a paper, article, or URL → structured vault note + concepts + MOC links
- **wiki-lint**: Ask "how's the vault?" → health report + auto-fix mechanical issues
- **wiki-compile**: Fill concept stubs with real definitions from source papers
- **wiki-query**: Ask research questions → answers with wikilinks + novel connections filed back
- **wiki-domain**: Create new research domains with scope rules
- **paper-analyzer**: Deep paper analysis with smart PDF extraction and multi-agent review

## How it works

Skills auto-trigger from natural conversation. You never type slash commands — just chat and the right skill activates.

Three-tier cost model:
1. **TypeScript scripts** (zero LLM cost) — indexing, validation, linting
2. **Haiku agents** (cheap) — mechanical fixes, wikilink insertion, MOC syncing
3. **Main model** (synthesis) — paper analysis, concept definitions, query answers

## Install

```bash
git clone https://github.com/noopz/commonplace
cd commonplace
npm install

# Point it at your vault
npx tsx scripts/init.ts --vault /path/to/your/vault
```

## Dependencies

- `gray-matter` — YAML frontmatter parsing
- `glob` — File pattern matching
- `pdfjs-dist` — PDF text extraction
- `tsx` — TypeScript execution
