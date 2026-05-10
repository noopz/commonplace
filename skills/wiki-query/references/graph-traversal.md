# Graph Traversal Reference

The vault is a graph: concepts are nodes, wikilinks are edges. Most non-trivial questions need traversal, not keyword search. This file collects the traversal patterns — read it once you've found at least one relevant entry-point note and want to expand the cluster.

## Hub detection

`backlinkCount` in `concept-index.jsonl` is a corpus-wide signal. High count = referenced across many papers, not just one. Prioritize hub concepts when the question is about a broadly-shared idea — they're the most likely synthesis anchors.

## Follow edges via Grep

Once you identify a relevant concept, find every note that links to it:

- Grep pattern: `\[\[ConceptName\]\]`
- Path: the vault root
- Glob: `*.md`

Read those notes as a cluster — this is graph traversal, not keyword search. The cluster may include papers, person notes, Google Docs notes, and anything else in the vault.

## Enter via MOC

If the question touches a subfield, MOCs are pre-built cluster maps. Workflow:

1. Grep `moc-index.jsonl` for relevant MOCs.
2. Read the MOC note to get its full paper list.
3. Drill into specific papers from the list.

## Traverse citation chains

Source notes carry `builds_on`, `compares_with`, and `uses_method` frontmatter fields. If a paper is relevant, grep for its title in those fields to find papers that build on or compare against it. This follows the citation graph without external tools.

## Bridge concepts

Check the `domains` array in concept-index.jsonl entries. A concept appearing in 2+ domains is a cross-domain bridge — especially powerful for synthesis questions because it connects otherwise-separate clusters.

## When to stop

Stop when you have sufficient context or have traversed 2–3 hops. Note unexplored frontier concepts for the user — let them tell you whether to keep going.
