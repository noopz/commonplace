---
name: autoimprove
description: "Autonomously improve vault quality using a score-gated improvement loop. Activate when the user says 'improve the vault', 'autoimprove', 'make the vault better', 'run the improvement loop', or asks 'what's the vault score'. Also activate when the user asks 'how can the vault be improved' or 'what needs fixing'. Shows the vault score at minimum, runs improvement rounds if there are actionable issues."
---

# Autoimprove

Autonomously improve vault quality by composing existing agents and skills into a score-gated loop. Inspired by Karpathy's autoresearch: modify → evaluate → keep/discard → repeat.

## Why This Skill Exists

The vault accumulates entropy — stubs, stale MOC counts, missing wikilinks, mechanical issues. Previously, every improvement required a human prompt. This skill picks the highest-impact improvement, executes it, measures the result, and repeats until the score plateaus or the budget runs out.

## The Score: vault-score.ts

The loop is gated by a deterministic 0-100 quality score with five dimensions:

| Dimension | Weight | What it measures |
|-----------|--------|------------------|
| Integrity | 25 | Broken links, frontmatter errors, scope violations |
| Coverage | 25 | % of concepts with real definitions (vs stubs) |
| Connectivity | 20 | Backlink density, orphan ratio, MOC coverage |
| Consistency | 15 | MOC count accuracy, no duplicates |
| Hygiene | 15 | Uncommitted changes, days since last commit |

## Workflow

### Step 0: Resolve vault path and git checkpoint

```bash
VAULT_PATH=$(commonplace vault-path)
```

If the vault is a git repo, create a safety checkpoint before starting:

```bash
cd "$VAULT_PATH" && git add --all '*.md' && git commit -m "autoimprove: checkpoint before run" --allow-empty 2>/dev/null || true
```

The user can `git diff HEAD~1` or `git reset HEAD~1` to review/revert.

### Step 1: Baseline

Rebuild indexes fresh (full, not incremental) and compute baseline score:

```bash
commonplace index --vault "$VAULT_PATH"
commonplace score --vault "$VAULT_PATH" --verbose
```

Show the baseline to the user:
```
Vault Score: 43.7/100 (F)
  integrity:    0.0/25  — 221 critical issues
  coverage:     2.9/25  — 46 stubs, 6 compiled
  connectivity: 18.4/20 — avg 2.06 backlinks, 0 orphans
  consistency:  14.3/15 — 1 stale MOC count
  hygiene:      8.1/15  — 71 dirty files, 0.5 days since commit
```

### Step 2: Plan improvements

Run lint to identify actionable issues:

```bash
commonplace lint --vault "$VAULT_PATH"
```

Categorize by priority (cheapest and highest-impact first):

1. **Mechanical fixes** (Tier 2, Haiku): malformed dates, stale MOC counts, duplicate frontmatter entries
2. **Pruning** (Tier 2, Haiku): remove low-value concept stubs and clean up their references
3. **MOC sync** (Tier 2, Haiku): MOCs missing source entries that reference them
4. **Concept linking** (Tier 2, Haiku): source notes mentioning concepts without wikilinks
5. **Stub compilation** (Tier 3, main model): fill concept stubs with real definitions — **cap at 5 stubs per round**, ordered by backlink count descending
6. **Semantic audit** (Tier 3, main model): read top concept notes by backlinkCount, detect contradictions and synthesis gaps, generate synthesis pages — **cap at 2 synthesis pages per round**
7. **Cross-domain synthesis** (Tier 3, main model): only if score ≥ 70. Identify concepts bridging multiple domains and check if recent sources have created connections worth surfacing.

Show the plan:
```
Found 228 improvable issues:
  Round 1: 5 mechanical fixes (Haiku) + 1 stale MOC (Haiku)
  Round 2: concept linking pass (Haiku)
  Round 3: compile top 5 stubs (main model)
  Round 4: semantic audit — top 10 concepts, identify contradictions + synthesis gaps (main model)
  Round 5: cross-domain synthesis — only if score ≥ 70 (main model)
```

### Step 3: Execute rounds

For each round (default max 3, configurable via `$ARGUMENTS` as `--rounds N`):

**Pick the highest-priority category with remaining issues** and execute:

All agents have isolated context windows — they cannot see this conversation. Every agent prompt must include the vault path so agents can run `commonplace` commands. Pass relevant data (lint results, file lists) inline in the prompt too.

- **Mechanical fixes**: Dispatch `wiki-linter` agent. Include vault path and the lint JSON output inline so it knows exactly what to fix. The agent uses Edit to fix files. The PostToolUse hook keeps indexes live after each edit — no manual rebuild needed.

- **Pruning**: Dispatch `wiki-pruner` agent. Include vault path. It runs `commonplace prune --execute` to delete low-value stubs (orphans, malformed names, overly specific 5+ word names), then cleans up references to deleted concepts via Edit.

- **MOC sync**: Dispatch `wiki-moc-updater` agent. Include vault path and the list of MOCs needing updates from lint results.

- **Concept linking**: Dispatch `wiki-concept-linker` agent. Include vault path and the list of source notes to scan.

- **Stub compilation**: Execute wiki-compile's workflow inline (this runs at main-model cost, not Haiku). Read source notes that reference the stub, synthesize a definition, write the compiled concept note. Cap at 5 stubs per round.

