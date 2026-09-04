# Claude Science Architecture — Synthesis Plan

## Framing

This doc evaluates six proposals lifted from a higher-stakes, multi-tenant AI-research-product architecture (think: multi-agent biomedical/citation pipelines with adversarial verification, RAG retrieval, and audit-grade provenance) against commonplace's actual reality: a single-user, git-backed personal knowledge vault of a few hundred notes, where the "user" is both author and sole reader, and the cost model is explicitly tiered — deterministic TypeScript scripts (free), Haiku agents (cheap, mechanical), main-model synthesis (expensive, rare). Six independent deep-dive reports, each adversarially fact-checked against the actual codebase, converge on a consistent pattern: the mechanics of most proposals are technically buildable and none violate the hard no-RAG constraint (no proposal here introduces a persistent/queryable vector index or a second knowledge representation alongside markdown — the one embedding-adjacent proposal, RRF fusion, is explicitly transient/request-time only, consistent with `commonplace-avoid-rag`). But import bias is the recurring problem: most of these proposals solve for stakes (multi-tenant trust, adversarial citation integrity, audit compliance) that don't exist at commonplace's scale, where git history, existing indexes, and a human who personally reads every note already cover the same ground for near-zero marginal cost. The synthesis below keeps what's cheap and closes a real, currently-open gap; discards what re-imports someone else's risk profile.

---

## 1. Claim-verifier for compiled concept notes (`verifier`)

**Verdict: SKIP**

- Corrected cost tier: moderate (Haiku-agent-per-synthesis-event; not deterministic-script-cheap) — and that's *after* a prerequisite restructuring.
- Concrete shape (if ever revisited): would require changing `wiki-compile`'s output template to attach per-claim source pointers (concept notes today only cite at note granularity via a flat "Papers Using This Concept" wikilink list, not per-claim), then a new Haiku agent (`agents/wiki-claim-verifier.md`) dispatched via a new branch in `scripts/post-write.ts`, mirroring `wiki-impact-checker`'s dispatch pattern.
- Justification: The proposal assumes a citation granularity (per-claim, footnote-style attribution) that doesn't exist anywhere in commonplace's synthesis output — it isn't a small add, it's a template redesign prerequisite. Even after that redesign, this is solving a problem with no observed instance in this vault: no lint check, no log entry, no memory note has ever flagged a hallucinated/misattributed claim in a synthesized note. This is a high-stakes-citation-integrity feature imported from a context (biomedical/publication-facing multi-agent product) where wrong citations are genuinely dangerous; here the failure mode is "the user notices an odd paragraph and fixes it," which existing human review during `autoimprove`/`wiki-compile` already covers.

## 2. Mechanical anti-confabulation diff (`confab-diff`)

**Verdict: ADOPT-LITE**

- Corrected cost tier: Tier 1, zero-LLM deterministic script — but only if scoped strictly to numbers and quoted strings, not "named entities" (which secretly requires either a new NER dependency or an LLM, defeating the zero-cost premise).
- Concrete shape: new `scripts/paper/groundedness-check.ts` (or `scripts/lib/groundedness.ts`) using regex only (`\d+(\.\d+)?%?`, quoted-string/code-span extraction), wired as a CLI entry, called from `agents/paper-reflection-agent.md` to feed into its existing "Gaps to Address" list (not a hard gate). Separately, a `lint`-style check (`commonplace lint --check grounding`) comparing a concept note's body against its cited source notes, parallel to the existing `scope-violations` check in `scripts/lint.ts`.
- Justification: this is genuinely cheap and additive — a regex diff over text already in context at generation time, matching the existing precedent (`quality-check.ts` already does exactly this class of check). No evidence this has ever bitten anyone at this vault's scale, and it will generate real false-positive noise (paraphrase, reformatted numbers), so it must stay a soft signal into an existing review step, never a gate.

## 3. RRF-fused lexical+semantic retrieval + subject-pointer staleness (`memory-retrieval`)

Two sub-proposals bundled together with different verdicts.

### 3a. RRF fusion + graded domain-boost

**Verdict: SKIP**

