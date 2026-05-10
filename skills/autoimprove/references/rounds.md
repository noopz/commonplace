# Round Playbook Reference

Detailed mechanics for each round category. The SKILL.md body lists priorities and the agent dispatch table; this file has the per-round specifics. Read once you know which round category you're about to execute.

All agents have isolated context windows. Every agent prompt **must** include the vault path as a literal string (e.g. "The vault is at /path/to/vault") so agents don't need to run `commonplace vault-path` themselves. Pass relevant data (lint results, file lists) inline in the prompt too.

## Mechanical fixes

Dispatch `commonplace:wiki-linter`. Include vault path and the lint output inline so it knows exactly what to fix.

## Pruning

Dispatch `commonplace:wiki-pruner`. Include vault path.

## MOC sync

Dispatch `commonplace:wiki-moc-updater`. Include vault path and the list of MOCs needing updates.

## Inline linking

Run `commonplace link` with no `--note` flag — that re-scans every source/concept/MOC note in the vault and adds wikilinks where bare mentions exist. Deterministic, idempotent (already-linked targets are skipped), structurally cannot corrupt frontmatter or splice mid-word.

**Why vault-wide, not just newly-ingested notes**: the post-write hook already runs `commonplace link --note <new-path>` on every ingest, so per-ingest linking is covered. Autoimprove's inline-linking round exists to catch the harder case — older notes that pre-date a concept's existence, or notes whose bodies grew organically after their initial linking pass. A vault-wide re-scan closes that gap and is cheap because the linker only needs grep-word-boundary matches, not LLM judgment.

For paraphrase-level link gaps that grep cannot catch (e.g., body text says "long-context reasoning" while the concept is named "long-horizon agents"), see the `concept-density-without-source-links` lint check, which surfaces candidates for the user to manually review with `commonplace deep-link`. **Autoimprove does not run `commonplace deep-link`** — it depends on Ollama embeddings and is opt-in only.

## Stub compilation

Execute wiki-compile's workflow inline (this runs at main-model cost, not Haiku). Read source notes that reference the stub, synthesize a definition, write the compiled concept note. **Cap at 5 stubs per round.**

## Semantic audit

Run at main-model cost. Steps:

1. Read the top 10–15 concept notes by `backlinkCount` (these are the corpus's most-referenced ideas).
2. **Contradiction detection**: look for concept notes with conflicting definitions, or source notes claiming different things about the same concept. Flag contradictions in the concept note's body under a `## Conflicting Claims` section for the user to resolve.
3. **Synthesis gap detection**: look for concept pairs that frequently co-occur in source frontmatter (`concepts:` arrays) but have no synthesis note connecting them. A pair appearing together in 5+ source notes is a strong signal.
4. **Generate synthesis pages**: for the top 1–2 synthesis gaps, generate a new vault page at `$VAULT_PATH/03 - Syntheses/{Title}.md` with a comparison or analysis. Cap at 2 per round (expensive).
5. Run scope-check on any new synthesis pages.

## Cross-domain synthesis

Only run if current score ≥ 70. Run at main-model cost. Steps:

1. Run the cross-domain script: `commonplace cross-domain --since <last-autoimprove-date>`.
2. If no results with cross-domain hits → skip this round entirely.
3. For each cross-domain hit (up to 3): read both the new source note and the affected existing notes.
4. Determine: does the new source meaningfully change conclusions in the existing notes?
5. **Soft change**: update the existing note's `## Notes` section with a cross-reference callout.
6. **Hard change** (substantive — different domain conclusions conflict or merge): create a new Relationship note — check vault CLAUDE.md for the Relationships directory path, or place at `$VAULT_PATH/{structure.sources}/../Relationships/{Title}.md` relative to sources documenting the cross-domain connection.
7. Run scope-check on any new Relationship notes.

## Freshness check (post-loop, Tier 2 Haiku)

Run after the score-gated rounds complete (regardless of final score):

```bash
commonplace freshen --sample 5
```

If `candidates` array is non-empty, dispatch `commonplace:wiki-freshness-checker` agent with the candidates JSON and vault path inline. The agent WebFetches each URL, compares to the note's Summary, and adds a `> [!stale]` callout to notes whose source content has substantially changed. Skip entirely if no candidates returned.

This runs outside the score loop because staleness checking doesn't affect any vault score dimension — it's a maintenance step, not a quality improvement.
