# commonplace

LLM-maintained knowledge base for any folder of notes. Transforms raw sources into interconnected wiki notes.

## Architecture

- **Skills** auto-trigger from conversation (no slash commands needed)
- **TypeScript scripts** handle deterministic work (zero LLM tokens)
- **Haiku agents** handle mechanical fixes (cheap)
- **Main model** handles synthesis only (expensive, used sparingly)

## No RAG — grep finds, reading connects

commonplace is not a RAG system. Never substitute keyword/concept-string matching for an actual relevance judgment — that's exactly the blind spot RAG has: it misses real connections that don't share a literal string, and manufactures false confidence in the ones that happen to match.

**Mental model:** `Grep` against the JSONL indexes is a jumping-off point, not an answer. It tells you which few notes are worth reading. The relevance judgment itself comes from `Read`ing those notes and reasoning about whether they actually connect — not from whether a keyword or concept name matched.

This applies anywhere a "does X relate to Y" decision gets made — cross-domain bridging, deep-linking, pre-ingest triage, wiki-query. A note can be highly relevant to another with zero shared concept names or strings (e.g. an export-control story bearing on an IPO thesis's "Government Contract Dependency" angle without ever naming the company). If a check only compares index fields and stops there, it isn't finished — it must follow the grep hit to the real file and read it before concluding anything.

## Never use Python or shell one-liners to parse JSON

**This is a hard rule.** Never do this:
```bash
cat .wiki/moc-index.jsonl | python3 -c "import json,sys; ..."
cat file.json | python3 -c "import json,sys; data=json.load(sys.stdin); ..."
```

Instead:
- **To search an index**: use `Grep` — e.g. `Grep "pattern" "$VAULT/.wiki/concept-index.jsonl"`
- **To read a file**: use the `Read` tool — never `cat`
- **Script output**: assign to a variable and read it directly — scripts output valid JSON, trust it

If you catch yourself about to pipe to `python3` or `jq`, stop and use Grep or Read instead.

## Scripts

All scripts are invoked via the `commonplace` CLI, which is automatically on PATH when the plugin is active. Just call `commonplace <cmd>` directly — never reconstruct PATH or use `npx tsx` to run scripts manually.

Command hooks (shell subprocesses) don't inherit the Bash tool PATH, so they use `node ${CLAUDE_PLUGIN_ROOT}/bin/commonplace <cmd>` instead. Skills, agents, and normal Bash tool calls should always use the bare `commonplace` command.

All commands auto-discover the vault via cwd (`.obsidian/` or `.wiki/` marker) or `.vault-path` fallback. The `--vault <path>` flag is optional — only needed for `init` or when overriding auto-discovery.

- `commonplace vault-path` — Print the configured vault path (no tsx spawn, instant)
- `commonplace vaults [--match "<phrase>"] [--json]` — List registered vaults, or match one by name (used by wiki-query to resolve "search in <name>")
- `commonplace config` — Print `.wiki/config.json` contents (no tsx spawn, instant)
- `commonplace index [--incremental]` — Build/update `.wiki/*.jsonl` indexes: `source-index`, `concept-index`, `moc-index`, `domain-index`, `backlink-index` (human-readable output by default)
- `commonplace lint [--check <name>] [--json] [--rank-by-traffic]` — Vault health audit (human-readable summary by default, `--json` for machine-parseable; `--rank-by-traffic` sorts stub findings by backlink count, descending). Checks include `unresolved`, `stubs`, `orphans`, `frontmatter`, `moc-staleness`, `scope-violations`, `duplicates`, `malformed-dates`, `filename-h1-mismatch`, `near-duplicate-names`, `malformed-concept-names`, `underlinked`, `cluster-cohesion`, `bridge-thinness`, `weak-summary`, `cross-scope-bridge`, `concept-density-without-source-links`.
- `commonplace validate <file>` — Single file frontmatter validation
- `commonplace scope-check [<file>]` — Domain scope enforcement
- `commonplace score [--json]` — Compute vault quality score (human-readable by default, `--json` for machine-parseable)
- `commonplace prune` — Remove low-value stubs
- `commonplace init --vault <path>` — Initialize plugin for a vault (requires explicit path)
- `commonplace post-write` — Post-write hook pipeline (reads stdin)
- `commonplace raw [--instruct]` — Scan raw/ for uningested files; `--instruct` prints human-readable summary
- `commonplace freshen [--sample <n>] [--min-age-days <n>]` — Sample oldest-unchecked live source URLs for freshness checking
- `commonplace freshen --record` — Record a check result (reads JSON from stdin, merges into `.wiki/freshness.json`)
- `commonplace freshen --clear <relative-path>` — Clear stale flag after re-ingesting a note
- `commonplace deep-link [--mode concepts|notes] [--threshold <n>] [--top <n>] [--note <path>]` — Find implicit concept connections via semantic similarity (requires Ollama + nomic-embed-text)
- `commonplace hub-score [--top <n>] [--json]` — HITS hub/authority scoring over `backlink-index.jsonl`; ranks top hubs and authorities, flags high-hub-low-authority nodes as likely administrative aggregators (MOCs/index pages) vs. genuine topical authorities
- `commonplace eval:retrieval [--gold <path>] [--seed-mode flat] [--answers <dir>] [--history] [--json]` — Deterministic retrieval eval: seed recall over a gold question set (default `$VAULT/.wiki/evals/gold.jsonl`, never committed — the committed fixture set is CI-only), optional answer-transcript citation/groundedness scoring, optional history append to `.wiki/eval-history.jsonl`
- `commonplace abstract [--dry-run] [--json]` — Backfill `abstraction:` frontmatter (deterministic derivation from Summary/definition text) across source + concept notes; on completion sets the vault's `abstractions: true` adoption flag (switches `isStub` to also key on missing abstractions and makes validation require the field). Run `commonplace index` afterwards.
- `commonplace seed --query "<text>" [--mode tiered|flat] [--no-abstraction] [--json]` — Deterministic tiered seed helper for wiki-query: matches query terms against explicit key spaces in order (A `abstraction`, B cue anchors = tags/MOC names/wikilink display texts, C names/titles, D whole-record grep only when A–C yield <3 seeds); prints candidates with tier + matched terms. Seeds are jumping-off points — read the notes before judging relevance.
- `commonplace log --entry "<text>"` — Append an entry to `.wiki/log.md` (use instead of printf/bash redirection)
- `commonplace supersede --scan --old <name> [--new <name>] [--scope <path>] [--json]` — Find + classify prose mentions of a soon-to-be-retired entity (buckets: historical, comparison, already-retired, live, live-in-code, needs-review)
- `commonplace supersede --retire --old <name> --new <name> --reason "..." [--date YYYY-MM-DD] [--dry-run]` — Rename old to "(Retired) <title>", inject warning callout, add `retired` tag, update wikilinks across vault, write breadcrumb to `.wiki/supersessions.jsonl`
- `commonplace supersede --check [--json]` — Punch list: retired notes still mentioned in non-retired siblings + new notes declaring supersession with no breadcrumb
- `commonplace supersede --list [--json]` — Show recorded supersessions

Paper commands:
- `commonplace paper:fetch <url-or-id>` — Download from arXiv/URLs
- `commonplace paper:smart-extract <pdf>` — Adaptive section extraction
- `commonplace paper:detect <pdf>` — Section header detection
- `commonplace paper:extract <pdf> <info|range|overview>` — Page extraction
- `commonplace paper:enrich --arxiv-id <id>` — External metadata
- `commonplace paper:citations <pdf>` — Citation network
- `commonplace paper:figures <pdf>` — Figure/table captions
- `commonplace paper:quality <analysis.md>` — Quality scoring
- `commonplace paper:compare <file1> <file2>` — Cross-paper comparison

## Vault Location

The set of vaults lives in `vaults.json` under `CLAUDE_PLUGIN_DATA` (a registry of `{id, path, label, aliases}` plus a `default`). `commonplace init` appends to it; `.vault-path` is kept as a back-compat mirror of the default vault for instant `bin/commonplace` lookups. Selection precedence is: explicit `--vault <id|path>` → cwd walk-up (`.obsidian/`/`.wiki/`) → registry default. Per-vault `.wiki/` config/indexes are unchanged. The vault's own CLAUDE.md defines the schema and conventions.

## Domain System

Domains are inferred from file paths, never stored in frontmatter. The domain registry lives in the vault's CLAUDE.md between sentinel comments.
