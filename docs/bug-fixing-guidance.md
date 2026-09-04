# Bug-Fixing Guidance for commonplace

Status: draft outline · Related: `scripts/link.ts`, `scripts/lib/linker.ts`, `skills/autoimprove`, `skills/wiki-ingest`, test harness (`npm test`)

## Guiding principle: destructive bugs get *retired*, not patched

The concept-linker is the template. The bug wasn't fixed by improving a prompt — the whole path was moved out of an LLM agent's free-form `Edit` into a **deterministic, pure-function script** whose safety is enforced in code (`scripts/lib/linker.ts`). Generalize:

- **Mechanical, content-mutating operations belong in deterministic scripts**, not in an agent's `Edit` path. Agents are for judgment (which links are meaningful), not for rewriting bytes.
- When a bug can *destroy data*, the fix must remove the ability to destroy it — guards as code + a regression test — not add a caution to the prompt.

## Per-bug playbook

1. **Reproduce** with a minimal input; capture the exact corruption (before/after).
2. **Write a failing regression test first** — `node --test`, file at `scripts/**/*.test.ts`. For linker-class bugs, test the pure lib function directly (no vault, no LLM).
3. **Choose fix class:**
   - (a) *Deterministic-script guard* — preferred for any mechanical/data operation.
   - (b) *Agent/prompt constraint* — only for genuine judgment that can't be made deterministic.
   - (c) *Retire the path* — when the operation shouldn't be agent-driven at all (the concept-linker outcome).
4. **Fix → make the test pass → run full `npm test`.**
5. **Guard against regression:** test committed, and the bug's entry cleared from the quarantine registry (below).

## Known-bug quarantine registry (new)

**Problem:** skills/agents have no machine-readable way to know "don't dispatch X, it's broken." That knowledge currently lives only in a user's private memory — so a fresh session or a different user can re-trigger a retired, destructive path.

**Proposal:** add `.wiki/quarantine.json` (machine-readable) + a human `docs/known-bugs.md` index:

```
[{ "id": "concept-linker-substring",
   "component": "wiki-concept-linker (agent, retired)",
   "symptom": "substring wikilinking corrupts note content",
   "status": "fixed-by-replacement",     // open | quarantined | fixed
   "replacedBy": "scripts/link.ts",
   "doNotInvoke": ["wiki-concept-linker"] }]
```

- `skills/autoimprove` and `skills/wiki-ingest` read the list and **skip any agent/round in `doNotInvoke`** whose status is `open`/`quarantined`.
- Entry is removed only when a fix **and** its regression test land.

## Case study: concept-linker (substring corruption)

- **Symptom:** wikilinking concept mentions by substring match wrapped matches *inside* words, inside existing `[[ ]]`, and inside code/frontmatter → corrupted or destroyed note bodies.
- **Root cause:** a content rewrite performed in an LLM agent's `Edit` path via substring, with no word-boundary or context guards.
- **Fix already shipped:** `scripts/link.ts` + `scripts/lib/linker.ts` — deterministic, first-safe-occurrence, with frontmatter / code / headings / existing-links off-limits, enforced by a pure function rather than prompt rules.
- **Still missing (action):** there is **no `scripts/link.test.ts`**. The pure linker function is the exact surface that was previously destructive and has zero regression coverage. Add unit tests covering, at minimum:
  - match inside a longer word → must NOT wrap
  - match already inside `[[ ]]` → skip
  - match inside a fenced code block and inline code → skip
  - match inside frontmatter → skip
  - match inside a heading → skip
  - only the **first** safe occurrence is wrapped
  - multi-target precedence (longer/more-specific target wins)
- **Verify cleanup:** grep `skills/ agents/ docs/` for stale `wiki-concept-linker` references and remove them; confirm `autoimprove` no longer lists it in any round.

## General coverage gap

Content-**mutating** scripts are the data-destroying class and should be tested first. Current state:

| Script | Mutates notes? | Has `.test.ts`? |
|---|---|---|
| `link.ts` / `lib/linker.ts` | yes | **no** ← priority |
| `prune.ts` | yes | **no** |
| `supersede.ts` | yes | **no** |
| `moc-sync.ts` | yes | **no** |
| `cross-domain.ts` | no (reports) | yes |
| `impact.ts` | no (reports) | yes |
| `post-write-research.ts` | no | yes |

Priority order for adding tests = the four mutating scripts, `link.ts` first (known-buggy class, pure function, trivial to test).

## Files touched

| File | Change |
|---|---|
| `.wiki/quarantine.json` | **new** — machine-readable known-bug/quarantine list |
| `docs/known-bugs.md` | **new** — human index of the above |
| `scripts/link.test.ts` | **new** — regression tests for the linker (guards above) |
| `scripts/prune.test.ts`, `supersede.test.ts`, `moc-sync.test.ts` | **new** — mutating-script coverage |
| `skills/autoimprove`, `skills/wiki-ingest` | consult quarantine list; skip quarantined paths |
| this file | bug-fix process of record |

## Decisions to lock before build

1. **Quarantine format** — `.wiki/quarantine.json` (recommended, machine-readable) vs. a markdown table skills parse.
2. **Enforcement** — do skills hard-skip a quarantined agent, or warn-and-continue? (Recommend hard-skip for `status: quarantined`.)
3. **Test-first gate** — require a failing regression test in the same PR as any content-mutation fix? (Recommend yes.)
4. **Backfill scope** — add the linker test now (closes the known bug), or backfill all four mutating scripts in one pass?
