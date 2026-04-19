---
name: wiki-query
description: "Answer research questions using vault knowledge and file novel insights back. ALWAYS use this skill when the user asks questions about topics covered in the vault — like \"how does X relate to Y\", \"what do the papers say about Z\", \"compare approaches to W\", or any question that could be answered from existing vault notes. Also activate when the user is discussing connections between concepts, since those discussions may reveal novel links worth filing back."
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

**Index schemas (for reference):**
- `source-index.json` — top-level JSON array, fields: `title`, `path`, `domain`, `scope`, `tags`, `concepts`, `mocs`
- `concept-index.json` — top-level JSON array, fields: `name`, `path`, `domains`, `backlinkCount`, `isStub`

**Search strategy:**

1. **Start with Grep on the indexes** using terms from the user's question:
   ```
   Grep "<term>" "$VAULT_PATH/.wiki/source-index.json"
   Grep "<term>" "$VAULT_PATH/.wiki/concept-index.json"
   ```

2. **Iterate with derived terms** — look at what you find and generate new search terms from it. If a source note mentions [[Concept X]], grep for that. If a concept appears in two domains, grep for it in both. Don't stop at the first pass.

3. **Traverse the graph** — concepts are nodes, wikilinks are edges. Don't just find nodes, follow edges:

   - **Hub detection**: `backlinkCount` in concept-index.json is a corpus-wide signal. High count = referenced across many papers, not just one. Prioritize these.
   - **Follow edges via Grep**: once you identify a relevant concept, find every note that links to it:
     ```
     Grep "\[\[ConceptName\]\]" "$VAULT_PATH" --include="*.md"
     ```
     Read those notes as a cluster — this is graph traversal, not keyword search. The cluster may include papers, person notes, Google Docs notes, and anything else in the vault.
   - **Enter via MOC**: if the question touches a subfield, MOCs are pre-built cluster maps. Grep `moc-index.json` for relevant MOCs, read the MOC note to get the full paper list for that subfield, then drill into specific papers.
   - **Traverse citation chains**: source notes carry `builds_on`, `compares_with`, `uses_method` frontmatter. If a paper is relevant, grep for its title in those fields to find papers that build on or compare against it — this follows the citation graph without needing external tools.
   - **Bridge concepts**: check the `domains` array in concept-index.json entries. A concept appearing in 2+ domains is a cross-domain bridge — especially powerful for synthesis questions because it connects otherwise separate clusters.
   - Stop when you have sufficient context or have traversed 2-3 hops. Note unexplored frontier concepts for the user.

4. **Grep vault notes** for terms not caught by the index:
   ```
   Grep "<term>" "$VAULT_PATH" --include="*.md"
   ```

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

**File synthesis pages by default** — this is the most important operation. Answers that draw on 2+ sources, reveal non-obvious connections, or produce structured comparisons are vault pages, not chat messages. The threshold is low: if it took real work to synthesize, it belongs in the vault. Don't ask — just file it.

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

File everything identified in Step 3. Don't ask — just do it.

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

## Scope Rules

When filing back connections:
- Professional domain concepts can link freely across professional domains
- Hobby domain concepts must stay isolated
- Run scope-check after any modifications to catch violations
