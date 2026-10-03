# Graph Traversal Reference

The vault is a graph: notes are nodes, wikilinks and frontmatter relations are edges. Most non-trivial questions need traversal, not keyword search. These patterns expand a cluster once you have at least one relevant entry-point note. Each names the vault tool; the CLI twin (`commonplace links|path|neighbourhood …`) gives the same output when the tools are unavailable.

## Hub detection

`vault_note` and `vault_search` show each note's link counts (`links: in N / out M`). A high incoming count means the note is referenced across many sources — a likely synthesis anchor for a broadly-shared idea. A MOC also has a high count but is a map, not an authority; read the notes it lists.

## Follow edges

Once a note is relevant, `vault_links note:"<title>" direction:"in"` lists every note that links to it, each with the sentence that makes the link. Read the ones whose sentence bears on the question. This is graph traversal, not keyword search — the cluster may include papers, people, documents, and anything else in the vault.

## Enter via MOC

If the question touches a subfield, MOCs are pre-built cluster maps:

1. `vault_list what:"mocs"` (or `vault_search` for the subfield's name).
2. `vault_note` the MOC, then `vault_links` it for its full membership.
3. Drill into specific notes from the list.

## Traverse citation chains

Source notes carry `builds_on`, `compares_with` and `uses_method` relations. `vault_links note:"<paper>" kinds:["buildsOn","comparesWith","usesMethod"]` follows them in both directions — papers it builds on, and papers that build on it.

## How two notes connect

`vault_path from:"<X>" to:"<Y>"` returns the shortest chain between them, penalising hubs so the path runs through specific notes rather than an index page. Each hop names its edge kind and the linking sentence. Read the waypoints before asserting the connection.

## Bridges and the neighbourhood

`vault_neighbourhood seeds:["<A>", "<B>"]` ranks notes close to the seeds in the graph, including notes that share no words with them. A note that ranks high for seeds in two different domains is a cross-domain bridge — powerful for synthesis because it connects otherwise-separate clusters.

## When to stop

Stop when you have sufficient context or have traversed 2–3 hops. Note unexplored frontier notes for the user — let them tell you whether to keep going.
