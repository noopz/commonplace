# Spec Outline — Authority-Aware Retrieval & MOC Signal

Status: draft outline · Owner: TBD · Priority: medium (small, high-ROI — consumes an existing signal) · Related: `scripts/lib/hits.ts`, `scripts/hub-score.ts`, `skills/wiki-query`, `scripts/lint.ts`, `docs/moc-size-governance-spec.md`
Framing source: Memora (arXiv 2602.03315) — abstraction-first **scoping** narrows the candidate set before traversal (efficiency, Theorem D.6). Retrieval needs a ranking prior, not an undifferentiated frontier.

## 1. Problem

commonplace already computes HITS hub/authority in `scripts/lib/hits.ts` (`scripts/hub-score.ts` CLI) — and the module's own header notes the key insight: it "separates administrative aggregators (MOCs that link to everything — high hub, low authority) from genuine topical authorities." But this score appears **consumed only by the manual CLI** — not by `wiki-query` (which traverses with no ranking prior) nor by `lint`. A computed-but-unused signal.

Two places the paper says ranking matters, both currently blind to it:
- **Seed + frontier ranking** in wiki-query — everything is equally weighted.
- **MOC bloat classification** — the MOC-size spec's cap is a crude proxy; hub-vs-authority is the real discriminator (a big *index* MOC is fine; a big *low-authority* MOC has stopped meaning anything).

## 2. Goals / Non-goals

**Goals**
- wiki-query ranks seed hits and the expansion frontier by authority.
- The `moc-size` lint check (from moc-size-governance-spec) uses hub-vs-authority to distinguish a legitimate aggregator from a bloated topical MOC.

**Non-goals**
- Not changing how HITS is computed (`hits.ts` stays as-is).
- Not auto-pruning low-authority notes — this is ranking, not deletion.

## 3. Mechanism

- **Persist scores in the index:** `scripts/index.ts` writes `authority` and `hub` onto each record (currently only available via the standalone CLI). One incremental compute per index build.
- **wiki-query:** when multiple seeds/frontier candidates tie on relevance, order by `authority` desc; surface top authorities first when reading. Documented in the skill; optionally exposed as a `--rank` on the seed helper.
- **MOC-size check:** refine the `hardCap` violation from "N ≥ cap" to "N ≥ cap **and** hub ≫ authority" (aggregator pattern) → flag for split; a high-authority large MOC is downgraded to info.

## 4. Files touched

| File | Change |
|---|---|
| `scripts/index.ts` | persist `authority`/`hub` per record from `lib/hits.ts` |
| `skills/wiki-query` | rank seeds/frontier by authority |
| `scripts/lint.ts` | `moc-size` uses hub-vs-authority, not raw count alone |
| `docs/moc-size-governance-spec.md` | cross-reference: cap is proxy, authority is signal |

## 5. Decisions to lock

1. **Recompute cadence** — HITS on every incremental index build, or only on full rebuilds? (HITS needs the full graph; recommend full-rebuild only, cache between.)
2. **Ranking strength** — authority as a tie-breaker only, or a weighted term in seed ranking? (Recommend tie-breaker first; measure via retrieval-eval-harness before weighting.)
3. **Aggregator threshold** — what hub/authority ratio marks "administrative"? Derive empirically from current 14 MOCs.
