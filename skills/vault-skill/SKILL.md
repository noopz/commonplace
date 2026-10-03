---
name: vault-skill
description: Run one of the vault owner's own trusted skills (kept in the vault under .wiki/skills/) from any project. Use when the user names a vault skill or asks to "run <name> from my vault".
argument-hint: <skill-name> [arguments]
---

Run the vault skill named in: $ARGUMENTS

If no vault skill was delivered above, call `vault_skill` with no name to list the trusted ones, and tell the user which exist. Never read or edit files under `.wiki/skills/` yourself.
