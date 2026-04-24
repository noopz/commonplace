# Linking Rules

Shared rules for all agents that add `[[wikilinks]]` to vault notes. Every linking agent — string-matching or semantic — must follow these.

Link targets include **concept notes**, **source notes**, and **MOC notes** — any vault page that has its own `.md` file. The goal is Wikipedia-style inline linking: a reader should be able to follow any unfamiliar term or reference to its own page.

## Mechanical Rules

These are non-negotiable. Apply them before any judgment calls.

- **First occurrence only** — link each target once per note, on first mention. Subsequent mentions stay as plain text.
- **Preserve original casing** — match case-insensitively, but keep the author's casing in the wikilink: `[[Gradient Descent|gradient descent]]` if the text says "gradient descent" and the note is "Gradient Descent".
- **Never link inside**: existing `[[wikilinks]]`, code blocks (fenced or inline), or headings (`#`, `##`, etc.)
- **Word boundaries** — don't link partial words. "act" inside "ReAct" is not a match. "agent" inside "multi-agent" is not a match. The target name must appear as a standalone term or at a natural word boundary.
- **No self-links** — don't add a wikilink to a note for itself, and don't link concepts inside their own definition note.
- **Respect domain scope** — private domains only link concepts within themselves (or their linkGroup). Public domain notes can link from any public domain. Check `.wiki/domains.json` for scope and linkGroup configuration.
- **Body only** — never modify frontmatter. Only link within the body text of notes.

## Judgment Rules

These require reading context and making a call. They apply to all linking agents, not just semantic ones.

### Front-load links in the summary

The Summary section is the lead — it establishes what this note is about and how it connects to the rest of the vault. This section should be the most link-dense part of the note. A reader landing here should immediately see the web of connections: what concepts this builds on, what other work it relates to, what domain it fits in.

If a concept or source note is important enough to be in frontmatter, it should ideally have an inline link somewhere in the Summary or Key Ideas sections — not buried in a late section. When the "first occurrence" of a term is in paragraph 12, ask whether the Summary should reference it too. If the Summary discusses the idea without naming it, use display syntax: `[[Concept Name|the phrasing used in the summary]]`.

Later sections (Methodology, Notes) should link where relevant but don't need the same density. The reader has context by then.

### Density cap

If a note already has 15+ inline wikilinks, only add links that are central to the note's argument. A note with every other sentence linked is harder to read and traverse than one with well-chosen links. Prefer fewer, more meaningful links. This cap applies to ALL link types combined (concepts, source notes, MOCs).

### Ubiquity filter

If a concept appears in >50% of notes within the same domain, don't link it in that domain — it's assumed knowledge there. "Machine learning" linked in every ML paper is noise. Still link it in notes from *other* domains where it carries information (an economics paper discussing ML techniques should link it).

To check: grep `concept-index.jsonl` for the concept's `backlinkCount` and compare to the domain's source count in `domain-index.jsonl`.

### Structural relevance

Link vault notes that help a reader (or agent) understand the note's argument or follow the thread to related work. Don't link:
- Passing mentions or background assumptions ("we use standard gradient descent" — gradient descent isn't the point)
- Content in boilerplate sections (author lists, citation metadata)
- Terms used in a generic sense rather than the specific vault note

A good test: would following this link teach you something relevant to understanding this note? If not, don't link it.

## Deep-Linker-Specific Rules

These apply only to agents working from semantic similarity candidates (not exact string matches).

### Precision filtering

The embedding pre-filter optimizes for recall — it surfaces candidates that *might* be related. The agent's job is precision: reject false positives where semantic similarity is high but the connection isn't meaningful.

Read the actual text of both the source sentence and the concept definition. Only link if the concept is genuinely relevant to what the paragraph is saying, not just topically adjacent.

### Confidence tiers

- **High confidence (>0.85 similarity)**: link if it passes the mechanical and judgment rules, even if the concept is somewhat tangential
- **Medium confidence (0.75-0.85)**: link only if the concept is clearly relevant to the paragraph's argument
- **Near threshold (0.7-0.75)**: link only if the concept is central to the paragraph — the connection should be obvious when reading both texts side by side
