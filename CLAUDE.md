# commonplace

LLM-maintained knowledge base for any folder of notes. Transforms raw sources into interconnected wiki notes.

## Architecture

- **Skills** auto-trigger from conversation (no slash commands needed)
- **TypeScript scripts** handle deterministic work (zero LLM tokens)
- **Haiku agents** handle mechanical fixes (cheap)
- **Main model** handles synthesis only (expensive, used sparingly)

## In-process function hooks (EARLY ACCESS)

`hooks/register.ts` is an in-process plugin module, loaded into a sandboxed
worker only when `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. It runs **beside** the
shell hooks in `hooks/hooks.json`, not instead of them — without the flag the
file is inert and the shell hooks are the whole plugin. Both wirings live in the
same `hooks.json` (`modules` alongside `hooks`), so a broken module degrades to
current behaviour rather than to nothing.

It registers ten hooks. **`ui.render{component=AbovePrompt}`** draws a one-line
status band above the prompt: a dim heartbeat (`⟡ vault · N sources · N concepts
· N surfaced · last: <outcome>`) when healthy, and a yellow warning when the
circuit breaker has stopped surfacing.
The breaker is deliberately silent in the transcript, so this band is the only
place a failure becomes visible — do not remove it without replacing it.

The band is a **receipt, not a dashboard**: `turn.complete` raises it only when
the vault was actually consulted, and **`prompt.submit`** lowers it as soon as
the user types again. A line that persists across turns becomes furniture and
stops being read. A paused breaker therefore re-announces itself every turn
rather than noting once.

**`turn.complete` ambient connection surfacing**.
At the end of a turn it seeds lexically against the JSONL indexes, and — only if
a candidate survives — reads the note and asks a model whether the connection is
real, rendering at most one line beneath the answer. This replaces asking the
model, in prompt text, to remember to look for connections.

The hook itself is a thin adapter: all of the decision logic lives in
`hooks/lib/pipeline.ts` behind a `Ports` interface, so the guard order, circuit
breaker, rate limit and index cache are covered by tests against recording fakes
instead of only being observable in a live session. **Change the logic in
`lib/`, not in the hook body** — and note that `$` may appear inside an arrow
function's body, which is what makes the Ports object legal under the scanner.

**Two enforcement hooks turn CLAUDE.md rules into mechanisms.**
`tool.call{tool: "Bash"}` denies parsing `.wiki/*.jsonl` with `python3`/`jq`/
`node -e` and denies manual `npx tsx scripts/*`, naming the right
`commonplace <cmd>` in the deny reason. A second `tool.call` refuses to write
private-domain vault titles into a code repository. Both fail open — a thrown
guard never blocks a tool call — and both are **global**, so a false positive
blocks unrelated work in any repo. Treat widening their match patterns as a
high-risk change and see `hooks/lib/guard.ts` for the documented failure modes.

Only **one matcher-less hook per event** is permitted; a second is a validation
error naming both lines. The private-leak guard and the vault-tool handler share
one `tool.call` registration for that reason. They need not: matchers accept a
one-of array and a RegExp (`{ tool: ["Write","Edit"] }`, `{ tool: /^mcp__.*__vault_/ }`),
so this could be split into two hooks whenever it earns the change.

**Unwrap tool results explicitly.** `$.tool.call({tool: "Read"})` answers
`{result: {file: {content, ...}}}` (note the `file` level) and Bash answers
`{result: {stdout}}`. Getting this wrong fails silently: the optional chain
yields `undefined`, coerces to `""`, and the feature simply never finds anything.

Hard constraints of this API, verified rather than assumed:

- **No Node in the module.** It may import only its own files by relative path
  and the types-only `claude-code` module. `scripts/lib/*` cannot be imported —
  do not try to port them.
- **`$.fs` is confined to the session project**; the vault is normally outside
  it. Reach vault files with **`$.process.run`** — a direct host exec, no shell:
  `cat` on a 149KB index is ~2ms and `commonplace vault-path` ~46ms.
- **Do NOT use `$.tool.call({tool: "Read"})` for indexes.** It caps a result
  near **48KB** — measured: 114 of 347 concept records — and the truncation is
  silent, so seeding ran against a third of the vault for several versions. The
  old "never shell out, it costs 7.3s" rule measured Bash-TOOL overhead, not the
  CLI, and no longer applies.
- **`Grep` and `Glob` are not available to hooks** ("no tool named Grep in this
  session", verified). If an index ever outgrows a per-turn parse, the answer is
  `$.process.run(["grep", ...])`.
- **The scanner refuses `$` and `on` used as anything but direct calls** — no
  binding, spreading, storing or returning. It MAY be passed to a function
  declared in the same file (validate reports `$.session.cwd (via f)` and
  follows it two hops), but never across an import: "followed only into a
  function declared in this same file". So `hooks/lib/*` still takes plain
  values or a Ports object of arrows, while `register.ts` may factor its own
  helpers normally.
- `claude plugin validate <dir>` checks all of the above without running it, and
  prints the module's exact capability surface. Run it after every edit.
- **`turn.complete` and `ui.render` do not fire under `claude -p`** (no terminal
  surface — `$.session.surface()` answers `null` there). Both fire normally in an
  interactive session: verified as `turn.complete settled in 25.1ms` in a
  `--debug-file` log. `tool.call` hooks fire under `-p` too, which is why the
  enforcement guards can be tested non-interactively and the connection pass
  cannot — another reason its logic sits behind `Ports` in `lib/`.
- **Diagnose with `claude --plugin-dir . --debug-file <path>`.** It logs every
  hook that loads, fires, and how long it settled, and says why a render tree
  failed validation. It is the only way to see any of that.
- **A module reload does not re-fire `session.start`.** Module scope is
  re-instantiated, so anything cached there is silently empty mid-session. Cache
  lazily, never only eagerly.

Full API notes, the probe method, and the migration checklist for when this API
is officially documented live in the vault at
`06 - Handbook/Building on Claude Code Function Hooks`.

## Parallel agents over vault content

Two mechanisms, depending on whether the in-process module is loaded.

**With the module (`agent.spawn`)**: a general-purpose dispatch that a classify
judges to be vault **research** has its prompt REWRITTEN, not refused — it gains
instructions to use `vault_search`/`vault_note` and the doctrine that a pointer
is not a finding. Nothing is blocked, so nothing needs an escape hatch.
Orchestrated **work** (`vault-work`) and unrelated dispatches pass untouched, and
telling those apart is the thing a regex could not do. Forks and named agents
(`commonplace:*`, `code-reviewer`, `Explore`) are never steered.

**Without it (`agent-guard`, the shell PreToolUse hook)**: the older behaviour —
a vault-research dispatch is DENIED and redirected to wiki-query. Because a
regex cannot separate research from work, orchestrated work must carry the
marker `ALLOW_VAULT_AGENT` in each dispatch prompt to bypass it. If a dispatch
is blocked, don't fall back to doing the whole job inline — pick the right path:
wiki-query for a lookup, the marker for orchestrated work.

## No RAG — grep finds, reading connects

commonplace is not a RAG system. Never substitute keyword/concept-string matching for an actual relevance judgment — that's exactly the blind spot RAG has: it misses real connections that don't share a literal string, and manufactures false confidence in the ones that happen to match.

**Mental model:** `Grep` against the JSONL indexes is a jumping-off point, not an answer. It tells you which few notes are worth reading. The relevance judgment itself comes from `Read`ing those notes and reasoning about whether they actually connect — not from whether a keyword or concept name matched.

This applies anywhere a "does X relate to Y" decision gets made — cross-domain bridging, deep-linking, pre-ingest triage, wiki-query. A note can be highly relevant to another with zero shared concept names or strings (e.g. an export-control story bearing on an IPO thesis's "Government Contract Dependency" angle without ever naming the company). If a check only compares index fields and stops there, it isn't finished — it must follow the grep hit to the real file and read it before concluding anything. Seeding itself is tiered-lexical (`commonplace seed`): abstraction → cue anchors → names/titles → whole-record grep as a gated fallback. Better jumping-off points, same rule — the tier tells you where to start reading, never whether something is relevant.

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

## Test fixtures must be invented — never based on a live vault

**This is a hard rule. This repo is public.** Test creation should always make up its own framing and never be based on a live vault. When you write or update a test — for the linker, indexer, lint, seed, connect, anything — invent the note names, concept names, domains, titles, and body text. Never copy a real note title, concept name, domain slug, or any other content out of a vault you inspected while diagnosing the bug, even when the bug report itself named them. Real vault content in a committed test leaks private data into a public repo. Use obviously-fake placeholders (`Alpha Method`, `Gamma Term`, `Acme Report`, domains `alpha`/`gamma`) that exercise the same code path without carrying any real content.

## Scripts

All scripts are invoked via the `commonplace` CLI, which is automatically on PATH when the plugin is active. Just call `commonplace <cmd>` directly — never reconstruct PATH or use `npx tsx` to run scripts manually.

Command hooks (shell subprocesses) don't inherit the Bash tool PATH, so they use `node ${CLAUDE_PLUGIN_ROOT}/bin/commonplace <cmd>` instead. Skills, agents, and normal Bash tool calls should always use the bare `commonplace` command.

All commands auto-discover the vault via cwd (`.obsidian/` or `.wiki/` marker) or `.vault-path` fallback. The `--vault <path>` flag is optional — only needed for `init` or when overriding auto-discovery.

- `commonplace vault-path` — Print the configured vault path (no tsx spawn, instant). "Instant" is the script itself; reaching it from an in-process hook via `$.tool.call({tool:"Bash"})` measured **7.3s** of tool + shell overhead, which is why the hooks cache the resolved path rather than re-asking.
- `commonplace vaults [--match "<phrase>"] [--json]` — List registered vaults, or match one by name (used by wiki-query to resolve "search in <name>")
- `commonplace config` — Print `.wiki/config.json` contents (no tsx spawn, instant)
- `commonplace index [--incremental]` — Build/update `.wiki/*.jsonl` indexes: `source-index`, `concept-index`, `moc-index`, `domain-index`, `backlink-index` (human-readable output by default)
- `commonplace lint [--check <name>] [--json] [--rank-by-traffic]` — Vault health audit (human-readable summary by default, `--json` for machine-parseable; `--rank-by-traffic` sorts stub findings by backlink count, descending). Checks include `unresolved`, `stubs`, `orphans`, `frontmatter`, `moc-staleness`, `moc-size`, `scope-violations`, `duplicates`, `malformed-dates`, `filename-h1-mismatch`, `near-duplicate-names`, `near-duplicate-content`, `malformed-concept-names`, `underlinked`, `cluster-cohesion`, `bridge-thinness`, `weak-summary`, `cross-scope-bridge`, `concept-density-without-source-links`.
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
- `commonplace eval:retrieval [--gold <path>] [--seed-mode flat|tiered] [--no-abstraction] [--no-authority] [--answers <dir>] [--history] [--json]` — Deterministic retrieval eval: seed recall over a gold question set (default `$VAULT/.wiki/evals/gold.jsonl`, never committed — the committed fixture set is CI-only), optional answer-transcript citation/groundedness scoring, optional history append to `.wiki/eval-history.jsonl`. Reports seed recall and mean reciprocal rank (position-sensitive, for ranking ablations).
- `commonplace abstract [--dry-run] [--json]` — Backfill `abstraction:` frontmatter (deterministic derivation from Summary/definition text) across source + concept notes; on completion sets the vault's `abstractions: true` adoption flag (switches `isStub` to also key on missing abstractions and makes validation require the field). Run `commonplace index` afterwards.
- `commonplace seed --query "<text>" [--mode tiered|flat] [--no-abstraction] [--no-authority] [--json]` — Deterministic tiered seed helper for wiki-query: matches query terms against explicit key spaces in order (A `abstraction`, B cue anchors = tags/MOC names/wikilink display texts, C names/titles, D whole-record grep only when A–C yield <3 seeds); prints candidates with tier + matched terms. Seeds are jumping-off points — read the notes before judging relevance. Tiered hits are ordered by HITS authority within each tier (`--no-authority` disables the ordering).
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