- Corrected cost tier: low-medium, but for negative reason — it's added complexity for no demonstrated gain.
- Justification: mechanically RAG-compliant (transient, request-time, discarded after use, same shape as `deep-link.ts`'s existing embed-then-discard pass) — but at ~526 notes/266 concepts there's no evidence the current cheap hard-filter-then-threshold pipeline is underperforming. Worse, it proposes folding the private/public domain-scope check (currently a hard boolean security gate in `canLink()`) into a soft ranking term inside the fusion score — that's a regression risk, not an improvement: a leak-guard that can be outvoted by a high lexical+embedding score is a security bug waiting to happen. Also conflates two currently-disjoint pipelines (deterministic exact-match linking vs. fuzzy semantic candidate proposal) that don't need to compete against each other.

### 3b. Subject-pointer staleness (git-hash snapshot on concept notes)

**Verdict: ADOPT**

- Corrected cost tier: low — one `git log -1 --format=%H -- <path>` call per source at compile time (the codebase already pays this exact cost pattern in `vault-score.ts` for a different staleness signal), one frontmatter field, one comparison pass.
- Concrete shape: add a `compiledFrom: [{path, hash}]` field to concept-note frontmatter, populated by `wiki-compile` at compile time (looked up via existing `concepts`/`buildsOn` index fields — no new store), checked by a new `commonplace lint` check (analogous to existing `moc-staleness`).
- Justification: this is not RAG-adjacent at all — it's a pure git-hash diff, no embeddings involved. It closes a real, currently-open detection gap that nothing else in the codebase covers: `freshen.ts` only catches drift in an *external* URL a source cites; it structurally cannot detect a human/agent editing a source note's own body (correcting a claim, adding a caveat) without touching any external link. Today nothing flags concept notes compiled from a since-edited source as stale. Cheap, exhaustive (every compile/lint run, not sampled), and uses a pattern already proven elsewhere in this exact codebase.

## 4. Ingested-content sanitization + injection framing (`trust-tiering`)

**Verdict: ADOPT-LITE**

Two halves, split verdict within the item:

- **"Data, not instructions" prompt framing — ADOPT.** Cost: free (a one-paragraph addition to `skills/wiki-ingest/SKILL.md`, `skills/wiki-query/SKILL.md`, `skills/autoimprove/SKILL.md`). Justification: confirmed genuine gap — no such framing exists anywhere in the prompt chain today, and `autoimprove` in particular runs multi-round, multi-write loops with less human-in-the-loop oversight than a live chat turn, making injected instructions in previously-ingested content a real (if unexploited) risk. This costs nothing and should just be done.
- **Regex-based image/URL-beacon sanitization — ADOPT-LITE, defense-in-depth only.** Cost tier: Tier 1 deterministic, near-zero (~15-line function). Concrete shape: `sanitizeIngestedBody()` in `scripts/lib/frontmatter.ts` (or new `scripts/lib/sanitize.ts`), stripping `![...](http...)` image embeds and over-length URLs, called from `post-write.ts`'s existing `sourceWritten` branch, with anything stripped surfaced via `output.additionalContext` for visibility (not silent mutation). Justification: real but narrow attack surface — it requires the *model itself* to have copied a raw remote image/tracking URL verbatim into synthesized prose, which current `wiki-ingest` instructions don't encourage (they tell it to download images locally as vault-relative wikilinks). This is local-privacy insurance in a single-user vault opened only by its own author's Obsidian client, not closure of an actively exploited hole — build it because it's nearly free, not because it's urgent.

## 5. Lineage/provenance log (`.wiki/lineage.jsonl`) (`lineage`)

**Verdict: ADOPT-LITE**

- Corrected cost tier: Tier 1 (deterministic scripts) cheap; Tier 2 (judgment/agent provenance) is hard and should be dropped, not attempted.
- Concrete shape: append `{note, source, writer, timestamp}` via `appendFileSync(.wiki/lineage.jsonl, ...)` right next to the existing `writeFileSync` calls in `scripts/moc-sync.ts`, `scripts/link.ts`, `scripts/supersede.ts` — 3-4 files, one line each, no new dependencies. Do **not** attempt the Read-based reconstruction for judgment agents (`wiki-linter`, `wiki-moc-updater`, `wiki-cross-domain-linker`) — this would require new tool-call-capture harness instrumentation and would still be unreliable/incomplete, since those agents are frequently dispatched with data already inlined in their prompt rather than doing their own Reads.
- Justification: the tier-1 slice is essentially free and adds real incremental value for those specific deterministic edits. But the item's original "#1 priority, unlocks other proposals" framing is not supported by the codebase — `git log -p`, per-round `autoimprove` checkpoint commits, and the existing backlink-index already answer "why does this note say X" and "what did a bad round touch" for the vast majority of real single-user cases. The one genuinely irreplaceable capability (fine-grained "this sentence came from source A, not B" attribution) is a rare, occasional query at this scale, not a load-bearing gap — hence lite, not full adoption, and no special ranking priority.

## 6. Explicit work-item framing for autoimprove rounds (`orchestration`)

**Verdict: ADOPT-LITE**

- Corrected cost tier: near-zero — pure prompt-template edit, zero new code.
- Concrete shape: change the "Log" section template in `skills/autoimprove/SKILL.md` from one aggregate line (`## [date] autoimprove | Score: {before} → {after}` / `- Rounds: N. {summary}`) to one line per round, stating scope and execution mode (Haiku-agent name vs. inline/main-model). `scripts/log.ts` needs no changes — it already just appends whatever string it's given.
- Justification: the scope-per-round discipline already exists and is enforced at execution time in `autoimprove`'s dispatch logic (SKILL.md already knows which rounds are Haiku vs. inline); this only makes that decision visible after the fact in the permanent log. Nothing is currently broken by its absence — it's an audit-trail granularity nicety with genuinely low, infrequent value. Adopt only because it's free to bundle into the lineage-log edit (same `commonplace log --entry` call site); drop without hesitation if it adds any friction.

---

## Ranked adoption order

Only ADOPT / ADOPT-LITE items, in build order:

1. **"Data, not instructions" prompt framing** (`trust-tiering`, half A) — zero cost, zero dependencies, fix immediately. Pure prompt text in three SKILL.md files.
2. **Subject-pointer staleness** (`memory-retrieval`, half B) — highest real value-to-cost ratio of the batch; closes an actually-open detection gap using a pattern already proven in `vault-score.ts`. Touches `wiki-compile`'s frontmatter write and a new `lint` check. No dependency on anything else in this list.
3. **Lineage tier-1 append** (`lineage`) + **autoimprove round-framing** (`orchestration`) — bundle these two together since both touch the same `commonplace log --entry` call sites and neither depends on the other. Do the lineage `writeFileSync`-adjacent appends in `moc-sync.ts`/`link.ts`/`supersede.ts` first, then fold the round-labeling template change into the same pass.
4. **Regex image/URL sanitization** (`trust-tiering`, half B) — small, isolated, no dependency on the others; do it whenever convenient, it's insurance rather than urgent.
5. **Groundedness/anti-confabulation regex diff** (`confab-diff`) — lowest priority of the adopted items because it requires touching `paper-reflection-agent.md`'s review flow and a new lint check, and its value is speculative (no observed failures); do it last, and treat it as optional if time runs short.

Rationale for ordering: items 1-2 are free-standing, highest-confidence wins with no cross-dependencies — do them first. Item 3's bundle is next because both pieces are trivial one-line-per-script/prompt changes sharing a call site, so bundling minimizes review overhead. Item 4 and 5 are independent, lower-confidence, and can slot in opportunistically without blocking anything else.

---

## Explicitly not doing, and why

- **Claim-verifier for compiled concept notes** — not doing this. It requires redesigning the concept-note citation format to per-claim granularity before it could even be built, and it solves a citation-integrity problem with zero observed instances in this vault. If hallucinated/misattributed claims in synthesized notes are ever actually observed (not hypothesized), revisit as a lightweight spot-check inside existing `wiki-compile`/`autoimprove` human review — not as a new dedicated Haiku agent or template redesign.
- **RRF-fused lexical+semantic retrieval with graded domain-boost** — not doing this. There is no evidence the current hard-filter-then-threshold linking pipeline underperforms at this vault's scale (~526 notes), and folding the private/public domain-scope check into a soft ranking term actively risks weakening a security boundary that currently works as a hard gate. Do not re-propose this unless (a) the vault grows by an order of magnitude and deep-link candidate quality demonstrably degrades, and (b) any domain-boost is scoped as a hard pre-filter before ranking, never as a term inside the fusion math.
- **Tier-2 lineage via agent Read-tracking** — not doing this specific piece (the tier-1 slice is adopted separately, see above). It requires new harness instrumentation to capture tool calls that doesn't exist today, and even with it, several of the target agents (`wiki-linter`, `wiki-moc-updater`, `wiki-cross-domain-linker`) are dispatched with data already inlined in their prompts rather than doing their own Reads, so a Read-based provenance log would be structurally incomplete for exactly the agents it's meant to cover. Don't re-propose this without first changing how those agents receive their input data.
