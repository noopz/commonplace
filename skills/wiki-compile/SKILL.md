---
name: wiki-compile
description: "Fill concept stubs with citation-grounded definitions. Use when user says 'fill in the stubs', 'compile concepts', 'flesh out concepts', or as follow-up after wiki-lint reports stubs. Do NOT use for new sources not yet in vault — that's wiki-ingest."
---

# Wiki Compile

Transform concept stubs ("Definition pending") into complete concept notes by reading the source papers that reference them and synthesizing real definitions.

## Why Stubs Exist

When wiki-ingest creates a source note, it extracts concepts and creates stub notes for any that don't exist yet. Stubs are placeholders that say "Definition pending - please update." They're intentional — creating a proper definition requires reading the source papers, which is expensive. This skill does that batch compilation efficiently.

## Workflow

### Step 0: Resolve vault path

Run `commonplace vault-path` to get the vault path. Use it in all commands and paths below.

### Step 1: Find stubs

```bash
commonplace lint --check stubs
```

Or if the user names specific concepts, just check those files directly.

### Step 2: Filter out malformed names

Before compiling, check each stub name. Skip any that look like sentence fragments:
- Names with 5 or more words
- Names that end with prepositions, articles, or conjunctions
- Names that don't look like real noun-phrase concepts

Flag skipped names to the user: "Skipping 'Context File Quality Directly Impacts' — looks like a sentence fragment, not a concept name. You may want to delete or rename these."

### Step 3: Compile each stub

For each valid stub:

1. **Find referencing sources**: Grep `.wiki/source-index.jsonl` for the concept name — sources that list it in their `concepts` array will have it on adjacent lines. Don't load the full index.
   ```
   Grep "<concept name>" "$VAULT_PATH/.wiki/source-index.jsonl"
   ```
   Also check `backlinkCount` in `concept-index.jsonl` (Grep for the concept name) — high backlink counts mean the concept is referenced widely across the corpus and deserves a richer definition.
2. **Read those source notes**: Understand how the concept is used in context
3. **Synthesize a definition**: Write a real definition based on how the concept appears across sources
4. **Record source hashes**: For each source note cited, record its current commit in the `compiledFrom` frontmatter array so staleness can be detected later:
   ```bash
   git -C "$VAULT_PATH" log -1 --format=%H -- "<source note's vault-relative path>"
   ```
   If the vault isn't a git repo (the command errors or prints nothing), omit `compiledFrom` entirely rather than writing a placeholder hash.

### What a Good Concept Note Looks Like

Reference: a compiled concept note in `$VAULT_PATH/.wiki/concept-index.jsonl`

```markdown
---
tags: [concept, wikilinks]
cssclasses: []
created: 2025-11-07
updated: 2026-04-04
compiledFrom:
  - path: 01 - Sources/Foo.md
    hash: <git commit hash of Foo.md at compile time>
---

# Concept Name

One paragraph definition explaining what this concept is, written clearly enough that someone unfamiliar with the specific papers could understand it.

**Key Characteristics:**
- Characteristic 1
- Characteristic 2
- Characteristic 3

## Papers Using This Concept
- [[Paper Name 1]]
- [[Paper Name 2]]

## Related Concepts
- [[Related Concept 1]]
- [[Related Concept 2]]
```

### Writing Style

- **Be specific**: "A memory architecture with separate working, episodic, and semantic layers" not "A type of memory system"
- **Ground in the papers**: The definition should reflect how the concept is actually used in the vault's sources
- **Keep it concise**: One paragraph for the definition, bullet points for characteristics
- **Update the `updated` date** in frontmatter to today's date
- **List all referencing papers** in the Papers section

### Step 4: Post-compilation

After writing a compiled concept:
- Run `commonplace link --target "<concept name>"` to insert wikilinks for the new concept across any source notes that mention it but don't link it. Deterministic — safe to run without review.

### Batch Control

- **Default**: Compile up to 5 stubs per invocation
- **If user says "all"**: Compile all valid stubs (can be many — warn if >20)
- **If user names specific concepts**: Compile just those, e.g., `$ARGUMENTS` = "ReAct and behavioral cloning"

### Step 5: Report

Tell the user:
- How many stubs were compiled
- How many were skipped (malformed names)
- Any stubs with zero backlinks (orphan concepts that may not need definitions)
