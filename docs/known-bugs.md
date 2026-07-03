# Known Bugs & Quarantine Registry

Human-readable index of destructive or high-risk bugs in commonplace's agent/script paths, and the mechanism that keeps retired paths from being re-triggered.

## The quarantine registry (`.wiki/quarantine.json`)

Machine-readable, **per-vault**, optional. When present, it is a JSON array:

```json
[
  {
    "id": "concept-linker-substring",
    "component": "wiki-concept-linker (agent, retired)",
    "symptom": "substring wikilinking corrupts note content",
    "status": "fixed-by-replacement",
    "replacedBy": "scripts/link.ts",
    "doNotInvoke": ["wiki-concept-linker"]
  }
]
```

`status` is one of `open` | `quarantined` | `fixed` | `fixed-by-replacement`.

**Enforcement rule:** any skill that dispatches agents (autoimprove, wiki-ingest) must read this file if it exists and **hard-skip** any agent or round whose name appears in a `doNotInvoke` list with `status` of `open` or `quarantined`. Entries may only move to `fixed`/`fixed-by-replacement` — or be removed — when the fix **and** its regression test have both landed.

## Bug-fix process of record

1. Reproduce with a minimal input; capture the exact corruption.
2. Write a failing regression test first (`scripts/**/*.test.ts`; test the pure lib function directly where one exists).
3. Choose fix class: (a) deterministic-script guard — preferred for mechanical/data operations; (b) agent/prompt constraint — only for genuine judgment; (c) retire the path entirely.
4. Fix → test passes → full `npm test`.
5. Update the quarantine entry (and this index) only after the test is committed.

## Case index

### concept-linker-substring — RESOLVED (fixed-by-replacement)

- **Symptom:** the retired `wiki-concept-linker` agent wikilinked concept mentions by naive substring replacement — wrapping matches inside words, inside existing `[[ ]]`, and inside code/frontmatter — corrupting note bodies.
- **Root cause:** content rewriting performed in an LLM agent's free-form `Edit` path with no word-boundary or context guards.
- **Fix:** retired the agent; replaced by deterministic `commonplace link` (`scripts/link.ts` + pure function in `scripts/lib/linker.ts`) — first-safe-occurrence only; frontmatter, code, headings, existing links, and markdown link spans are off-limits by construction.
- **Regression coverage:** `scripts/lib/linker.test.ts`.
