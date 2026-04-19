---
name: wiki-init
description: "Initialize or reconfigure the wiki plugin for a folder of markdown files. Activate when the user says 'set up the wiki', 'initialize for this vault', 'configure the plugin', 'point the plugin at this vault', 'this is my knowledge depot', 'use this folder', 'set this up here', or when scripts fail because no .vault-path exists."
---

# Wiki Init

Initialize the wiki plugin for any folder of markdown files — an Obsidian vault, a plain directory, or anything in between. Detects structure automatically and writes the config files needed for all other skills to work.

Obsidian is not required. The plugin works on any folder of `.md` files with YAML frontmatter and `[[wikilinks]]`. Obsidian is just a good browser for this format if the user has it.

## What This Does

1. Detects vault structure by sampling frontmatter tags (`paper`, `concept`, `moc`) across up to 200 notes
2. Writes `.wiki/config.json` in the vault with detected structure, stub pattern, and MOC count pattern
3. Writes `.vault-path` to `CLAUDE_PLUGIN_DATA` (persistent across plugin updates) so all commands auto-discover the vault
4. Generates or updates vault `CLAUDE.md` with a domain registry sentinel block

## Workflow

### Step 1: Identify the folder

Resolution order:
1. **Explicit path**: user said "use `/path/to/folder`" → use that
2. **Current directory**: user said "this folder", "here", "this is my knowledge depot", or similar → use `pwd` (run `pwd` to get the absolute path)
3. **Discovery**: check if cwd or a parent has `.obsidian/` or `.wiki/` → use that
4. **Ask**: if none of the above, ask the user which folder to use

Any folder works — no Obsidian required. If the folder is empty or has no existing notes, that's fine: the plugin will initialize a skeleton structure.

### Step 2: Run init

```bash
commonplace init --vault "<vault-path>"
```

Read the JSON output directly — it reports what was written and flags any low-confidence detections.

### Step 3: Handle low-confidence detections

If the output includes `lowConfidence` entries, review them with the user:
- Show the detected value
- Ask if it's correct or if they want to override
- If override needed, edit `.wiki/config.json` directly to correct the value

### Step 4: Add domains (if new vault)

If the vault CLAUDE.md was newly generated, the domain registry will have skeleton entries detected from subdirectories. Review with the user:
- Show what was detected
- Ask if scope should be `professional` or `hobby` for any unclear domains
- Edit `$VAULT_PATH/CLAUDE.md` to correct scopes or add missing domains

### Step 5: Run initial index

```bash
commonplace index --vault "<vault-path>"
```

### Step 6: Report

After init, the vault path is stored in `CLAUDE_PLUGIN_DATA` (persistent directory that survives plugin updates). All `commonplace` commands auto-discover the vault — no `--vault` flag needed.

Tell the user:
- Vault path that was configured
- Structure detected (sources/concepts/mocs directories)
- Whether CLAUDE.md was generated or updated
- Any domains detected
- How to update config later: re-run `init.ts` or edit `.wiki/config.json` directly
