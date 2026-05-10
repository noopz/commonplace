---
name: wiki-query
description: "ALWAYS use when the user asks a question answerable from vault notes — 'how does X relate to Y', 'what do the papers say about Z', 'compare approaches to W', or discussions of concept connections. Critically, also fire immediately after wiki-ingest when the user pivots from saving to asking how the new source relates to other vault topics — read the related notes, don't synthesize from index metadata. Files novel insights back into the vault."
---

# Wiki Query

Answer research questions by reading vault notes, then file novel insights back into the vault automatically. The vault gets smarter with every question asked.

## Why This Skill Files Back

Most knowledge bases are read-only — you search, you get an answer, nothing changes. This skill treats every query as an opportunity to strengthen the vault. If answering a question reveals a connection between two concepts that aren't linked, or surfaces a pattern across papers that isn't captured in any MOC, file it back. The user expects this — they don't want to manually update concept notes after every conversation.

## Workflow

### Step 0: Resolve vault path

Run `commonplace vault-path` to get the vault path. Use it in all paths below.

### Step 1: Search the vault

Never load full index files — they grow without bound. Use Grep to target specific entries.

**Tool budget**: Prefer Grep + Read for search. Reach for Bash only when necessary (e.g., counting, batch operations, or piping `commonplace` script output). Empirically, Grep + Read alone covers most query needs at a fraction of the tool count of full-bash exploration.

**Index schemas (JSONL — one JSON record per line, grep returns complete records):**
- `source-index.jsonl` — fields: `title`, `path`, `domain`, `scope`, `tags`, `concepts`, `mocs`
- `concept-index.jsonl` — fields: `name`, `path`, `domains`, `backlinkCount`, `isStub`

**Search strategy:**

1. **Start with Grep on the indexes** using terms from the user's question:
   ```
   Grep "<term>" "$VAULT_PATH/.wiki/source-index.jsonl"
   Grep "<term>" "$VAULT_PATH/.wiki/concept-index.jsonl"
   ```

2. **Iterate with derived terms** — look at what you find and generate new search terms from it. If a source note mentions [[Concept X]], grep for that. If a concept appears in two domains, grep for it in both. Don't stop at the first pass.

3. **Traverse the graph** — concepts are nodes, wikilinks are edges. Once you've found a relevant entry-point note, expand the cluster using hub detection, edge-following, MOC entry, citation chains, and bridge-concept analysis. For the full set of traversal patterns and when to use each, read `references/graph-traversal.md`.

4. **Grep vault notes** for terms not caught by the index — use the Grep tool with your search term, path set to the vault, and glob `*.md`.

5. **Read relevant notes**: Once you find matches, read the full notes for context

### Step 2: Synthesize the answer

- Answer the user's question with specific references to vault notes
- Use `[[wikilinks]]` when mentioning vault concepts or papers
- Be specific — cite which paper said what, with details
- If comparing: use a structured comparison (table or side-by-side)

### Step 3: Identify what to file back

Every query is an opportunity to strengthen the vault. While synthesizing, decide what to file:

**Always file concept connections** — if you found links not currently captured in concept notes:
1. Add to "Related Concepts" sections of relevant concept notes
2. Update `updated` date in frontmatter
3. Run scope-check on modified files:
   ```bash
   commonplace scope-check "<file>"
   ```

**File synthesis pages when warranted** — answers that draw on 3+ sources, reveal non-obvious connections, or produce structured comparisons are vault pages, not chat messages. If the answer required real synthesis work (comparison tables, cross-source analysis, cross-domain bridges), file it. For shorter answers that draw on 1-2 sources, mention that you could file it and let the user decide.

Good candidates:
- Comparison tables between papers or approaches
- Analysis of how a concept evolved across sources
- Cross-domain bridges surfaced during graph traversal
- Design explorations grounded in vault research
- Any answer the user might want to find again later

```yaml
---
tags: [synthesis]
created: YYYY-MM-DD
concepts:
  - '[[Concept A]]'
  - '[[Concept B]]'
mocs:
  - '[[Relevant MOC]]'
---
# {Descriptive Title}

{synthesis content — tables, analysis, connections}

## Sources
- [[Paper A]]
- [[Paper B]]
```

Path: check if a syntheses directory exists in the vault (e.g., `03 - Syntheses/` or similar). If not, create `$VAULT_PATH/03 - Syntheses/{Title}.md`.

### Step 4: File back and log

File everything identified in Step 3.

**Log**: append one entry:
```bash
commonplace log --entry "## [$(date +%Y-%m-%d)] query | {one-line question summary}\n- {what was found and filed back}\n"
```

### Step 5: Mention what was filed

At the end of your answer, briefly note any vault updates. Keep it short — one line per update. The user cares about the answer, not a detailed changelog.

## Example

**User**: "How does FinMem's memory system compare to TradingGPT?"

**Process**:
1. Read both paper notes from the vault
2. Compare their memory architectures
3. Synthesize: FinMem uses working/episodic/semantic layers; TradingGPT uses layered memory with distinct character profiles
4. Notice: both papers reference [[layered memory]] but the concept note doesn't mention [[character design]] as related → file back
5. Answer with comparison table + wikilinks
6. Mention: "Updated [[layered memory]] to note its connection to [[character design]]"

## Retired Entities

When a query lands on a note with a `retired` tag, a `> [!warning] Retired` callout, or a filename starting with `(Retired) `, answer the question but flag it: "Note: [[X]] is retired (superseded by [[Y]]). Treat this as historical." If you find live-prose mentions of the retired entity in *other* notes during graph traversal, surface them to the user and recommend running `wiki-supersede --check` to clear the debt. Do not silently rewrite siblings — route to `wiki-supersede`.

## Scope Rules

When filing back connections:
- Public-scoped concepts can link freely across public domains
- Private/custom-scoped concepts must stay isolated within their domain
- Run scope-check after any modifications to catch violations
