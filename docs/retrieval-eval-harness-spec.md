# Spec Outline — Retrieval Eval Harness

Status: draft outline · Owner: TBD · Priority: **build first** (prerequisite for measuring the others) · Related: `evals/`, `skills/wiki-query`, `scripts/vault-score.ts`, test harness (`npm test`)
Framing source: Memora (arXiv 2602.03315) — its entire credibility rests on an ablation table (Table 3) that isolates each component's contribution: abstraction +0.14, cue anchors +0.001, update +0.006, policy +0.014. Without an equivalent, every commonplace retrieval change is unmeasurable.

## 1. Problem

`evals/` has **no retrieval eval.** There is `scripts/vault-score.ts` (structural health) but nothing that measures whether wiki-query actually *finds the right notes*. Consequently the improvements in the sibling specs — abstraction layer, mixed-key seeding, authority ranking, MOC splitting — cannot be validated; we'd be shipping on intuition. Memora's lesson is precisely that intuition about retrieval is often wrong (cue anchors turned out to contribute ~0 to the cheap retriever). commonplace needs its own Table 3.

## 2. Goals / Non-goals

**Goals**
- A small, versioned gold set of `question → expected-notes`.
- Two scores per run: **seed recall** (did the right notes make the candidate set?) and **answer groundedness** (did the final answer cite the right notes / avoid unsupported claims?).
- Runnable as an ablation: toggle each sibling-spec feature on/off and diff the scores.

**Non-goals**
- Not a benchmark against other systems — this measures commonplace against itself over time.
- Not fully automated judging at first; an LLM-judge is fine (mirror Memora's gpt-4o-mini judge), with a fixed seed.

## 3. Mechanism

- **Gold set:** `evals/retrieval/gold.jsonl` — records `{question, expected_notes: [paths], type: single-hop|multi-hop|cross-domain}`. Seed with ~20–30 questions drawn from real vault content across domains and hop-counts.
- **Runner:** `evals/retrieval/run.ts` — for each question, invoke the wiki-query seed+traverse path, capture (a) candidate note set, (b) final answer + cited notes.
- **Scorers:**
  - seed recall = |expected ∩ candidates| / |expected|;
  - groundedness = LLM-judge (fixed seed) on answer vs. expected notes.
- **Ablation flags:** `--no-abstraction`, `--no-mixed-key`, `--no-authority` to isolate each feature's delta — the commonplace analog of Memora Table 3.
- **Report:** table of per-type scores + deltas; append to a history file like `score-history.json`.

## 4. Files touched

| File | Change |
|---|---|
| `evals/retrieval/gold.jsonl` | **new** — versioned gold questions |
| `evals/retrieval/run.ts` | **new** — runner over wiki-query path |
| `evals/retrieval/score.ts` | **new** — seed-recall + groundedness scorers |
| `package.json` | `eval:retrieval` script |
| `scripts/vault-score.ts` | optional: fold a retrieval-score summary into the health report |

## 5. Decisions to lock

1. **Gold-set authorship** — hand-curate now (~25 Q), or bootstrap by asking an LLM to generate Q from existing notes then human-filter? (Recommend bootstrap + filter.)
2. **Judge model + determinism** — pin a model and seed (Memora used gpt-4o-mini, seed 42) so scores are comparable across runs.
3. **Recall target** — what seed-recall bar counts as a regression gate in CI?
4. **Scope** — retrieval only, or also add an ingest-quality eval (are generated abstractions good)? (Recommend retrieval first.)

## 6. Why this is first

Specs abstraction-layer / mixed-key / authority / MOC-governance each claim a retrieval improvement. This harness is the only thing that can confirm or refute those claims — and Memora's own results show at least one plausible "improvement" (cue anchors) contributed nothing. Build the ruler before cutting.