- **Semantic audit**: Run at main-model cost. Steps:
  1. Read the top 10-15 concept notes by `backlinkCount` (these are the corpus's most-referenced ideas)
  2. **Contradiction detection**: look for concept notes with conflicting definitions, or source notes claiming different things about the same concept. Flag contradictions in the concept note's body under a `## Conflicting Claims` section for the user to resolve.
  3. **Synthesis gap detection**: look for concept pairs that frequently co-occur in source frontmatter (`concepts:` arrays) but have no synthesis note connecting them. A pair appearing together in 5+ source notes is a strong signal.
  4. **Generate synthesis pages**: for the top 1-2 synthesis gaps, generate a new vault page at `$VAULT_PATH/03 - Syntheses/{Title}.md` with a comparison or analysis. Cap at 2 per round (expensive).
  5. Run scope-check on any new synthesis pages.

- **Cross-domain synthesis**: Only run if current score ≥ 70. Run at main-model cost. Steps:
  1. Run the cross-domain script:
     ```bash
     commonplace cross-domain --vault "$VAULT_PATH" --since <last-autoimprove-date>
     ```
  2. If no results with cross-domain hits → skip this round entirely.
  3. For each cross-domain hit (up to 3): read both the new source note and the affected existing notes.
  4. Determine: does the new source meaningfully change conclusions in the existing notes?
  5. **Soft change**: update the existing note's `## Notes` section with a cross-reference callout.
  6. **Hard change** (substantive — different domain conclusions conflict or merge): create a new Relationship note — check vault CLAUDE.md for the Relationships directory path, or place at `$VAULT_PATH/{structure.sources}/../Relationships/{Title}.md` relative to sources documenting the cross-domain connection.
  7. Run scope-check on any new Relationship notes.

After each round, re-score:

```bash
commonplace score --vault "$VAULT_PATH" --verbose
```

Show the delta:
```
Round 1 complete: 43.7 → 52.1 (+8.4)
  integrity:    0.0 → 6.3  (+6.3) — fixed 5 mechanical issues
  consistency: 14.3 → 15.0 (+0.7) — synced 1 stale MOC
```

**Stop conditions** (check after each round):
- **Score dropped**: `new_score < previous_score` → STOP with warning. Something went wrong.
- **Plateau**: `delta < 0.5` → stop, no more easy wins.
- **No issues remain**: all fixable issues resolved.
- **Budget exhausted**: reached max rounds.

### Post-loop: Freshness check (Tier 2, Haiku)

After the score-gated rounds complete (regardless of final score), run a freshness sample:

```bash
commonplace freshen --vault "$VAULT_PATH" --sample 5
```

If `candidates` array is non-empty, dispatch `wiki-freshness-checker` agent with the candidates JSON and vault path inline. The agent WebFetches each URL, compares to the note's Summary, and adds a `> [!stale]` callout to notes whose source content has substantially changed. Skip entirely if no candidates returned.

This runs outside the score loop because staleness checking doesn't affect any vault score dimension — it's a maintenance step, not a quality improvement.

### Step 4: Report

Show final results:

```
Autoimprove Complete
  Before: 43.7/100 (F)
  After:  62.3/100 (D)
  Delta:  +18.6

  Rounds executed: 3
  Changes:
    - Fixed 5 mechanical issues (malformed dates, stale counts)
    - Synced 1 MOC (Reinforcement Learning: 9→10)
    - Added 12 concept wikilinks across 8 source notes
    - Compiled 5 concept stubs (ReAct, behavioral cloning, ...)

  Remaining (needs human judgment):
    - 41 concept stubs (say "fill in the stubs" for more)
    - 221 broken wikilinks (path-prefixed, needs systematic fix)
    - 2 potential merge candidates (behavioral cloning + imitation learning)
```

If score history exists (`.wiki/score-history.json`), show trend:
```
Score trend:
  2026-04-04: 38.2
  2026-04-05: 43.7 → 62.3 (this session: +18.6)
```

### Log

Append a summary entry to `$VAULT_PATH/.wiki/log.md` after the run:
```bash
commonplace log --vault "$VAULT_PATH" --entry "## [$(date +%Y-%m-%d)] autoimprove | Score: {before} → {after}\n- Rounds: N. {Summary of changes}\n"
```

## What This Skill Does NOT Do

- Create new source notes (that's wiki-ingest)
- Create new domains (that's wiki-domain)
- Answer research questions (that's wiki-query)
- Delete notes or rename concepts (needs human judgment)
- Revert changes automatically (git checkpoint is for manual recovery)

## Cost Awareness

Each round has different cost profiles:
- **Rounds 1-2** (mechanical + MOC + linking): Cheap. Haiku agents, ~$0.01-0.02 per dispatch.
- **Round 3** (stub compilation): Moderate. Main model reads source notes and synthesizes. ~$0.10-0.50 depending on stub count and source length.
- **Round 4** (semantic audit): Expensive. Main model reads 10-15 full concept notes + source clusters. ~$0.50-2.00 depending on vault size. Skip if budget is tight.
- **Round 5** (cross-domain synthesis): Expensive. Main model reads cross-domain source pairs. ~$0.25-1.00. Only runs if score ≥ 70 and rounds >= 5.
- **Post-loop freshness check**: Cheap. Up to 5 WebFetches + Haiku comparison. ~$0.01-0.05 per run. Skipped if no eligible live-URL sources.

The priority ordering ensures cheap wins happen first. If budget is tight, use `--rounds 2` to only do mechanical fixes and pruning. The semantic audit round only runs if explicitly included or if rounds >= 4. Cross-domain synthesis only runs if score ≥ 70 and rounds >= 5.
