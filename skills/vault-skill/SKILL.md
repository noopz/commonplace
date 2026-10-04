---
name: vault-skill
description: Run one of the vault's own Claude Code skills (its .claude/skills/, e.g. a YouTube or project intake) from a session started outside the vault. Use when the user names a vault skill or asks to "run <name> from my vault".
argument-hint: <skill-name> [arguments]
---

Run the vault skill named in: $ARGUMENTS

If no vault skill was delivered above, call `vault_skill` with no name to list them, and tell the user which exist. A skill the user has not trusted yet asks them when called; never read its SKILL.md and follow it yourself — that would skip the question.
