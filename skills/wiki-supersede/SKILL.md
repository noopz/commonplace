---
name: wiki-supersede
description: "ALWAYS use when the user retires, replaces, or decommissions a vault entity — 'mark X retired', 'switched from X to Y', 'Y supersedes X'; when an ingested note's body says `supersedes|replaces|formerly [[X]]`; or when another skill flags retired-but-live mentions. Reframes sibling notes from live to historical (wiki-ingest doesn't do this retroactively). Skip for stale-link cleanup, typo renames, or live entities still in use."
---

# Wiki Supersede

Retire an entity (tool, project, framework, person, concept) that has been replaced by a successor, and propagate the live→historical reframing across every note that mentions it. Without this, sibling notes keep describing the retired entity in present tense — the vault drifts out of sync with reality.

## Why This Skill Exists

`wiki-ingest` records *new* facts well but does not retroactively rewrite *old* notes when the world changes. When a tool is replaced (e.g. Portainer → Arcane), the new note declares supersession but every existing note that recommends the retired tool keeps reading as live advice. This skill closes that loop: it marks the old note as retired, rewrites cross-references into past tense or comparison framing, and leaves a breadcrumb so re-runs are idempotent.

## Activation Triggers (three categories)

**1. User-utterance triggers** (highest signal, highest miss rate — bias toward activating)
- "mark X as retired" / "X is deprecated" / "X is decommissioned"
- "we switched from X to Y" / "Y replaces X" / "use Y instead of X"
- "X is gone now" / "X is dead" / "kill the X note"
- "Y supersedes X" / "Y is the successor to X"

**2. Note-body triggers** (after `wiki-ingest` writes a new source note, scan the body for these patterns)
- Regex: `(supersedes|replaces|replaced|migrated from|formerly|previously known as|in place of)\s+\[\[([^\]]+)\]\]`
- Phrasings without wikilinks but with a clear named entity also count — prompt the user to confirm the predecessor.

**3. State triggers** (catch retroactive cases)
- A note's frontmatter gains a `retired` tag.
- A note gains a `> [!warning] Retired` callout.
- `commonplace lint` reports `retired-but-referenced` issues.
- `wiki-query`, `wiki-pruner`, or `wiki-impact-checker` flags a retired entity that still has live mentions in siblings.

If you see any of the above, run this skill before continuing the current task. Other skills will route you here explicitly.

## What This Skill Does

The work is split between a deterministic TypeScript subcommand and LLM judgment:

- `commonplace supersede --scan --old <path> --new <path>` — find every mention of the retired entity across the vault and classify each hit
- `commonplace supersede --retire --old <path> --new <path> --reason "<text>"` — apply the retirement (callout, frontmatter tag, file rename, wikilink rewrites, breadcrumb)
- `commonplace supersede --check` — punch-list mode: find supersessions that were declared but never propagated, or retired notes whose siblings still describe them as live
- `commonplace supersede --list` — show all recorded supersessions from `.wiki/supersessions.jsonl`

You provide judgment on edge cases the classifier marks `needs-review`.

## The Workflow

### Step 1 — Confirm scope with the user

Before any rewrites, confirm:
- The old entity (path to its note)
- The new entity (path to its successor note — must already exist; if not, ingest it first via `wiki-ingest`)
- The reason for retirement (one short sentence — goes into the callout)

If the successor doesn't exist yet, stop and route to `wiki-ingest` first.

### Step 2 — Scan and classify

Run `commonplace supersede --scan --old <path> --new <path>`. Each hit is sorted into one of six buckets (`historical`, `comparison`, `already-retired`, `live`, `live-in-code`, `needs-review`). For the per-bucket meaning, what to leave alone, and how to handle rewrite candidates, read `${CLAUDE_SKILL_DIR}/references/classification.md`.

### Step 3 — Sample classifications back to the user

Show the user 3–5 representative classifications (mix of buckets) before any rewrite. Classification is heuristic; the user should sanity-check before mass edits.

### Step 4 — Apply

Run `commonplace supersede --retire --old <path> --new <path> --reason "<text>"`. This:
1. Injects a `> [!warning] Retired YYYY-MM-DD` callout at the top of the old note, with the reason and `Superseded by [[<new>]]`.
2. Adds a `retired` tag to the old note's frontmatter.
3. Renames the file to `(Retired) <Original Title>.md` and updates wikilinks vault-wide.
4. Adds a backref under `## Related` in the new note (idempotent).
5. Writes a breadcrumb to `.wiki/supersessions.jsonl` keyed on `(old, new)` so re-runs skip already-rewritten siblings.

### Step 5 — Live mentions

Rewrite each `live` hit (and rename-safe `live-in-code`) per the guidance in `references/classification.md`.

### Step 6 — Verify

Re-run `commonplace supersede --scan --old <new-retired-path> --new <path>`. The output should report zero `live` and zero `live-in-code` hits. Then run `commonplace supersede --check` to confirm no debt remains.

## Idempotency

The breadcrumb in `.wiki/supersessions.jsonl` is the source of truth. If `--retire` runs twice for the same `(old, new)`, the second run is a no-op. If you rewrite a sibling and then re-run `--scan`, the previously-rewritten sentence will classify as `historical` and be left alone.

## --check Mode (safety net)

Run `commonplace supersede --check` periodically (or when the user asks "any retirement debt?"). It reports:
- **Retired notes with live siblings**: a note tagged `retired` but other non-retired notes still describe it in present tense.
- **Declared but not propagated**: a note's body says `replaces [[X]]` or `supersedes [[X]]` but `.wiki/supersessions.jsonl` has no breadcrumb for `(X, this)`.

These are punch-list items, not blockers. Surface them to the user and offer to run the full workflow.

## Cross-Skill Routing

- **`wiki-ingest`** scans new note bodies for supersession declarations and routes here when found.
- **`wiki-query`** routes here when the user asks about a retired entity.
- **`wiki-pruner`** refuses to delete notes carrying a retirement callout/tag and routes here instead — retired notes are kept as historical record, not pruned.
- **`wiki-impact-checker`** includes "supersession candidate detected" in its impact reports.

## What This Skill Is Not

- Not for fixing broken wikilinks where the target doesn't exist (that's a separate stale-link skill).
- Not for renames where the entity is the same (e.g. typo fix). Use a regular rename, not retirement.
- Not for entities still in active use. If the user is uncertain whether X is retired, ask before activating.

## When You're Wrong

If a rewrite turns out to be wrong (the entity wasn't actually retired, or the new note isn't really a successor), the breadcrumb in `.wiki/supersessions.jsonl` is the recovery point. Remove the breadcrumb line, undo the file rename, drop the callout/tag, and re-run `commonplace index`.
