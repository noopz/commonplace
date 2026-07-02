---
name: wiki-domain
description: "Set up, list, rename, or merge research domains. Use when user says 'add a domain for X', 'set up a domain', 'what domains exist', 'change scope of X domain', 'merge X and Y domains'. Do NOT speculatively fire on ingest prompts — wiki-ingest hands off explicitly when no domain matches."
---

# Wiki Domain

Create and manage research domains in the Obsidian vault. Domains are directory-based organizational units that group related source notes, with scope rules controlling cross-pollination.

## Why Domains Matter

Every source note lives in a domain directory. Domain is inferred from the file path via `.wiki/domains.json`. Each domain has a `scope` (`public` or `private`) and an optional `linkGroup`.

**Linking rules:**
- **Public** domains can share concepts freely with all other public domains
- **Private** domains are isolated — no cross-linking outside the domain
- **linkGroup** overrides isolation: domains sharing a `linkGroup` can cross-link bidirectionally, regardless of scope. Use this for related private domains (e.g., worldbuilding subdomains that should see each other's concepts)
- A **public** domain in a linkGroup bridges the group to the outside — it can link globally AND within its group

Notes can override their domain's scope with `scope: private` in frontmatter (e.g., a sensitive note in a public domain).

## Listing Existing Domains

First, run `commonplace vault-path` and `commonplace config` to get the vault path and structure. Use `structure.sources` and `structure.mocs` for all directory creation — never assume any specific path.

Read the domain registry from `$VAULT_PATH/.wiki/domains.json`.

Also show stats from the index:
```bash
commonplace index --incremental
```

Parse `domain-index.jsonl` from `.wiki/` to show source and concept counts per domain.

## Creating a New Domain

When the user wants a new domain:

1. **Ask for name, scope, and linkGroup**. Name should be kebab-case (e.g., `home-automation`, `retro-consoles`). Scope is `public` or `private`. If unsure, default to `public` for technical topics, `private` for personal/hobby topics. If the domain is related to other private domains, ask which linkGroup it belongs to.

2. **Create the directory**:
   ```
   $VAULT_PATH/{structure.sources}/{Domain Name}/
   ```
   Use the human-readable name with spaces for the directory (e.g., "Home Automation"), not the slug.

3. **Update the domain registry** in `$VAULT_PATH/.wiki/domains.json`:
   Add a new entry to the `domains` object:
   ```json
   "new-domain-slug": { "path": "{structure.sources}/New Domain Name", "scope": "public", "linkGroup": "optional-group" }
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

User: "I want to start tracking retro console restorations"

→ Create directory `{structure.sources}/Retro Consoles/`
→ Add to `.wiki/domains.json`: `"retro-consoles": { "path": "{structure.sources}/Retro Consoles", "scope": "private" }`
→ Create `{structure.mocs}/Retro Consoles MOC.md`
→ Notes in this domain should have `scope: private` in frontmatter
→ Report: "Created Retro Consoles domain (private scope). It's isolated — concepts won't cross into your public research. If you later add related hobby domains, I can group them with a linkGroup so they share concepts."
