# Research Brief: Traversal, Hubs, and Knowledge Surfacing

**Audience:** an agent tasked with researching how to make a dense, LLM-maintained markdown wiki *surface its own knowledge well* — finding related and non-obvious connections, not just one-hop neighbors.

**Your job:** survey the literature and practice (papers + real tools), then come back with concrete, ranked techniques mapped onto commonplace's actual data shape (below). This is a *research* task — read widely, cite sources, prefer primary literature and real implementations over marketing posts.

---

## The system you're researching for

commonplace turns a folder of markdown into an LLM-maintained knowledge base. It is **markdown-on-disk as the source of truth**, with derived indexes. Current vault: ~213 sources, ~264 concepts, ~14 MOCs (Maps of Content).

**What the graph is made of (today):**
- **Nodes:** source notes, concept notes, MOC notes (hubs by design).
- **Edges:** frontmatter arrays per source (`concepts`, `mocs`, `builds_on`, `compares_with`, `uses_method`) + body `[[wikilinks]]`, inverted into a `backlink-index.jsonl`.
- **Indexes:** five `.jsonl` files (source / concept / moc / domain / backlink). No adjacency list, no graph-native structure.
- **Semantics:** a `deep-link` feature embeds sentences via Ollama `nomic-embed-text` and finds similar pairs — but embeddings are **recomputed every run and discarded** (no persistence).

**What does NOT exist yet (the gap you're informing):**
- No centrality / PageRank / HITS / ranking of any kind.
- No pathfinding, reachability, or neighbor API.
- No clustering / community detection.
- No persisted vector index; semantic similarity is transient.
- Linking is **pure substring/word-boundary matching** — no graph or embedding signal.

Assume any new capability is **additive on top of the existing JSONL indexes + a (to-be-persisted) embedding store.** We are *not* rewriting commonplace's indexer.

---

## The three problems to research

1. **Traversal.** Given a note (or an agent's current context), find the *most related* notes — including ones several hops away that are genuinely connected, not just direct neighbors. Naive BFS/DFS over this graph explodes and surfaces noise. What traversal/ranking methods find "Kevin-Bacon-hops-away" connections that are real?

2. **The hub problem.** A few nodes (MOCs, popular concepts like "Agent Experience") connect to *everything*. They are both the value (cross-domain bridges) and the noise (being co-listed under a 50-note MOC is almost no signal; every BFS routes through them). How does the literature handle high-degree hubs — down-weighting, edge typing, hub/authority separation, degree normalization? Note there are **two distinct senses of "hub"** worth separating: (a) high-degree *graph* hubs, and (b) the **"hubness" phenomenon** in high-dimensional embedding spaces (a few vectors become nearest-neighbors to everything) — both are relevant and have separate literatures.

3. **Knowledge surfacing / spokes.** The inverse failure: orphan and weakly-linked "spoke" notes (stubs, peripheral ideas) that never surface even when relevant. How do systems surface the long tail and *suggest* missing connections (the latent graph), not just traverse the explicit one?

---

## Directions and sources to investigate

Cast a wide net — HuggingFace (papers + models), arXiv, ACM/IEEE, and real-tool engineering blogs. Verify claims against primary sources; don't take any single post at face value. Leads worth chasing (confirm relevance yourself):

- **Graph ranking & relatedness:** PageRank and especially **Personalized PageRank** (random-walk relatedness that naturally dilutes hub-routed paths); **HITS / hubs-and-authorities** (directly models the hub problem); SimRank; spreading-activation retrieval.
- **Graph-RAG / KG-augmented LLM retrieval:** Microsoft **GraphRAG**, **HippoRAG** (personalized PageRank over a KG as LLM memory), LightRAG, and the broader "knowledge-graph + embeddings for retrieval" line — what do they do about hubs, multi-hop, and ranking?
- **Edge weighting:** TF-IDF / inverse-degree edge weighting, edge typing (intentional prose link vs. structural co-membership), and how weighting changes traversal quality.
- **Embeddings & hubness:** persistent vector indexes (FAISS / hnswlib / sqlite-vec etc.), hybrid lexical+semantic retrieval, and the **hubness problem in high-dimensional NN search** + known mitigations (e.g. local/mutual-neighbor scaling, cross-domain normalization).
- **Community detection / structure:** Louvain / Leiden, label propagation — for clustering concepts and detecting cross-cluster bridges (the interesting connections).
- **Prior art in PKM tools:** how Obsidian (graph view, related-notes), Roam, Logseq, and "second brain" / Zettelkasten tooling surface related notes and handle dense graphs — what works, what's just eye-candy.
- **Pathfinding for explanation:** shortest *meaningful* path (A* with hub edges priced high) for "how are X and Y connected?" — any work on explainable multi-hop connection between two nodes.

## What to deliver

A concise synthesis (not a link dump):
1. The 3–6 techniques most worth adopting, **ranked**, each with: what it does, why it fits commonplace's JSONL-index + embedding reality, rough implementation cost, and 1–2 citations.
2. Explicit treatment of the **hub problem** (both senses) — what actually works.
3. How to surface **spokes / the latent graph** (suggesting missing links), and whether persisted embeddings are the unlock.
4. Any approach you'd explicitly *reject* for this scale (~hundreds of notes) as over-engineering, and why.
5. Open questions / things that need a prototype to settle.

Cite as you go (URLs). Favor depth on the few highest-leverage ideas over breadth.
