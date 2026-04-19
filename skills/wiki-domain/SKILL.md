---
name: wiki-domain
description: "Create or manage research domains in the vault. Activate when the user wants to start researching a new topic area, mentions a new field of interest, or asks about what domains exist. Note: wiki-ingest's body will explicitly hand off to this skill if no matching domain exists — wiki-domain should NOT speculatively activate on ingest-related prompts."
---

# Wiki Domain

Create and manage research domains in the Obsidian vault. Domains are directory-based organizational units that group related source notes, with scope rules controlling cross-pollination.

## Why Domains Matter

Every source note lives in a domain subdirectory under the vault's configured sources path (read from `.wiki/config.json` → `structure.sources`). Domain is never stored in frontmatter — it's inferred from the file path. This means creating a new domain is just creating a new directory + registering it in the vault's CLAUDE.md.

Professional domains (AI research, trading, coding) can share concepts freely. Hobby domains (games, cooking) are isolated — their concepts don't leak into professional work.

## Listing Existing Domains

First, run `commonplace vault-path` and `commonplace config` to get the vault path and structure. Use `structure.sources` and `structure.mocs` for all directory creation — never assume any specific path.

Read the domain registry from `$VAULT_PATH/CLAUDE.md` — look for the block between `<!-- DOMAIN_REGISTRY_START -->` and `<!-- DOMAIN_REGISTRY_END -->`.

Also show stats from the index:
```bash
commonplace index --incremental
```

Parse `domain-index.jsonl` from `.wiki/` to show source and concept counts per domain.

## Creating a New Domain

When the user wants a new domain:

1. **Ask for name and scope**. Name should be kebab-case (e.g., `home-automation`, `poe2-builds`). Scope is `professional` or `hobby`. If unsure, default to `professional` for technical topics, `hobby` for games/entertainment.

2. **Create the directory**:
   ```
   $VAULT_PATH/{structure.sources}/{Domain Name}/
   ```
   Use the human-readable name with spaces for the directory (e.g., "Home Automation"), not the slug.

3. **Update the domain registry** in `$VAULT_PATH/CLAUDE.md`:
   Add a new entry between the sentinel comments:
   ```yaml
     new-domain-slug:
       path: "{structure.sources}/New Domain Name"
       scope: professional
   ```

4. **Optionally create a starter MOC**:
   ```
   $VAULT_PATH/{structure.mocs}/{Domain Name} MOC.md
   ```
   With appropriate frontmatter:
   ```yaml
   ---
   tags: [moc, domain-slug]
   cssclasses: []
   created: YYYY-MM-DD
   ---
   ```

5. **Rebuild indexes**:
   ```bash
   commonplace index
   ```

## Example

User: "I want to start tracking POE2 builds"

→ Create directory `{structure.sources}/POE2 Builds/`
→ Add to registry: `poe2-builds: { path: "{structure.sources}/POE2 Builds", scope: hobby }`
→ Create `{structure.mocs}/POE2 Builds MOC.md`
→ Report: "Created POE2 Builds domain (hobby scope). It's isolated — concepts won't cross into your professional research."
