# Spec Outline — Indexed Abstraction Layer

Status: draft outline · Owner: TBD · Priority: **highest** · Related: `scripts/index.ts`, `scripts/lint.ts` (`weak-summary`), `skills/wiki-ingest`, `skills/wiki-compile`, `scripts/validate.ts`
Framing source: Memora (arXiv 2602.03315) — the abstraction layer does nearly all the retrieval work (Table 3: 0.653 → 0.795, vs. +0.05–0.07 for every other component combined).

## 1. Problem

Memora's central empirical result is that indexing on a compact **abstraction** — not on body content — is where the gain lives. commonplace has no such indexed abstraction:

- `concept-index.jsonl` = `{name, path, domains, backlinkCount, isStub}` — the only seed-match target is the raw concept `name`.
- `source-index.jsonl` = `{title, path, domain, scope, tags, concepts, mocs}` — no summary/abstraction field; the `## Summary` in the note body is never indexed as a retrieval key.

So retrieval seeds against a bare name/title string. In this frame a **stub is a note with a missing abstraction** — which is exactly why 28% stubs degrades recall: those nodes have no usable index key.

## 2. Goals / Non-goals

**Goals**
- Every concept and source note carries a short, canonical, indexed `abstraction`.
- The abstraction becomes the **primary seed-match key** (consumed by the mixed-key seeding spec).
- Abstraction quality is lint-gated, reusing the existing `weak-summary` check.

**Non-goals**
- Not embedding anything (this is a lexical/structural field; semantic indexing is a separate, later spec).
- Not rewriting note bodies — the abstraction is metadata derived from the body, stored in frontmatter + index.

## 3. The field

- New frontmatter key `abstraction:` — one canonical descriptor, ~6–12 words, noun-phrase-first ("harmonic memory representation that decouples storage from retrieval"), no citations, no dates.
- For concepts: it replaces the "*Definition pending*" stub sentinel as the thing `isStub` keys on — `isStub = abstraction empty OR body still sentinel`.
- For sources: derived from `## Summary`'s first clause at ingest; editable.

## 4. Population

- `skills/wiki-ingest`: generate `abstraction` when creating any note (concept or source).
- `skills/wiki-compile`: filling a stub = writing its `abstraction` + body definition (one action).
- `scripts/index.ts`: add `abstraction` to both index schemas.
- `scripts/validate.ts`: require non-empty `abstraction` on non-stub notes.

## 5. Quality gate

- Extend the existing `weak-summary` lint check to also flag empty/low-information `abstraction` fields (e.g. abstraction that merely repeats the title, or is < 4 content words).
- Feeds the autoimprove stub-compilation round (already capped at 5/round, ordered by backlink count).

## 6. Files touched

| File | Change |
|---|---|
| `scripts/index.ts` | add `abstraction` to concept + source index records |
| `scripts/validate.ts` | require `abstraction` on non-stub notes |
| `scripts/lint.ts` | extend `weak-summary` to cover abstraction quality; redefine `isStub` |
| `skills/wiki-ingest` | generate `abstraction` at note creation |
| `skills/wiki-compile` | fill = write abstraction + definition |
| Frontmatter Schema doc | document the new field |

## 7. Decisions to lock

1. **Length/format** — 6–12 words, noun-phrase-first: accept or tune?
2. **Source abstraction vs. `## Summary`** — derive-and-store a separate field, or promote Summary's first line by convention? (Recommend a separate stored field — Summary prose ≠ a matchable key.)
3. **Backfill** — one-time pass to synthesize abstractions for all 232 existing sources / 278 concepts, or populate lazily as notes are touched?
4. **isStub redefinition** — does keying `isStub` on abstraction-emptiness reclassify any currently-"complete" notes? (Audit before flipping.)
