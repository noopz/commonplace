# commonplace

A Claude Code plugin that turns any folder into an LLM-maintained knowledge base. Inspired by the commonplace book tradition and [Karpathy's approach](https://x.com/karpathy/status/1899559051789553968) to using LLMs for personal wiki management.

Works on any directory — Obsidian vault, plain folder, whatever. Obsidian is not required; it's just a good browser for `[[wikilink]]` markdown if you use it.

## What it does

- **wiki-init**: Point commonplace at a folder for the first time → scaffold `.wiki/`, discover initial domains
- **wiki-ingest**: Share a paper, article, or URL → structured vault note + concepts + MOC links
- **wiki-query**: Ask research questions → answers with wikilinks + novel connections filed back
- **wiki-lint**: Ask "how's the vault?" → read-only health report
- **autoimprove**: "improve the vault" → score-gated loop that picks fixes, executes, re-scores, repeats
- **wiki-compile**: Fill concept stubs with real definitions from source papers
- **wiki-supersede**: Retire an entity replaced by a successor, propagate the live→historical reframing
- **wiki-domain**: Create or manage research domains with scope rules
- **wiki-deep-link**: Find hidden concept connections via local embeddings (Ollama)
- **paper-analyzer**: Deep paper analysis with smart PDF extraction and multi-agent review

## How it works

Skills auto-trigger from natural conversation. You never type slash commands — just chat and the right skill activates.

## Skill interactions

```
                        ┌─────────────┐
                        │  wiki-init  │  (one-time setup)
                        └──────┬──────┘
                               │ writes .vault-path
                               ▼
            ┌──────────────────────────────────────┐
            │            (vault is active)         │
            └──────────────────────────────────────┘
                               │
            ┌──────────────────┼──────────────────────────┐
            │                  │                          │
            ▼                  ▼                          ▼
     ┌────────────┐    ┌─────────────┐            ┌──────────────┐
     │ wiki-domain│    │ wiki-ingest │ ◀───┐      │  wiki-query  │
     └────────────┘    └──────┬──────┘     │      └──────┬───────┘
       (new domain             │ paper?    │             │ pivot Q
        when ingest             │ ─yes──▶ paper-analyzer  │ "how does
        finds none)             │           (returns      │  this relate
                                │            analysis)    │  to X?")
                                ▼                        │
                        ┌──────────────┐                 │ ◀────┘
                        │ supersession │   (post-ingest pivot
                        │  declared in │    auto-fires wiki-query)
                        │   body? ──yes┼─▶ wiki-supersede
                        └──────┬───────┘
                               │ no
                               ▼
                       ┌────────────────┐
                       │ post-write hook│
                       │  (deterministic)│
                       └──────┬─────────┘
                              │ dispatches
              ┌───────────────┼─────────────────┐
              ▼               ▼                 ▼
      wiki-moc-updater  wiki-impact-checker  wiki-cross-domain-linker
                                  │
                                  └─ supersession candidate ──▶ wiki-supersede

  Read-only path:                    Autonomous-write path:
  ┌──────────────┐                   ┌──────────────┐
  │  wiki-lint   │ ◀── if fixes ──▶ │ autoimprove  │
  │  (diagnose)  │     wanted        │ (score loop) │
  └──────────────┘                   └──────┬───────┘
                                            │ dispatches per round
                          ┌─────────────────┼────────────────┬──────────────────┐
                          ▼                 ▼                ▼                  ▼
                   wiki-linter      wiki-pruner      wiki-moc-updater   wiki-deep-linker
                                   (refuses retired                       (semantic
                                    → wiki-supersede)                      candidates)
                                            │
                                            ▼
                                    wiki-compile (inline at main-model cost)
                                            │
                                            ▼
                                    wiki-freshness-checker (post-loop)

  Bottom-up triggers (any skill → wiki-supersede):
    • wiki-query lands on retired note
    • wiki-pruner asked to delete retired
    • wiki-impact-checker flags candidate
    • commonplace lint reports retired-but-referenced
```

| Skill | Triggers on | Hands off to | Receives from |
|---|---|---|---|
| wiki-init | first-time setup; missing `.vault-path` | (none) | (entry point) |
| wiki-domain | "set up a domain", "list domains" | (none) | wiki-ingest (no domain match) |
| wiki-ingest | "save this", arXiv ID, paper URL | paper-analyzer; wiki-supersede; wiki-domain; post-write hook | (entry point) |
| paper-analyzer | "analyze this paper"; arXiv without save intent | (returns analysis) | wiki-ingest |
| wiki-query | "how does X relate to Y"; post-ingest pivot | wiki-supersede (retired note) | wiki-ingest |
| wiki-supersede | "mark X retired"; body declares supersession; retired-but-live debt | (terminal) | wiki-ingest, wiki-query, wiki-pruner, wiki-impact-checker |
| wiki-lint | "how's the vault" — read-only | autoimprove (if fixes wanted) | (entry point) |
| autoimprove | "improve the vault", "what's the score" | wiki-linter, wiki-pruner, wiki-moc-updater, wiki-deep-linker, wiki-compile, wiki-freshness-checker | wiki-lint |
| wiki-compile | "fill the stubs" | (none) | autoimprove; wiki-lint |
| wiki-deep-link | "find hidden connections" (needs Ollama) | (none) | autoimprove (optional) |

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
