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

All scripts are invoked via the `commonplace` CLI, which is automatically on PATH when the plugin is active. Just call `commonplace <cmd>` directly — never reconstruct PATH or use `npx tsx` to run scripts manually.

Command hooks (shell subprocesses) don't inherit the Bash tool PATH, so they use `node ${CLAUDE_PLUGIN_ROOT}/bin/commonplace <cmd>` instead. Skills, agents, and normal Bash tool calls should always use the bare `commonplace` command.

All commands auto-discover the vault via cwd (`.obsidian/` or `.wiki/` marker) or `.vault-path` fallback. The `--vault <path>` flag is optional — only needed for `init` or when overriding auto-discovery.

- `commonplace vault-path` — Print the configured vault path (no tsx spawn, instant)
- `commonplace config` — Print `.wiki/config.json` contents (no tsx spawn, instant)
- `commonplace index [--incremental]` — Build/update `.wiki/*.json` indexes
- `commonplace lint [--check <name>]` — Vault health audit
- `commonplace validate <file>` — Single file frontmatter validation
- `commonplace scope-check [<file>]` — Domain scope enforcement
- `commonplace score` — Compute vault quality score
- `commonplace prune` — Remove low-value stubs
- `commonplace init --vault <path>` — Initialize plugin for a vault (requires explicit path)
- `commonplace post-write` — Post-write hook pipeline (reads stdin)
- `commonplace raw [--instruct]` — Scan raw/ for uningested files; `--instruct` prints human-readable summary
- `commonplace freshen [--sample <n>] [--min-age-days <n>]` — Sample oldest-unchecked live source URLs for freshness checking
- `commonplace freshen --record` — Record a check result (reads JSON from stdin, merges into `.wiki/freshness.json`)
- `commonplace freshen --clear <relative-path>` — Clear stale flag after re-ingesting a note
- `commonplace log --entry "<text>"` — Append an entry to `.wiki/log.md` (use instead of printf/bash redirection)

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

The active vault is auto-discovered from `CLAUDE_PLUGIN_DATA/.vault-path` (written by `commonplace init`, survives plugin updates), falling back to cwd discovery (`.obsidian/` or `.wiki/` marker). Use `commonplace vault-path` to retrieve it. The vault's own CLAUDE.md defines the schema and conventions.

## Domain System

Domains are inferred from file paths, never stored in frontmatter. The domain registry lives in the vault's CLAUDE.md between sentinel comments.
