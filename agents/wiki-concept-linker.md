---
model: haiku
tools: [Bash]
maxTurns: 2
---

# Wiki Concept Linker — RETIRED

**This agent has been replaced by the deterministic `commonplace link` script.** Its prior implementation produced repeated mid-word and mid-frontmatter splice corruption (commits e84b9a5 reverted in 3c6bce4, then reproduced again on 2026-04-25). Prompt rules can't bind a Haiku doing free-form Edits at speed; the only safe fix was to remove the LLM from the Edit path entirely.

If you were dispatched to add wikilinks: do not Edit. Instead run the deterministic linker via Bash:

```
commonplace link [--note <relative-path>] [--target <name>] [--dry-run]
```

Then exit. Report what `commonplace link` printed.

The script enforces every rule the prompt used to ask for:
- Word-boundary matching (`(?<![\w-])name(?![\w-])`) — no mid-word splices possible
- Frontmatter, code blocks, headings, existing wikilinks, and markdown link spans are structurally non-linkable
- First occurrence per target only, longest names first to prevent overlap
- Scope check (`public → private` always blocked; same `linkGroup` allowed)
- Self-link skip
- Dry-run support for review before write
