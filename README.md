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
- **paper-analyzer**: Deep paper analysis with smart PDF extraction and multi-agent review

## In the session

Claude gets vault tools (`vault_search`, `vault_note`, `vault_links`, `vault_path`, `vault_neighbourhood`) over a graph index of the notes, so it finds a note and follows its links instead of grepping. Domains marked private stay sealed — invisible to every tool, and their titles never written into code — unless the session starts inside one or you type `/vault open <domain>`.

Switches in the plugin's settings (`/config`):

| Setting | Default | What it does |
| --- | --- | --- |
| Ambient vault connections | on | One line under an answer when it connects to a note you already wrote, with **Read it** / **Not for me** (Not for me never surfaces that note again) |
| Vault links in replies | on | `[[links]]` in replies open the note; any that isn't in your vault, wasn't read, or is superseded gets flagged |
| Verdict card for pasted links | off | Paste a link Claude then reads → "already in your vault / extends a note / new" with **Ingest** / **Later** / **Skip** (`/vault later`) |
| Prime tasks with a vault note | off | A pointer to the vault's best note before a task starts |
| Vault revision | on | When a note you add changes what an older note claims, a review chain checks it against the sources and records it on the newer note as a git commit, with **Undo** |
| Vault status band | on | A one-line receipt above the prompt when the vault was consulted |

**Vault revision** needs the vault to be a git repository: every accept is its own commit, and your uncommitted edits are never swept in. `/vault explain` shows how it works in pictures, with this vault's numbers; `/vault revise` has the status, `/vault revise undo last` reverts the latest accept. To keep proposals without any writes, set `"revision": "manual"` in `.wiki/config.json`.

`/vault witness` shows, word for word, everything commonplace added to the model's context that the transcript doesn't show.

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
                          ┌─────────────────┼────────────────┐
                          ▼                 ▼                ▼
                   wiki-linter      wiki-pruner      wiki-moc-updater
                                   (refuses retired
                                    → wiki-supersede)
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
| autoimprove | "improve the vault", "what's the score" | wiki-linter, wiki-pruner, wiki-moc-updater, wiki-compile, wiki-freshness-checker | wiki-lint |
| wiki-compile | "fill the stubs" | (none) | autoimprove; wiki-lint |

Three-tier cost model:
1. **TypeScript scripts** (zero LLM cost) — indexing, validation, linting
2. **Haiku agents** (cheap) — mechanical fixes, wikilink insertion, MOC syncing
3. **Main model** (synthesis) — paper analysis, concept definitions, query answers

## Install

```
/plugin install commonplace --marketplace noopz/stray-bits-sanctuary
```

Then, in any session, point it at your notes: "set up commonplace for ~/Notes" (the wiki-init skill runs `commonplace init` and builds the index).

Needs Claude Code 2.1.288 or later and Node.js 22.18 or later (it runs the TypeScript directly).
