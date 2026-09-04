# Spec Outline — Mixed-Key Seeding for wiki-query

Status: draft outline · Owner: TBD · Priority: high (depends on abstraction-layer-spec) · Related: `skills/wiki-query`, `scripts/index.ts`, `CLAUDE.md` ("No RAG — grep finds, reading connects")
Framing source: Memora (arXiv 2602.03315) — retrieval scores the query against **abstractions AND cue anchors** (multiple distinct short semantic keys per entry, §3.2, Theorem D.6), then traverses; it never matches raw body content.

## 1. Problem

`skills/wiki-query` seeds by running `Grep` over whole index records ("Start with Grep on the indexes"), treating each record as one flat blob and matching on any substring. The cue-anchor analogs commonplace already has — tags, MOC names, wikilink-anchor phrases — are not matched as their own key space at seed time; they only get used *after* seeding, during traversal. Result: seeding is substring-luck over a bare name, exactly the weak-entry-point the abstraction-layer spec is meant to fix on the write side. This spec is the read side.

Design constraint: keep the **"No RAG"** philosophy — seeding stays lexical/structural, no embeddings. (A semantic-seed escalation is a separate, later spec, justified only past ~1k notes.)

## 2. Goals / Non-goals

**Goals**
- Seed by matching query terms against **explicit key spaces**, ranked: (1) `abstraction`, (2) cue anchors (tags + MOC names + link-anchor phrases), (3) name/title, (4) body grep as last resort.
- Preserve "grep finds, reading connects" — this changes *what* is matched, not the grep-then-read-then-traverse shape.

**Non-goals**
- No embeddings, no persistent vector index.
- Not changing the traversal step (hubs/MOCs/citation chains) — only the seed step.

## 3. Mechanism

1. Extract query key-terms.
2. **Tiered lexical match** against the indexes (post abstraction-layer-spec, `abstraction` is an indexed field):
   - Tier A: match against `abstraction` fields → strongest seeds.
   - Tier B: match against cue-anchor set (frontmatter `tags`, `mocs`, and a new indexed `anchors` list = the note's outgoing wikilink display texts).
   - Tier C: name/title exact + fuzzy.
   - Tier D: full-body `Grep` (current behavior) only if A–C are thin.
3. Rank the seed set (ties into authority-aware-retrieval-spec), then hand to the existing traversal step.

## 4. Index support

- `scripts/index.ts`: add an `anchors` field to the source/concept records = the set of wikilink display texts the note emits (its "cue anchors"). Cheap to compute during indexing.
- Document the tiered key spaces in `skills/wiki-query` so the agent greps fields in order rather than the whole record.

## 5. Files touched

| File | Change |
|---|---|
| `skills/wiki-query` | tiered mixed-key seed procedure (A→D), replacing flat index grep |
| `scripts/index.ts` | add `anchors` (outgoing-wikilink display texts) to records |
| `skills/wiki-query-workspace` | mirror the seed procedure if it shares the search step |
| `CLAUDE.md` | note the tiered key spaces under the "No RAG" section |

## 6. Decisions to lock

1. **Anchor extraction** — outgoing wikilink display texts only, or also inbound (who links *to* this note)? (Recommend both eventually; start outgoing.)
2. **Tier D gate** — what counts as "A–C thin" (e.g. < 3 seeds) before falling back to body grep?
3. **Agent vs. script** — is the tiered match a documented agent procedure (grep fields in order) or a new `commonplace seed` helper script the agent calls? (Recommend a helper script for determinism; the agent still does the reading/traversal.)
