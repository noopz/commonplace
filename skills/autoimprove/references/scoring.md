# Scoring & Cost Reference

Read this when the user asks what the score means, when you need to interpret per-dimension deltas, or when budget tradeoffs come up.

## The 0–100 vault score

Run `commonplace score` to compute. Output is human-readable by default; use `commonplace score --json` only to parse specific dimensions programmatically.

| Dimension | Weight | What it measures |
|-----------|--------|------------------|
| Integrity | 15 | Broken links, frontmatter errors, scope violations |
| Coverage | 15 | Concept definitions (vs stubs), note completeness (summary sections) |
| Graph Structure | 10 | Backlink density, orphan ratio, MOC coverage, concept extraction |
| Inline Linking | 15 | Vault note mentions in body text that are actually wikilinked |
| Summary Links | 15 | Summary/lead sections with front-loaded inline links |
| Frontmatter Coherence | 15 | Frontmatter concept entries with corresponding inline body links |
| Consistency | 5 | MOC count accuracy, no duplicates |
| Hygiene | 10 | Days since last commit |

## Cost profile per round

Each round category has different cost characteristics. Use this to advise the user when budget is a concern.

- **Rounds 1–2** (mechanical + MOC + linking): Cheap. Haiku agents, ~$0.01–0.02 per dispatch.
- **Round 3** (stub compilation): Moderate. Main model reads source notes and synthesizes. ~$0.10–0.50 depending on stub count and source length.
- **Round 4** (semantic audit): Expensive. Main model reads 10–15 full concept notes + source clusters. ~$0.50–2.00 depending on vault size. Skip if budget is tight.
- **Round 5** (cross-domain synthesis): Expensive. Main model reads cross-domain source pairs. ~$0.25–1.00. Only runs if score ≥ 70 and rounds ≥ 5.
- **Post-loop freshness check**: Cheap. Up to 5 WebFetches + Haiku comparison. ~$0.01–0.05 per run. Skipped if no eligible live-URL sources.

The default priority ordering ensures cheap wins happen first. If budget is tight, use `--rounds 2` to cap at mechanical fixes and pruning.
