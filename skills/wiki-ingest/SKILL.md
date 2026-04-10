---
name: wiki-ingest
description: "Ingest a source into the vault knowledge base. ALWAYS use this skill when the user shares a paper, article, URL, arXiv link, project, or any research finding they want to save. Activate when the user pastes an arXiv ID, shares a URL, says \"add this to the vault\", \"I found this interesting\", \"save this\", \"remember this\", or asks you to look at a paper. Also activate when the user describes a specific finding, technique, or project they want captured. Do NOT activate for general conversation about topics — only when there's explicit save intent or a concrete source (URL, paper ID, pasted content) to ingest."
---

# Wiki Ingest

Transform raw sources (papers, articles, projects, conversations) into structured vault notes with concept extraction, MOC linking, and automatic cross-referencing.

## Why This Skill Exists

The vault's value comes from interconnected knowledge, not isolated notes. Every source that enters the vault needs: a structured note following the schema, concept notes for key ideas, links to relevant MOCs, and proper frontmatter. This skill handles the entire pipeline so the user just shares a source and everything gets wired up.

## Source Types

Read `${CLAUDE_SKILL_DIR}/references/source-types.md` for detailed per-type handling. The high-level flow:

**Source type routing** — detect before doing anything else:
- Path or filename contains `raw/` → **technical-report flow** (skip paper-analyzer entirely)
- Input contains arXiv ID pattern (`\d{4}\.\d{4,5}`) or `arxiv.org` or `huggingface.co/papers` → **paper flow**
- Input is an HTTP URL (not arXiv, not PDF) → **web article flow**
- User describes a finding without a URL → **conversation/direct input flow**

### Papers (arXiv IDs, PDFs, academic URLs)

Papers get the deepest treatment because they're the densest sources.

1. **Detect arXiv ID** from input (patterns: `2501.12345`, `arxiv.org/abs/...`, `huggingface.co/papers/...`)
2. **Chain to paper-analyzer skill** — this handles PDF download, smart extraction, multi-agent analysis, and quality scoring. It produces a rich markdown analysis document.
3. **Transform analysis into vault source note**: Take the paper-analyzer output and create a source note following the vault schema. The source note is more structured and interconnected than a raw analysis.
4. Continue with post-creation steps below.

### Web Articles / Patch Notes / Blog Posts

1. **Fetch content**: Use WebFetch to retrieve the URL
2. **Synthesize source note**: Extract key findings, techniques, or information
3. **Determine domain**: Match against existing domains by topic. If no domain matches, ask the user or hand off to wiki-domain.

### Coding Projects

1. **Read key files**: README.md, CLAUDE.md, package.json, key source files
2. **Synthesize**: Architecture, patterns, key decisions, dependencies
3. **Place in**: `{structure.sources}/` or a dedicated projects directory — check vault CLAUDE.md Vault Structure section for the actual path

### Conversations / Direct Input

When the user describes something they learned or discovered:
1. **Structure into source note**: Extract the core finding or technique
2. **Ask for clarification** if the domain or context is unclear

## Creating the Source Note

First, resolve the vault path and structure:
```bash
VAULT_PATH=$(cat ${CLAUDE_PLUGIN_ROOT}/.vault-path 2>/dev/null)
CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT:-$(cat "$VAULT_PATH/.wiki/plugin-root" 2>/dev/null)}
```

Then read `$VAULT_PATH/.wiki/config.json` with the Read tool to get `structure.sources`, `structure.concepts`, and `structure.mocs`. Use these paths for all file placement — never assume `02 - Areas/Research` or any other path.

Place the note in the correct domain directory:
```
$VAULT_PATH/{structure.sources}/{Domain Name}/{Paper Title}.md
```

### Frontmatter (required)

```yaml
---
tags: [paper, topic1, topic2]
cssclasses: []
created: 'YYYY-MM-DD'
concepts:
  - '[[Concept Name]]'
mocs:
  - '[[MOC Name]]'
builds_on:        # optional — papers/concepts this extends
  - '[[Paper]]'
compares_with:    # optional — papers this is compared against
  - '[[Paper]]'
uses_method:      # optional — methods employed
  - '[[Method]]'
---
```

### Body Structure

```markdown
# Paper Title

**Authors:** Author List
**arXiv:** ID (if applicable)
**Published:** Year, Venue

## Summary
2-3 paragraph overview...

## Key Contributions
- Contribution 1
- Contribution 2

## Methodology
Overview of approach...

## Results
Key findings with specific numbers...

## Connections
- Builds on [[Prior Work]]
- Related to [[Concept]]

## Notes
Personal observations...
```

## Concept Extraction

For each key concept mentioned in the source:

1. **Check if concept exists**: Grep `.wiki/concept-index.json` for the concept name, or Glob `{structure.concepts}/` (from config.json). Don't load the full index.
2. **If it exists**: Add it to the source note's `concepts:` frontmatter array
3. **If it doesn't exist**: Create a stub concept note:

```yaml
---
tags: [concept, wikilinks]
cssclasses: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# Concept Name

A concept related to wikilinks. *Definition pending - please update.*

## Papers Using This Concept
- [[Source Note Title]]

## Related Concepts
*To be added as more papers are analyzed*
```

Only create concepts for genuine noun-phrase concepts (e.g., "reinforcement learning", "layered memory"), not sentence fragments or incidental phrases.

## MOC Linking

1. Check existing MOCs in `.wiki/moc-index.json`
2. Add relevant MOCs to the source note's `mocs:` array
3. If no existing MOC fits, consider whether a new one is warranted (only if this domain has 3+ sources)

## Post-Creation Steps

After writing the source note and any new concept stubs:

1. **Validate** the source note frontmatter:
   ```bash
   commonplace validate --vault "$VAULT_PATH" "<file-path>"
   ```

2. **Rebuild index**:
   ```bash
   commonplace index --vault "$VAULT_PATH" --incremental
   ```

3. **Scope check**:
   ```bash
   commonplace scope-check --vault "$VAULT_PATH" "<file-path>"
   ```

4. **Dispatch agents** for Research/ files. Agents have isolated context — include `${CLAUDE_PLUGIN_ROOT}`, vault path, and relevant data inline in each prompt:
   - Dispatch `wiki-moc-updater` agent with the new source note path and its `mocs:` frontmatter list so it knows which MOCs to update
   - Dispatch `wiki-concept-linker` agent with the new source note path so it can scan for unlinked concept mentions

5. **Log**: append to `$VAULT_PATH/.wiki/log.md`:
   ```bash
   commonplace log --vault "$VAULT_PATH" --entry "## [$(date +%Y-%m-%d)] ingest | {Note Title}\n- Concepts: N new, N existing. MOCs: N linked.\n"
   ```

6. **Report**: Tell the user what was created (impact check and cross-domain analysis run automatically via hooks in the background):
   - Source note path
   - Number of concepts extracted (new + existing)
   - MOCs linked
   - Any stubs created (mention wiki-compile can fill them)
