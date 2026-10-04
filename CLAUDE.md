# commonplace

LLM-maintained knowledge base for any folder of notes. Transforms raw sources into interconnected wiki notes.

## Architecture

- **Skills** auto-trigger from conversation (no slash commands needed)
- **TypeScript scripts** handle deterministic work (zero LLM tokens)
- **Haiku agents** handle mechanical fixes (cheap)
- **Main model** handles synthesis only (expensive, used sparingly)

## The module is the plugin

`hooks/register.tsx` is an in-process plugin module (Claude Code mods,
2.1.288+). As of v2 it is the **whole** runtime plugin: the guards, the context
block, the vault tools, post-write, the band and the connection pass all live
there. `hooks/hooks.json` keeps exactly one shell hook, `SessionStart` →
`commonplace session-check`, which does three things a module cannot:

- rebuilds `dist/` (the esbuild bundle) when a source is newer than its stamp;
- runs cache cleanup;
- **watchdog**: it increments `<plugin>/.runtime/shell-sessions`; the module's
  `session.start` resets it to 0 and writes `.runtime/module-alive.json`. Two
  sessions in a row without the module (modules disabled by settings or policy)
  print a systemMessage, because otherwise the plugin silently does nothing.

The module gates itself on `$.session.version().base >= MIN_BUILD` (2.1.288);
an older engine gets a toast, `tooOld: true` in `module-alive.json`, and no
registrations. There is no shell fallback to keep in step any more, so the v1
`hooks-module.json` marker and `module-gate` are gone.

`plugin.json` declares three `userConfig` fields: `ambientConnections` (the
connection pass, default on), `primeContext` (prime, default **off** until
`eval:prime` passes its gate on the user's vault) and `showBand` (the status
band; a paused breaker still shows when off). Everything else the module does
is either a guard (which must not be optional) or free. Declaring userConfig is
also what silences the host's "options requested but its manifest declares no
userConfig" warning.

### What the module holds

- **The graph index** (`hooks/lib/index/*`, `hooks/lib/graph/*`). `commonplace
  index` is the single artefact writer (mkdir lock, atomic renames, manifest
  last). The module loads `.wiki/graph/` lazily per vault (`VaultIndex`),
  overlays its own patches, and re-checks the manifest version at most every
  5 s. After a vault Write/Edit it parses the file in-module, patches the view
  and appends ONE line to `.wiki/graph/journal.jsonl` (~1–3 ms), then runs
  `commonplace post-write --no-index` for analysis and debounces a CLI rebuild.
  A 60 s sweep (`find -newer manifest`) patches notes changed outside Claude;
  sealed changes, bursts over 200 files and due compactions go to the CLI.
