# Linking Rules

Shared rules for all agents that add `[[wikilinks]]` to vault notes. Every linking agent — string-matching or semantic — must follow these.

## Mechanical Rules

These are non-negotiable. Apply them before any judgment calls.

- **First occurrence only** — link each concept once per note, on first mention. Subsequent mentions stay as plain text.
- **Preserve original casing** — match case-insensitively, but keep the author's casing in the wikilink: `[[Gradient Descent|gradient descent]]` if the text says "gradient descent" and the concept note is "Gradient Descent".
- **Never link inside**: existing `[[wikilinks]]`, code blocks (fenced or inline), or headings (`#`, `##`, etc.)
- **Word boundaries** — don't link partial words. "act" inside "ReAct" is not a match. "agent" inside "multi-agent" is not a match. The concept name must appear as a standalone term or at a natural word boundary.
- **Skip concept notes** — don't add wikilinks to a concept note for itself or for concepts it already defines.
- **Respect domain scope** — if a note is in a hobby domain, only link concepts from that same hobby domain. Professional domain notes can link concepts from any professional domain.
- **Body only** — never modify frontmatter. Only link within the body text of notes.

## Judgment Rules

These require reading context and making a call. They apply to all linking agents, not just semantic ones.

### Density cap

If a note already has 15+ concept links, only add links for concepts that are central to the note's argument. A note with every other sentence linked to a concept is harder to read and traverse than one with well-chosen links. Prefer fewer, more meaningful links.

### Ubiquity filter

If a concept appears in >50% of notes within the same domain, don't link it in that domain — it's assumed knowledge there. "Machine learning" linked in every ML paper is noise. Still link it in notes from *other* domains where it carries information (an economics paper discussing ML techniques should link it).

To check: grep `concept-index.jsonl` for the concept's `backlinkCount` and compare to the domain's source count in `domain-index.jsonl`.

### Structural relevance

Link concepts that help a reader (or agent) understand the note's argument. Don't link:
- Passing mentions or background assumptions ("we use standard gradient descent" — gradient descent isn't the point)
- Concepts in boilerplate sections (author lists, citation metadata)
- Terms used in a generic sense rather than the specific vault concept

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
