# commonplace

LLM-maintained knowledge base for any folder of notes. Transforms raw sources into interconnected wiki notes.

## Architecture

- **Skills** auto-trigger from conversation (no slash commands needed)
- **TypeScript scripts** handle deterministic work (zero LLM tokens)
- **Haiku agents** handle mechanical fixes (cheap)
- **Main model** handles synthesis only (expensive, used sparingly)

## Never use Python or shell one-liners to parse JSON

**This is a hard rule.** Never do this:
```bash
cat .wiki/moc-index.json | python3 -c "import json,sys; ..."
cat file.json | python3 -c "import json,sys; data=json.load(sys.stdin); ..."
```

Instead:
- **To search an index**: use `Grep` — e.g. `Grep "pattern" "$VAULT/.wiki/concept-index.json"`
- **To read a file**: use the `Read` tool — never `cat`
- **Script output**: assign to a variable and read it directly — scripts output valid JSON, trust it

If you catch yourself about to pipe to `python3` or `jq`, stop and use Grep or Read instead.

## Scripts

All scripts are invoked via the `commonplace` CLI, which is on PATH when the plugin is active. They output JSON to stdout — read that output directly. Never pipe through Python or shell one-liners.

For hooks and agents where PATH may not include the plugin bin, use `node ${CLAUDE_PLUGIN_ROOT}/bin/commonplace <cmd>`.

- `commonplace index --vault <path> [--incremental]` — Build/update `.wiki/*.json` indexes
- `commonplace lint --vault <path> [--check <name>]` — Vault health audit
- `commonplace validate --vault <path> <file>` — Single file frontmatter validation
- `commonplace scope-check --vault <path> [<file>]` — Domain scope enforcement
- `commonplace score --vault <path>` — Compute vault quality score
- `commonplace prune --vault <path>` — Remove low-value stubs
- `commonplace init --vault <path>` — Initialize plugin for a vault
- `commonplace post-write` — Post-write hook pipeline (reads stdin)
- `commonplace raw --vault <path> [--instruct]` — Scan raw/ for uningested files; `--instruct` prints human-readable summary
- `commonplace freshen --vault <path> [--sample <n>] [--min-age-days <n>]` — Sample oldest-unchecked live source URLs for freshness checking
- `commonplace freshen --vault <path> --record` — Record a check result (reads JSON from stdin, merges into `.wiki/freshness.json`)
- `commonplace freshen --vault <path> --clear <relative-path>` — Clear stale flag after re-ingesting a note
- `commonplace log --vault <path> --entry "<text>"` — Append an entry to `.wiki/log.md` (use instead of printf/bash redirection)

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

The active vault is auto-discovered from cwd (`.obsidian/` marker) or configured via `npx tsx scripts/init.ts`, which stores the resolved path in `.vault-path` at the plugin root. The vault's own CLAUDE.md defines the schema and conventions.

## Domain System

Domains are inferred from file paths, never stored in frontmatter. The domain registry lives in the vault's CLAUDE.md between sentinel comments.
