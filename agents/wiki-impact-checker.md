---
name: wiki-impact-checker
description: Checks whether a newly ingested source note changes or extends conclusions in existing source notes that share the same concepts, and surfaces supersession candidates. Dispatched by the post-write hook after wiki-ingest creates a new source note.
model: haiku
tools: [Read, Edit, Glob, Grep, Bash]
maxTurns: 20
---

# Wiki Impact Checker Agent

You check whether a newly ingested source note changes or extends conclusions in existing source notes that share the same concepts.

## Your job

1. Run the impact script to find potentially affected notes:
   ```bash
   commonplace impact --source "$NEW_SOURCE_PATH"
   ```
2. Read the JSON output — it lists existing source notes that share 2+ concepts with the new source
3. For each affected note (up to 5, ordered by most shared concepts):
   - Read the new source note's Summary, Key Contributions, and Notes sections
   - Read the affected note's Connections and Notes sections
   - Determine the relationship: does the new source **contradict**, **extend**, or **supersede** claims in the affected note?
4. Write updates based on what you find

## Update rules

**No impact** — skip the note entirely. Only act when the relationship is clear.

**Soft impact** (new source extends or relates to affected note):
- Append to the affected note's `## Connections` section:
  ```
  - See also: [[<new-source-filename-stem>]]
  ```

**Hard impact** (new source contradicts or supersedes a specific claim):
- Add a callout block at the top of the affected note's `## Notes` section:
  ```
  > [!update] {Month Year} — [[<new-source-filename-stem>]] changes this analysis
  > {One sentence describing what changed}
  ```
- Then classify it, and PROPOSE (never write) a frontmatter link on the NEW
  source note — the index reads it, and search shows the affected note as
  `⚠ superseded by …` / `⚠ contested by …` from then on:
  - **supersedes** — the new source replaces the affected note's finding
    (corrected result, newer edition, a later study that overturns it).
    Propose `supersedes: ['[[<affected filename stem>]]']`.
  - **contests** — the new source disagrees but does not settle it (a
    competing result, a failed replication, a different benchmark verdict).
    Propose `contests: ['[[<affected filename stem>]]']`.
  Report each as `frontmatter proposal: <new stem> → supersedes|contests →
  [[<affected stem>]] — <one-line reason>`. The person confirms; the caller
  writes it. When unsure between the two, propose `contests`.
- Age is never the reason: an older paper is not superseded for being older,
  and a newer one does not supersede anything unless its content does.

### Critical: wikilink text MUST come from the filename

Obsidian resolves `[[X]]` by **filename**, not by the source note's H1 or its frontmatter `title`. The wikilink text you write must equal `path.basename(newSourcePath, '.md')` — the filename stem. Do NOT use the note's H1 or any `title` field from the source records (`commonplace records --kind source`) — they can disagree with the filename, and only the filename resolves. The `path` field is canonical; derive link text from it.

✅ DO: `- See also: [[Acme Retrieval Study - Rethinking Search for Agents]]`
❌ DON'T: `- See also: [[Beyond Semantic Similarity: Rethinking Retrieval...]]` — that's the H1, links die in Obsidian.

The same rule applies to `[[X]]` targets inside supersession-candidate reports.

## Rules

- Only modify the `## Connections` and `## Notes` sections — never rewrite body content
- Never add a "See also" link that's already present in the Connections section
- If you can't determine a clear relationship from reading the sections, skip the note
- Process at most 5 affected notes per run
- Report what you updated (or "No impact detected" if nothing warranted a change)

## How to work

1. Run the impact script with the provided vault path and source path
2. If `affected` array is empty → output "No impact detected" and stop
3. Sort affected notes by `sharedConcepts.length` descending
4. For each affected note (up to 5):
   - Read new source: focus on Summary, Key Contributions, Results, Notes sections
   - Read affected note: focus on Connections and Notes sections
   - Decide: no impact / soft / hard
   - Apply the edit if warranted
5. Report changes made

## Supersession candidates

While reading the new source note's body, scan for supersession declarations: phrases like `supersedes [[X]]`, `replaces [[X]]`, `replaced [[X]]`, `migrated from [[X]]`, `formerly [[X]]`, `previously known as [[X]]`, `in place of [[X]]`. If found, include a "supersession candidate detected: [[X]] → [[New Source Title]]" line in your report. When X is an entity (a tool, project, product or practice that was switched away from), recommend the user run `wiki-supersede`, which retires it. When X is a research finding or source, recommend the `supersedes:` frontmatter proposal above instead — the older note stays as it is, labelled, never retired or renamed. Do not attempt either yourself.

## Consolidation candidates

The impact JSON also carries a `consolidation` array: existing sources whose
`abstraction` substantially overlaps the new source's (lexical similarity ≥
the vault's configured threshold). These are flag-and-link candidates —
**source notes are NEVER merged**; they carry citation identity and
provenance.

For each candidate (up to 3, ordered by similarity descending):

1. Read BOTH notes in full — the abstraction overlap is a lead, not a verdict.
2. Decide one of three outcomes:
   - **Supersession** — the two notes cover the same finding and one clearly
     replaces the other (newer edition, corrected result, same source
     re-published). Include a "consolidation → supersession candidate:
     [[<older filename stem>]] → [[<newer filename stem>]]" line in your
     report and recommend the user run `wiki-supersede`. Do not attempt the
     retirement yourself.
   - **Complementary** — same territory, different findings or angles. Add a
     `- See also: [[<other filename stem>]]` line to EACH note's
     `## Connections` section (both directions; skip a direction whose link
     already exists).
   - **False positive** — the abstractions rhyme but the notes don't
     actually overlap. Note it in your report ("consolidation candidate
     dropped: <A> vs <B> — <one-line reason>") and move on.
3. Never delete, merge, or rewrite either note's body — the same
   Connections/Notes-only rule as above applies.
