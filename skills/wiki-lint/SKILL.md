---
name: wiki-lint
description: "Run vault health checks and report issues. Use this skill when the user asks about vault quality, broken links, stubs, orphans, or says \"how's the vault looking\", \"anything need fixing\", or \"what needs fixing\". Also auto-activate after ingesting multiple sources to report on overall health. This skill diagnoses and reports — if the user wants autonomous multi-round fixing, hand off to autoimprove instead."
---

# Wiki Lint

Run a comprehensive health audit on the Obsidian vault and automatically fix mechanical issues.

## Why This Skill Exists

The vault accumulates entropy over time — broken links from renamed notes, stale MOC counts, stub concepts that never got filled in, malformed date artifacts from earlier tooling. This skill surfaces all of those issues in one report and fixes what it can mechanically, so the user only needs to deal with issues that require human judgment.

## Workflow

### Step 0: Resolve vault path

Run `commonplace vault-path` to get the vault path. Use it in all commands below.

### Step 1: Rebuild indexes

Indexes may be stale. Run a full rebuild to ensure accurate lint results:

```bash
commonplace index
```

### Step 2: Run lint

```bash
commonplace lint
```

This produces JSON with all issues organized by severity:
- **critical**: Broken wikilinks, frontmatter errors, scope violations, malformed dates
- **improvement**: Stubs, stale MOC counts, duplicate entries, near-duplicate concept names
- **suggestion**: Orphan notes, malformed concept names (sentence fragments)

### Step 3: Present the report

Show a concise summary to the user. Example:

```
Vault Health Report:
- 23 critical issues (12 broken links, 8 malformed dates, 3 frontmatter errors)
- 57 improvements (52 stubs, 3 stale MOCs, 2 near-duplicate concepts)
- 14 suggestions (12 orphans, 2 malformed names)
- 33 issues are auto-fixable
```

### Step 4: Auto-fix mechanical issues

Dispatch the `wiki-linter` agent to fix everything that's mechanical:
- Remove malformed date lines (`P25-11-07` artifacts)
- Update stale MOC paper counts
- Remove duplicate frontmatter entries
- Add missing required tags

Agents have isolated context windows — they cannot see this conversation. Include the vault path and lint results inline in the agent prompt so it knows exactly what to fix.

### Step 5: Report and recommend

After fixes:
- Report what was fixed
- If stubs exist, mention that wiki-compile can fill them: "There are 52 concept stubs. Say 'fill in the stubs' to compile real definitions from the source papers."
- If there are near-duplicate concept names, list them for the user to decide which to merge

### Step 6: Suggest research directions

After the mechanical report, surface actionable intelligence from the vault's shape:

**High-value stubs** — concept stubs with high `backlinkCount` are the most-referenced unknown concepts in the corpus. For the top 3-5:
```
Grep "isStub.*true" in concept-index.jsonl (path set to $VAULT_PATH/.wiki/concept-index.jsonl)
```
Sort by `backlinkCount` descending. For each, suggest: *"[[ConceptName]] is referenced N times but has no definition. Suggested search: ..."*

**Bridge concepts** — concepts appearing in 2+ domains (`domains` array length > 1) are cross-domain connectors worth deepening. Mention the top 2-3 and which domains they bridge.

**Orphaned clusters** — if orphan notes exist, check whether they share concepts with non-orphan notes. If so, they're disconnected from the graph but not truly isolated — suggest adding wikilinks to reconnect them.

**Semantic contradictions** (when there's time/budget) — read the top 5-10 concept notes by `backlinkCount` and check for conflicting definitions or claims that newer sources in the vault may supersede. Flag any contradictions for the user to resolve. This is a main-model operation, so only do it on explicit request or when the user asks for a "deep lint."

**Log**: append to `$VAULT_PATH/.wiki/log.md`:
```bash
commonplace log --entry "## [$(date +%Y-%m-%d)] lint | Full audit\n- Critical: N, Improvements: N, Suggestions: N. Fixed: N mechanical.\n"
```

## Running Individual Checks

The user can ask about specific checks:
```bash
commonplace lint --check stubs
```

Valid check names: `unresolved`, `stubs`, `orphans`, `frontmatter`, `moc-staleness`, `scope-violations`, `duplicates`, `malformed-dates`, `near-duplicate-names`, `malformed-concept-names`