- **Layout.** `.wiki/graph/` is public only: `manifest.json`, `main.csr.json`
  (packed CSR + sentinel ids), `names.json`, `scores.json`,
  `main.postings.jsonl`, `files.jsonl`, `cards/`, `linkctx/`, `journal.jsonl`,
  `records.jsonl`. `.wiki/sealed/` holds everything private: per-shard
  `shard.json`/journal/`records.jsonl`, `names.json` (the leak guard's input),
  `sentinels.json`, `overrides.json`. **Records** are the CLI tools' per-note
  facts (v1's five `*-index.jsonl` files, which v2 no longer writes), one typed
  line per record (`{"k":"source",…}`, hooks/lib/index/records.ts). Readers go
  through `scripts/lib/vault.ts readLegacyIndex`, which merges a sealed shard's
  records only when it is named in `COMMONPLACE_OPEN`; agents and skills use
  `commonplace records --kind …`. A vault not yet rebuilt by v2 still has v1
  files, and the loader reads those instead.
  Ids are stable across rebuilds and never reused; a public→private edge points
  at an opaque per-shard sentinel that walks absorb.
- **Scope.** Links are one-way: private notes may link to public ones, never
  the reverse. A note's scope comes from where it lives (plus a note-level
  `scope: private`), never from who links to it. A private shard (its
  `linkGroup`, else the domain id; note-level privates → `loose`; folders that
  appear after the first v2 index → `quarantine`) is **sealed** unless opened
  by one of exactly two signals: the session starting inside its folder (or in its link group's own folder, when every domain there is in the group), or the
  person typing `/vault open <domain>`. Scope truth lives in module memory only
  (`$.state.commonplace.scope` is a display mirror); `/clear`, a reload and a
  new session re-seal. A typed prompt naming a sealed domain gets a band
  *proposal*, never an unseal. The model cannot widen scope: the Bash guard
  denies `COMMONPLACE_OPEN=` and `commonplace … --open`, and injects the
  session's open shards into `commonplace` commands itself.
- **The vault tools** (`hooks/lib/tools/*`, served by one regex `tool.call`
  hook): `vault_search`, `vault_note` (pinned), `vault_links`, `vault_path`,
  `vault_neighbourhood`, `vault_list`, `vault_skill` (deferred). `vault_search`
  pages (`offset`; the reply says when more exist). No numeric
  score ever reaches the model. Sealed titles in returned text are masked to
  `[[…]]`. Each has a CLI twin on the same code: `commonplace search|note|
  links|path|neighbourhood`.
- **`$.commonplace`** — a noun other plugins can call (`engine.create` adds the
  stubs; `on("commonplace.<method>")` hooks answer). The contract is
  `types/index.d.ts`. Internal callers use the `impl_*`/`noun.*` functions
  directly so a foreign hook on our noun never sits between the model and our
  data.
- **Vault skills** — the vault's own Claude Code skills: `<vault>/.claude/skills/`
  and `<folder>/.claude/skills/` anywhere inside it (`.claude/worktrees` is
  skipped). A session started in the vault gets them from Claude Code itself;
  any other session gets them through the static `vault-skill` skill (its text
  is swapped in `skill.prompt`; `$.prompt.submit` is refused inside
  `command.run`) and `vault_skill`. Outside the vault a skill runs only once the
  person has trusted its exact content: discovered at session start, or first
  called, it raises a `$.ui.ask` dialog (Trust / Not now / Never ask), pinned by
  SHA-256 so any edit — including Claude's — asks again. `/vault skills trust`
  does the same by hand. A nested skills folder holding or inside a private
  domain is offered only while that domain is open (`skillGateShards`).
- **`/vault`** — `status · list · use · open · close · reindex · skills ·
  domain`, answered by `command.run`.
- **Prime** (`hooks/lib/core/prime.ts`, off by default): the sync lane in
  `prompt.submit` picks at most one strong, clearly-leading postings hit per
  segment with no model call; the async lane judges it with haiku and appends
  `<commonplace-prime unverified="true">` mid-turn via `$.session.append`, or
  drops it if the turn already ended. ≤1 vault touch per segment across prime
  and the ambient pass.

### The band and other surfaces

**`ui.render{component=AbovePrompt}`** draws one line: a receipt of what the
vault just did (`⟡ vault · following links …`, `primed`, `reindexed N notes`),
the heartbeat, a magenta `🔒 vault · open: …` while a private domain is open,
a one-turn proposal, or the yellow breaker warning. The breaker is
deliberately silent in the transcript, so this band is the only place a
failure becomes visible — do not remove it without replacing it. Band TEXT
lives in module memory (it can name an open private note); `$.state` carries
only the kind.

The band is a **receipt, not a dashboard**: it is raised only when the vault
was actually consulted, and **`prompt.submit`** lowers it as soon as the user
types again — except the `open` band and a paused breaker, which re-announce
every turn while they are true. Also: a `ToolUse` row for vault tools
(`⟡ vault_links [[X]] · 13 links · 6 ms`), the Spinner message "Reading the
vault" while one runs, toasts, and `$.ui.status("⟡ <vault>")` only when more
than one vault is registered.

**`turn.complete` ambient connection surfacing**.
At the end of a turn a cheap classify decides whether the answer is technical
substance at all; if it is, the pass seeds lexically against the JSONL indexes
and, **when that free tier's best hit is weak**, asks for a PPR pool over the
content graph — answered in-module by `connectPool` over the loaded view (so it
sees exactly the session's scope, in ~2 ms), with the `commonplace connect` CLI
as the fallback while no index is loaded. Either way it then reads the candidate note
and asks a model whether the connection is real, rendering at most one line
beneath the answer. This replaces asking the model, in prompt text, to remember
to look for connections.

The rate limit is **signal-aware**: the free lexical seed runs before it, so an
exceptionally strong hit (`PREEMPT_SCORE`) may preempt down to two turns while
an ordinary turn still waits four. Gating on arrival order alone was measurably
wrong — a throwaway question spent the budget and the one turn that session the
vault genuinely covered was skipped without the pass ever looking at it.

The graph tier is what lets the pass reach a note sharing **no literal string**
with the answer — the case the "No RAG" section names and lexical seeding
structurally cannot serve. It buys recall, not precision: `connect` always
returns k candidates with no "no opinion" signal, so the judge (not a score
threshold) remains the relevance authority, and the rate limit bounds how often
it is asked. The walk is gated on lexical STRENGTH, not on the lexical tier
being empty — gated on emptiness it was dead code, because on a few-hundred-
record vault `rankCandidates` returns its full four candidates for any answer
at all (a sourdough-fermentation answer scored 7 against notes about AI agent
tooling). That threshold decides whether to widen the search, never whether a
note is relevant, which is the distinction the "No RAG" rule actually draws. `connect` output carries no scope filter and includes MOC paths the
pass never indexes, so `mergeSeeds` is **fail-closed** — a path with no
surfaceable index record behind it is dropped rather than surfaced.

The hook itself is a thin adapter: all of the decision logic lives in
`hooks/lib/pipeline.ts` behind a `Ports` interface, so the guard order, circuit
breaker, rate limit and index cache are covered by tests against recording fakes
instead of only being observable in a live session. **Change the logic in
`lib/`, not in the hook body** — and note that `$` may appear inside an arrow
function's body, which is what makes the Ports object legal under the scanner.

Every guard and every pass appends a line to **`<vault>/.wiki/hook-log.jsonl`**
— the only durable record of what the module decided, since `turn.complete`
writes nothing to the transcript and the status band is gone the moment the user
types. Trace both branches of any decision you add: a pass that logs only when a
tier RUNS reads identically to the code that never had the tier, which is how
v1.61.0 shipped unverifiable. `session.start` trims the file to the last 2000
lines (`tail` then `tee`, two execs — `$.process.run` runs no shell, so there is
no pipe and no `>`).

**Enforcement hooks turn CLAUDE.md rules into mechanisms.**
`tool.call{tool: "Bash"}` denies parsing `.wiki/*.json(l)` with `python3`/`jq`/
`node -e`, denies manual `npx tsx scripts/*` (naming the right
`commonplace <cmd>`), and denies scope escalation. The guard hook on the
built-in file tools denies any path into a sealed folder or `.wiki/sealed`, a
recursive scan rooted above one, and model writes into `.wiki/skills|agents`;
it refuses private titles (and every title of an `isPrivate` vault) written
into a code repo or another vault, and strips remote embeds from source notes
on the way down. Both fail open — a thrown
guard never blocks a tool call — and both are **global**, so a false positive
blocks unrelated work in any repo. Treat widening their match patterns as a
high-risk change and see `hooks/lib/guard.ts` for the documented failure modes.

Only **one matcher-less hook per event** is permitted; a second is a validation
error naming both lines. Matchers accept a one-of array and a RegExp
(`{ tool: ["Write","Edit"] }`, `{ tool: /^mcp__commonplace__vault_/ }`), which
is how the guard, post-write and vault-tool hooks stay separate.

**Unwrap tool results explicitly.** `$.tool.call({tool: "Read"})` answers
`{result: {file: {content, ...}}}` (note the `file` level) and Bash answers
`{result: {stdout}}`. Getting this wrong fails silently: the optional chain
yields `undefined`, coerces to `""`, and the feature simply never finds anything.

Hard constraints of this API, verified rather than assumed:

- **No Node in the module.** It may import only its own files by relative path
  and the types-only `claude-code` module. `scripts/lib/*` cannot be imported;
  shared logic lives in `hooks/lib/` and the CLI imports IN from there.
- **`$.fs.read` works on absolute paths** (probe P1; 4 MiB cap, no rename,
  delete or append) and is faster than `cat`. Appends use `$.process.run(["tee",
  "-a", …])` — a direct host exec, no shell.
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
  values or a Ports object of arrows, while `register.tsx` may factor its own
  helpers normally.
- `claude plugin validate <dir>` checks all of the above without running it, and
  prints the module's exact capability surface. Run it after every edit.
- **`turn.complete` DOES fire under `claude -p`.** This section said the
  opposite for several versions, on the reasoning that `-p` has no terminal
  surface. `ui.render` genuinely does not fire there, and conflating the two
  cost a lot of guessing. A `-p` run is now the fastest way to exercise the
  whole connection pass: each one is a fresh session, so the rate limit rebinds
  and every run gets a pass. Watch `<vault>/.wiki/hook-log.jsonl`. `tool.call`
  hooks fire under `-p` too, so every hook here except `ui.render` is testable
  non-interactively.
- **Diagnose with `claude --plugin-dir . --debug-file <path>`.** It logs every
  hook that loads, fires, and how long it settled, and says why a render tree
  failed validation. It is the only way to see any of that.
- **A reload is a fresh load (2.1.288):** `register` runs again and
  `session.start` fires again; `$.state` and `$.store` survive, module memory
  does not — which is why a reload re-seals every private domain. A `/clear`
  does NOT re-run `session.start` and module memory survives it, so
  `session.end{reason:"clear"}` re-seals explicitly. Cache lazily as well as
  eagerly.

**`hook-log.jsonl` stage vocabulary** (beyond the connection pass's own):
`tool:vault_*`, `index:patch|sweep|build|built`, `guard:*`, `scope:proposed`,
`skill:delivered`, `prime:sync|skip-cold|appended|judged-no|unanswered|late-drop|no-turn|error`,
`skip:segment-budget`. A private note's path is never logged.

**Measure it with `commonplace eval:connection`.** It drives real `claude -p`
sessions and scores the trace log, because the pass is a chain of guards, a
rate limit, a classify, a subprocess and a judge that only a live session
exercises. The gold set lives at `$VAULT/.wiki/evals/connection-gold.jsonl` and
is **never committed** — its cases name real notes (`--init` scaffolds one).
Read the miss histogram first: a miss at `no-candidates`, `rate-limited`,
`off-topic` and `judged-not-relevant` are four different bugs. Then read
**pool recall against recall** — the pass judges only the top candidate, so the
gap between "a gold note was in the pool" and "a gold note surfaced" is the
whole loss downstream of retrieval, and without it two runs can score
identically for opposite reasons (they did).

**`commonplace eval:judge` isolates the judge.** `eval:connection` measures the
whole chain, which is right for the feature and wrong for diagnosing it — two
runs of it scored 5/8 for opposite reasons (right notes dropped by the judge vs
wrong notes correctly skipped), and no end-to-end number can separate those.
`eval:judge` fixes the inputs: stored (answer, note) pairs, no seeding, no walk,
no session. `eval:connection` writes the answers it generates to
`$VAULT/.wiki/evals/answers/`, so it is the corpus this one consumes.

It **imports `JUDGE_SYSTEM` and `parseVerdict` from `hooks/lib/`** rather than
copying them. The sandbox forbids importing OUT of the module; nothing stops a
plain Node script importing IN. A copied prompt would drift silently, and in
the direction that flatters the eval. `--repeat N` scores self-agreement, and
`confidentlyWrong` counts cases the judge got wrong unanimously — because
reliability and correctness are different things, and a judge can have plenty
of the first with none of the second.

**`commonplace eval:prime` is prime's gate** (precision ≥ 80%, false-prime
≤ 5% over ≥ 40 distinct `none` cases, recall ≥ 30% or "inert", skip-cold < 5%,
p95 sync < 30 ms, late-drop < 10%). Frequency is reported, not gated: on a
gold set it only reflects the share of `prime` cases; interruption on prompts
with no matching note is the false-prime rate, and real frequency is read from
`hook-log.jsonl` (`prime:appended` per `prime:sync`). Gold at
`$VAULT/.wiki/evals/prime-gold.jsonl`, never committed. Below the gate,
`primeContext` stays off. `eval:judge --prime` isolates the prime judge and
`--used` scores used-in-answer on stored answers.

**`commonplace eval:search` measures what the model actually calls.**
`eval:retrieval` and `eval:connect` drive the v1 CLI seed/connect code;
this one scores `vault_search` (postings) on `gold.jsonl` and the in-module
Connect pool on `connect-gold.jsonl`, rebuilding the index IN MEMORY from the
vault (read-only, `scripts/lib/index-notes.ts`) so build-time knobs can vary.
Postings have two kinds of knob: `TERMS` (stemming, phrase keys, field
weights) is baked into the artefact, so the manifest records `termSig(TERMS)`
and a mismatch loads as absent and rebuilds (`--incremental` too); `RANK`
(BM25 saturation `k1`, coverage exponent, phrase weight, and authority —
`local` reranks the top 25 by in-links from the other hits, query-dependent;
the global HITS prior from `scores.json` is off, because on broad tied queries
it let the vault's most-cited notes win regardless of topic) is query-time.
`--tune` runs coordinate ascent over both plus Connect's `seedK`/`restart`/
`docSeed`/`lambda`, with a 2-fold held-out check — with ~50 gold questions
the folds disagree on exact values, so pick defaults that win on BOTH folds,
not the full-set optimum. `--cfg '<json>'` scores overrides, `--show "<q>"`
prints top hits. Prime ranks with `RANK_LINEAR` because its absolute
thresholds were pinned on the old scale; re-pin them with `eval:prime` before
moving it. Measured and rejected so far: phrase keys (no gain) and
HippoRAG-style down-weighting of source seeds (`docSeed` < 1 lowered Connect
MRR — sources are the targets here and many concepts are stubs).
**`cues:`** (Doc2Query--) are a postings field: `commonplace cues` drafts them
with haiku into `$VAULT/.wiki/evals/cues-draft.jsonl` (kept only if each cue
ranks its own note top-3 with every cue indexed), `eval:search --cues <draft>`
measures the draft in memory, and only `cues --write` touches notes. Measured
and NOT written on the reference vault: one real rescue in 30 Find questions,
the rest first-page reshuffles, and a Connect regression — so cues stay
dormant until a larger paraphrase gold set and a rephrase-once eval say
otherwise (then: wiki-ingest writes them for new notes, not a bulk backfill).

**Note age is shown, never decayed.** Every card carries two clocks —
`published` (`published:`, else `date:`: when the knowledge was produced) and
`added` (`created:`: when it entered the vault) — and a status read from
incoming `supersedes:` / `contests:` frontmatter links on NEWER notes. Search
pointers and `vault_note` print them (`published 2019-03 · added 2026-01-05`,
`⚠ superseded by [[X]]`); ranking ignores all three. The research says why:
time since publication predicts badly both ways (late-recognised papers are a
continuous spectrum, Ke et al. 2015), a global recency boost overwhelms
relevance, and overtaken knowledge should be invalidated and labelled, not
decayed or evicted (Zep's bi-temporal edges; eviction lost recall over 9 weeks).
The impact checker PROPOSES `supersedes`/`contests` at ingest and the person
confirms; `wiki-supersede` stays for entities the user switched away from.
`commonplace dates` backfills `published:` from labelled source lines only.
Not built yet, and only behind a time-aware gold set: CiteRank over the vault
graph (PageRank with recency-biased restarts, so an old note stays "current"
exactly while new notes keep citing it) as a displayed signal or tiebreak.
`layout.ts SCHEMA` bumps force one rebuild when cards or edge kinds change shape. Cards carry no path — the title is the filename stem, so readers take the path from the view (`relOfId`) — and the abstraction is never clipped to fit the card budget: tags go first, then neighbours, and a very long title just makes a longer line.

**`commonplace eval:scale`** times rebuild, patch, sweep, journal replay and
the tool p50s on synthetic 1×/10×/50× vaults (invented text only). Cards and
link contexts are chunked small (128 / 64 ids per file) because a tool call's
lookups scatter across ids and each one parses its whole chunk: at 2000 / 500
the 50× `vault_links` / `vault_neighbourhood` p50s were 13 / 17 ms, at the
current sizes 1 / 3 ms. The manifest records the sizes it was cut at
(`chunks.cardsPer`, `chunks.linkctxPer`) and the loader treats a mismatch as
absent, so changing either constant forces a rebuild instead of misreading.

**`commonplace test:ui`** runs `ui-tests/*.test.tsx` under `claude plugin
test` on terminal and desktop: the band, the vault tool's transcript row, the
spinner text, and `/vault open`, each driven through a real vault tool call
against an invented vault served from memory (`ui-tests/fixture.tsx` answers
`process.run`, `fs.read`, `fs.stat` beneath the plugin). The kit runs every
`*.test.ts(x)` under the folder it is given, and the node:test suites cannot
load in its sandbox, so the runner stages the module (manifest, `hooks/`
minus node tests, `types/`) with only the UI tests beside it. Op hooks a test
answers return `{ value }`; anything the module calls that the test does not
answer throws, which the module's own try/catch then swallows — so when a UI
test fails, read the kit's "the engine reported" lines first.

**Precision and recall are reported apart on purpose.** An ambient feature that
interrupts must protect precision first, because low precision is alert fatigue
and alert fatigue kills the feature; recall can be raised afterwards. A single
"N/M correct" hides which one moved. And the eval is NOISY — the pass runs on
the model's answer, which varies per run — so compare a change across repeated
runs, and treat a stable number as reliable, not as correct.

Full API notes, the probe method, and the migration checklist for when this API
is officially documented live in this vault's own handbook note on building on
Claude Code function hooks. Find it with wiki-query — it is deliberately not
named by path here, because this repo is public and vault note titles are the
user's content.

## Parallel agents over vault content

A general-purpose dispatch that a classify judges to be vault **research** has
its prompt REWRITTEN by `agent.spawn`, not refused — it gains instructions to
use `vault_search`/`vault_note` and the doctrine that a pointer is not a
finding. Nothing is blocked, so nothing needs an escape hatch (v1's
`agent-guard` deny and its `ALLOW_VAULT_AGENT` marker are gone). Orchestrated
**work** (`vault-work`) and unrelated dispatches pass untouched. Forks and
named agents (`commonplace:*`, `code-reviewer`, `Explore`) are never steered.

## No RAG — search finds, links follow, reading connects

commonplace is not a RAG system. Never substitute keyword/concept-string matching for an actual relevance judgment — that's exactly the blind spot RAG has: it misses real connections that don't share a literal string, and manufactures false confidence in the ones that happen to match.

**Mental model:** `vault_search` (or `commonplace search`) is a jumping-off point, not an answer. It tells you which few notes are worth reading; `vault_links`/`vault_path`/`vault_neighbourhood` follow the graph from there. The relevance judgment itself comes from reading those notes (`vault_note`) and reasoning about whether they actually connect — not from whether a keyword, concept name or graph proximity matched.

This applies anywhere a "does X relate to Y" decision gets made — cross-domain bridging, deep-linking, pre-ingest triage, wiki-query. A note can be highly relevant to another with zero shared concept names or strings (e.g. a shipping-delay story bearing on a supplier note's "Single-Source Risk" angle without ever naming the supplier). If a check only compares index fields and stops there, it isn't finished — it must follow the grep hit to the real file and read it before concluding anything. Seeding itself is tiered-lexical (`commonplace seed`): abstraction → cue anchors → names/titles → whole-record grep as a gated fallback. Better jumping-off points, same rule — the tier tells you where to start reading, never whether something is relevant.

## Never use Python or shell one-liners to parse JSON

**This is a hard rule.** Never do this:
```bash
cat .wiki/moc-index.jsonl | python3 -c "import json,sys; ..."
cat file.json | python3 -c "import json,sys; data=json.load(sys.stdin); ..."
```

Instead:
- **To find or follow notes**: use the vault tools (`vault_search`, `vault_links`, …) or their CLI twins; never parse `.wiki/graph/*` or the jsonl yourself
- **To look up maintenance records**: `commonplace records --kind source|concept|moc|domain|backlink [--match <text>] [--path <rel>]`
- **To read a file**: use the `Read` tool — never `cat`
- **Script output**: assign to a variable and read it directly — scripts output valid JSON, trust it

If you catch yourself about to pipe to `python3` or `jq`, stop and use Grep or Read instead.

## Test fixtures must be invented — never based on a live vault

**This is a hard rule. This repo is public.** Test creation should always make up its own framing and never be based on a live vault. When you write or update a test — for the linker, indexer, lint, seed, connect, anything — invent the note names, concept names, domains, titles, and body text. Never copy a real note title, concept name, domain slug, or any other content out of a vault you inspected while diagnosing the bug, even when the bug report itself named them. Real vault content in a committed test leaks private data into a public repo. Use obviously-fake placeholders (`Alpha Method`, `Gamma Term`, `Acme Report`, domains `alpha`/`gamma`) that exercise the same code path without carrying any real content.

## Scripts

All scripts are invoked via the `commonplace` CLI, which is automatically on PATH when the plugin is active. Just call `commonplace <cmd>` directly — never reconstruct PATH or use `npx tsx` to run scripts manually.

Command hooks (shell subprocesses) don't inherit the Bash tool PATH, so they use `node ${CLAUDE_PLUGIN_ROOT}/bin/commonplace <cmd>` instead. Skills, agents, and normal Bash tool calls should always use the bare `commonplace` command.

All commands auto-discover the vault via cwd (`.obsidian/` or `.wiki/` marker) or `.vault-path` fallback. The `--vault <path>` flag is optional — only needed for `init` or when overriding auto-discovery.

- `commonplace vault-path` — Print the configured vault path (no tsx spawn, instant).
- `commonplace records --kind <kind> [--match <text>] [--path <rel>]` — Maintenance records as JSONL (public + `COMMONPLACE_OPEN` shards)
- `commonplace vault [show|list|use <id> [--default]|unpin]` — Show or choose the active vault from a terminal (in a session: `/vault`)
- `commonplace search --query "<text>"` · `note --ref "<title|path>"` · `links --ref "<…>" [--direction out|in|both]` · `path --from <ref> --to <ref>` · `neighbourhood --seed <ref>…` — CLI twins of the vault tools: same code, same output, `--json` for the structured result. Private domains stay sealed unless the PERSON passes `--open <domain>` (the guard denies it from the model).
- `commonplace session-check` — The one shell hook (SessionStart): dist rebuild, cache cleanup, module watchdog
- `commonplace synthetic --scale N --out <dir>` / `commonplace eval:scale` — Synthetic vaults and the scale benchmark
- `commonplace test:ui` — Module UI tests under `claude plugin test` (terminal + desktop); also `npm run test:ui`
- `commonplace eval:prime [--repeat 3] [--init]` — Prime's gate (live `claude -p` sessions)
- `commonplace eval:search [--tune] [--cfg '<json>'] [--cues <draft>] [--show "<q>"] [--json] [--history]` — `vault_search` + Connect pool over the vault's gold sets, in-memory build, zero tokens
- `commonplace dates [--dry-run] [--json]` — Backfill `published:` on source notes from their labelled source line (`**Published:**`, `**arXiv:**`, `**Source:**`…); never guesses; a note with `published:`/`date:` is left alone
- `commonplace cues [--limit N] [--match <text>] [--concurrency N] | --filter-only | --write [--dry-run]` — Draft `cues:` (other phrasings a reader would search by) with haiku, public notes only, filtered by self-retrieval; `--write` inserts them as the last frontmatter line
- `commonplace vaults [--match "<phrase>"] [--json]` — List registered vaults, or match one by name (used by wiki-query to resolve "search in <name>")
- `commonplace config` — Print `.wiki/config.json` contents (no tsx spawn, instant)
- `commonplace index [--incremental] [--json]` — The single index writer: `.wiki/graph/` (v2 graph artefacts), `.wiki/sealed/`, and the per-shard records files (v1's `*-index.jsonl` are no longer written; stale ones are deleted). `--incremental` is a no-op when no note is newer than the last build.
- `commonplace lint [--check <name>] [--json] [--rank-by-traffic]` — Vault health audit (human-readable summary by default, `--json` for machine-parseable; `--rank-by-traffic` sorts stub findings by backlink count, descending). Checks include `unresolved`, `stubs`, `orphans`, `frontmatter`, `moc-staleness`, `moc-size`, `scope-violations`, `duplicates`, `malformed-dates`, `filename-h1-mismatch`, `near-duplicate-names`, `near-duplicate-content`, `malformed-concept-names`, `underlinked`, `cluster-cohesion`, `bridge-thinness`, `weak-summary`, `cross-scope-bridge`, `concept-density-without-source-links`.
- `commonplace validate <file>` — Single file frontmatter validation
- `commonplace scope-check [<file>]` — Domain scope enforcement
- `commonplace score [--json]` — Compute vault quality score (human-readable by default, `--json` for machine-parseable)
- `commonplace prune` — Remove low-value stubs
- `commonplace init --vault <path>` — Initialize plugin for a vault (requires explicit path)
- `commonplace post-write [--no-index]` — Post-write analysis (reads stdin); the module passes `--no-index` because it patches the graph itself
- `commonplace raw [--instruct]` — Scan raw/ for uningested files; `--instruct` prints human-readable summary
- `commonplace freshen [--sample <n>] [--min-age-days <n>]` — Sample oldest-unchecked live source URLs for freshness checking
- `commonplace freshen --record` — Record a check result (reads JSON from stdin, merges into `.wiki/freshness.json`)
- `commonplace freshen --clear <relative-path>` — Clear stale flag after re-ingesting a note
- `commonplace deep-link [--mode concepts|notes] [--threshold <n>] [--top <n>] [--note <path>]` — Find implicit concept connections via semantic similarity (requires Ollama + nomic-embed-text)
- `commonplace hub-score [--top <n>] [--json]` — HITS hub/authority scoring over the backlink records; ranks top hubs and authorities, flags high-hub-low-authority nodes as likely administrative aggregators (MOCs/index pages) vs. genuine topical authorities
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

The set of vaults lives in `vaults.json` under `CLAUDE_PLUGIN_DATA` (a registry of `{id, path, label, aliases, isPrivate?}` plus a `default`). An `isPrivate` vault never appears in another vault's listings and none of its titles may be written outside it. `/vault use <id>` pins a vault for the project (`--default` for every project). `commonplace init` appends to it; `.vault-path` is kept as a back-compat mirror of the default vault for instant `bin/commonplace` lookups. Selection precedence is: explicit `--vault <id|path>` → cwd walk-up (`.obsidian/`/`.wiki/`) → registry default. Per-vault `.wiki/` config/indexes are unchanged. The vault's own CLAUDE.md defines the schema and conventions.

## Domain System

Domains are inferred from file paths, never stored in frontmatter. The registry is `<vault>/.wiki/domains.json`: `{path, scope, linkGroup?, aliases?}` per domain. A private domain's shard is its `linkGroup` (else its id), so opening one domain opens its group. `aliases` are other names the user calls it, used by `/vault open` and prompt proposals. Folders that appear after the first v2 index are quarantined (sealed) until `/vault domain public|private <id>`.
