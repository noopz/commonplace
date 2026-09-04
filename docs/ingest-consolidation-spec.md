# Spec Outline — Consolidation-as-Flag at Ingest

Status: draft outline · Owner: TBD · Priority: medium-low (bounded by provenance constraint) · Related: `skills/wiki-ingest`, `scripts/impact.ts`, `agents/wiki-impact-checker.md`, `scripts/lint.ts` (`near-duplicate-names`), `scripts/deep-link.ts`
Framing source: Memora (arXiv 2602.03315) — evolving/recurring information consolidates under a single canonical entry rather than fragmenting into duplicates (Eq. 5 Update()). Note the paper's own data: merging accounts for only ~20% of its entry-count reduction (88/432 candidates); most compaction is extraction granularity. So consolidation is a hygiene measure, not the main lever.

## 1. Problem

commonplace consolidates at the **concept** level (wiki-ingest reuses an existing concept instead of duplicating) but never at the **source** level — every ingest mints a new source node. Duplicate-detection today is `near-duplicate-names` lint (title strings only); there's no near-duplicate-**content** signal at ingest. Over time this fragments: two sources covering the same finding sit as disconnected nodes.

**Hard constraint (non-negotiable):** source notes carry citation identity and provenance. Unlike Memora's anonymous agent memories, they must **not** be auto-merged. The bounded move is *flag-and-link*, routing to the existing supersession path — never silent value-merge.

## 2. Goals / Non-goals

**Goals**
- At ingest, detect when a new source substantially overlaps an existing one and surface it as a consolidation/supersession candidate.
- Reuse the existing `wiki-impact-checker` / supersede machinery rather than building new merge logic.

**Non-goals**
- No auto-merge of source notes. Ever.
- Not deduplicating concepts (already handled).
- Not a retrieval change (this is write-side hygiene).

## 3. Mechanism

1. On ingest, after drafting the new source's `abstraction` (see abstraction-layer-spec), compare it against existing source abstractions:
   - lexical: `near-duplicate-names`-style match extended to the abstraction field;
   - optional semantic: reuse `scripts/deep-link.ts`'s transient Ollama embeddings in `--mode notes` to score abstraction-to-abstraction similarity (no new infra).
2. If similarity ≥ threshold → **do not block**; emit a consolidation candidate and dispatch `wiki-impact-checker` with both notes.
3. `wiki-impact-checker` decides: (a) genuine supersession → route to `wiki-supersede`; (b) complementary → add cross-links; (c) false positive → drop.

## 4. Files touched

| File | Change |
|---|---|
| `skills/wiki-ingest` | post-draft overlap check → flag candidate (never block/merge) |
| `scripts/impact.ts` | accept an abstraction-similarity candidate as input |
| `agents/wiki-impact-checker.md` | handle the supersede / cross-link / drop decision |
| `scripts/lint.ts` | optional `near-duplicate-content` check (abstraction-level) for backfill |

## 5. Decisions to lock

1. **Similarity source** — lexical-only (cheap, deterministic) or lexical + transient embeddings via deep-link? (Recommend lexical first; add embeddings only if recall is poor.)
2. **Threshold** — tune against known near-dup pairs in the current vault.
3. **Timing** — synchronous in the ingest flow, or a post-write hook like the existing impact check? (Recommend post-write hook — keeps ingest fast, matches current architecture.)
4. **Backfill** — run the content-dup check once over existing 232 sources, or govern new ingests only?
