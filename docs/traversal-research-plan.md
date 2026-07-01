# Traversal, Hubs, and Knowledge Surfacing — Research Findings + Plan

Companion to [`traversal-research-brief.md`](./traversal-research-brief.md). Findings from a
multi-agent literature/practice survey (107 sub-agents, 24 primary sources fetched, 89 claims
extracted, 25 adversarially verified — 20 confirmed / 5 refuted). Scale assumption: ~hundreds of
notes today, possibly low-thousands within a year+. Nothing here should require a rewrite to scale
10x; it should just get more valuable.

## Summary

**Revised after explicit project-philosophy correction: commonplace's whole point is to avoid
RAG-style architecture.** Markdown-on-disk is the source of truth; a persistent queryable vector
index is a second source of truth competing with it, which is exactly what this project exists to
not need. That changes the ranking below substantially from the first pass: graph-native algorithms
(HITS, Personalized PageRank, SimRank, community detection on the *explicit* graph) move to the
front because they need nothing beyond the existing JSONL indexes. Embeddings stay scoped to their
current role — a transient, disposable aid that an agent uses to *propose* a real `[[wikilink]]`
that then becomes part of the source of truth (exactly what `wiki-deep-linker` already does) — never
a standing retrieval layer that traversal or hub-handling depends on.

Two problems that *look* like one ("hubs") are actually distinct and need separate fixes:

- **Graph-topology hubs** (a MOC or "Agent Experience" connecting to everything) — solved with
  HITS-style hub/authority separation and Personalized PageRank, which structurally dilute paths
  through high-degree nodes. Pure graph algorithms over the explicit edge set — no embeddings
  involved.
- **Embedding-space hubness** (a few vectors become universal nearest-neighbors in high-dimensional
  NN search) — only relevant at all within the narrow `deep-link` link-suggestion pass, since that's
  the only place embeddings touch this system. Not a concern for traversal or hub-ranking, which
  don't use embeddings.

The highest-leverage move is running HITS / Personalized PageRank / community detection directly on
the explicit graph already encoded in the JSONL indexes — no new persistence layer, no new
infrastructure, additive on top of what exists today. Embeddings are not the unlock here; the graph
itself, properly ranked and clustered, is.

## Ranked techniques

All of #1–#4 run on the explicit graph already in the JSONL indexes (frontmatter arrays +
wikilinks + backlink-index). None require embeddings, persistence, or new infrastructure.

1. **HITS-style hub/authority separation** (or a simpler proxy: in-degree from many distinct domains
   vs. in-degree from one MOC) to flag administrative-aggregator hubs separately from genuine
   cross-domain bridges. This is the direct fix for graph-topology hubs — Kleinberg's original
   motivating example (in-degree alone conflates "java.sun.com" with irrelevant universally-popular
   pages) is structurally identical to commonplace's MOC problem. Low cost: one pass over
   `backlink-index.jsonl`, a handful of power iterations.
   ([Kleinberg, HITS](https://www.cs.cornell.edu/home/kleinber/auth.pdf))

2. **Personalized PageRank for traversal**, seeded from the current note/context, as the replacement
   for naive BFS/DFS. PPR's teleportation term naturally dampens paths that route through
   high-degree hubs, which is exactly the "Kevin-Bacon-hops-away but real" requirement. HippoRAG
   pairs PPR with an LLM-built KG, but the PPR mechanism itself needs nothing but an adjacency
   structure — commonplace's existing edges suffice. Low-moderate cost: build an in-memory adjacency
   list from the JSONL indexes at query time (no need to persist it as a new index initially).
   ([HippoRAG](https://arxiv.org/abs/2405.14831))

3. **Community detection (Leiden/Louvain) on the explicit graph.** Run directly on frontmatter edges
   + wikilinks (optionally weighted by edge type — `builds_on`/`compares_with` vs. bare MOC
   co-membership) rather than on an embedding-derived similarity graph. This is the fix for
   "co-listed under a 50-note MOC is weak signal": a structurally-detected community is a different,
   more discriminating signal than MOC membership, without needing any semantic/embedding layer.
   Moderate cost: small Leiden/Louvain implementation, runs in milliseconds at this scale.

4. **SimRank / inverse-degree edge weighting** as a lighter-weight alternative to PPR for decaying
   indirect/long-range hop contributions — still pure graph-structure, no embeddings. Exact SimRank
   is all-pairs iterative (more expensive than PPR-from-a-seed), so treat as secondary to #2 unless
   PPR proves awkward to seed on-demand.

5. **Embeddings, scoped strictly to link suggestion (existing pattern, not new infrastructure).**
   Keep `deep-link`'s transient embed → suggest → `wiki-deep-linker` writes a real `[[wikilink]]` →
   discard cycle. The only legitimate enhancement here is making repeated runs cheaper (e.g. a
   disposable cache keyed by note content-hash, invalidated on edit) — not a persistent, queryable
   vector index that other features come to depend on. If/when this cache exists, a hubness-mitigation
   rescaling (local scaling / NICDM / mutual proximity) on the cosine-similarity candidates would
   reduce false "this stub matches everything" suggestions — Feldbauer & Flexer's comparison is the
   citation, but this is a minor refinement to an existing tool, not a new architectural layer.
   ([Feldbauer & Flexer 2019](https://link.springer.com/article/10.1007/s10115-018-1205-y))

## Hub problem — both senses, explicitly

- **Sense (a), graph hubs:** HITS / PPR / degree-aware edge weighting. These operate on the explicit
  + inferred graph structure.
- **Sense (b), embedding hubness:** a separate, well-documented phenomenon (Radovanović et al. 2010,
  Schnitzer et al. 2012) that gets *worse*, not better, as dimensionality increases. Confirmed as
  general, not dataset-specific (a stronger "purely intrinsic to dimensionality, never an artifact of
  dataset/distance choice" framing was adversarially refuted — use the weaker, accurate version: "a
  well-documented, general phenomenon that increases with dimensionality"). Fixed with distance
  rescaling (#5), not with anything graph-side.

These two need to be solved independently — fixing graph hubs does nothing for embedding hubness and
vice versa.

## Spokes / latent graph

Two independent surfacing mechanisms, neither requiring persistent vector infrastructure:
- **Structural:** community detection (#3) puts orphan/stub notes into a cluster based on whatever
  explicit edges they *do* have, even thin ones — surfacing "this stub actually sits near cluster X"
  without any embedding involved.
- **Semantic:** the existing `deep-link` → `wiki-deep-linker` pattern (#5) is the missing-link
  *suggestion* mechanism for connections with no explicit edge at all yet. Its output is always a
  proposed edit to a markdown file — an agent decision, not a retrieval-time answer. That's the
  difference between this and RAG: the embedding is scaffolding for an edit, then it's gone.

Persisting embeddings as a cache only matters for making repeated `deep-link` passes cheaper
(incremental re-embedding of changed notes); it is not a prerequisite for either surfacing
mechanism above, and should not become something other features query directly.

## Explicitly reject at this scale (and on principle)

- **Any persistent, queryable vector index that traversal/hub-handling/retrieval comes to depend
  on** — sqlite-vec, FAISS, hnswlib, or otherwise. This is the core rejection: it's RAG-shaped
  infrastructure competing with markdown-on-disk as the source of truth, which is the thing
  commonplace exists to avoid. If a cache exists at all, it's disposable, scoped to making
  `deep-link` cheaper, and nothing else reads from it.
- **Microsoft GraphRAG-style LLM-extracted entity-relation graphs with hierarchical summarization.**
  Expensive per-chunk LLM calls, and even on its own terms GraphRAG-V shows embedding-only clustering
  matches or beats it at a fraction of indexing cost — but more fundamentally, this whole family
  builds a second knowledge representation alongside the markdown, which is the pattern to avoid
  here regardless of cost.
- **Standalone vector DB servers** (Pinecone/Weaviate/Milvus). Doubly rejected: wrong infrastructure
  weight for this scale, and the wrong architecture in principle.
- **Exact all-pairs SimRank.** Cubic-ish iterative cost; PPR-from-a-seed gets a similar "decayed
  indirect similarity" result far more cheaply, on the same explicit graph.
- **GPU-resident / distributed community detection.** Plain Leiden/Louvain on a few hundred (or even
  several thousand) nodes runs in milliseconds on a laptop.

## Scaling note (year+ horizon)

Every recommended technique here is chosen to be cheap *now* and not need replacement at 10x scale:
- HITS/PPR/Leiden/Louvain on the explicit graph are near-linear in practice and used in production on
  graphs orders of magnitude larger than commonplace will reach in a year — low-thousands of nodes is
  trivial for all of them, in-memory, recomputed on demand.
- None of this requires a new persistence layer at any scale considered here, so there's no
  infrastructure to outgrow. If the vault eventually reaches a size where in-memory graph
  recomputation from JSONL becomes slow, the fix is caching the *graph* (still file-based, still
  derived from markdown) — not introducing a vector index.
- The `deep-link` embedding cache (if built) stays disposable regardless of vault size; nothing
  depends on it being complete or durable.

## Open questions (need a prototype to settle)

1. Does Leiden/Louvain on the real *explicit* vault graph (frontmatter edges + wikilinks, weighted
   by edge type) produce coherent clusters distinct from the 14 hand-maintained MOCs, or does it just
   rediscover MOC structure? Most decision-relevant — if it just rediscovers MOCs, #3's value
   proposition weakens. No embeddings needed to test this.
2. Is PPR seeded on-demand cheap enough computed fresh from JSONL each time, or does it warrant a
   cached in-memory adjacency structure (still derived from the markdown, not a new index)?
3. What edge-weighting scheme best distinguishes curated edges (`builds_on`, `compares_with`,
   prose wikilinks) from administrative ones (bare MOC co-membership) for HITS/PPR/community
   detection — this is now the central open question since it's doing the work embeddings would
   otherwise have done.
4. Does the existing `deep-link` cycle actually produce noisy "this stub matches everything"
   suggestions in practice, or is that a hypothetical problem? Only worth building hubness-mitigation
   rescaling (#5) if `wiki-deep-linker` output is observed to have this failure mode.
5. No verified findings survived on Obsidian/Roam/Logseq/Zettelkasten prior art specifically — that
   angle returned results but none survived adversarial verification in this pass. Worth a targeted
   follow-up if PKM-tool UX precedent matters for how results get *presented*, not just computed.

## Suggested phasing

**Phase 1 (low cost, do first):** HITS-style hub/authority scoring over `backlink-index.jsonl` — a
script, not an agent, since it's deterministic graph math. Immediately useful standalone (flags which
MOCs/concepts are administrative aggregators vs. genuine authorities) and needs nothing new.

**Phase 2 (prototype to answer open question #1):** run Leiden/Louvain on the explicit graph
(optionally edge-type-weighted) against the real vault, before committing to building it into any
user-facing feature. This is the gating question for whether community detection adds signal beyond
hand-maintained MOCs.

**Phase 3 (if Phase 2 validates):** ship community detection as a `commonplace` command, feeding both
spoke-surfacing (orphans land in a cluster from thin edges) and a "related notes" surface distinct
from MOC membership.

**Phase 4 (traversal):** PPR-seeded traversal replacing naive BFS/DFS for "find related notes several
hops away." Independent of Phase 2/3 — could be done first if traversal noise is the more urgent pain
point than spoke-surfacing.

**Not phased, left as-is unless open question #4 says otherwise:** the `deep-link` →
`wiki-deep-linker` embedding cycle. No changes proposed unless observed noisy-suggestion behavior
justifies the hubness-mitigation refinement.

## Sources actually used (verified)

- Kleinberg, "Authoritative Sources in a Hyperlinked Environment" (HITS) — https://www.cs.cornell.edu/home/kleinber/auth.pdf
- SimRank — https://www.cse.cuhk.edu.hk/~cslui/CMSC5734/simrank.pdf
- HippoRAG — https://arxiv.org/abs/2405.14831
- Radovanović et al., hubness in high-dimensional data (JMLR 2010) — https://www.jmlr.org/papers/v11/radovanovic10a.html
- Schnitzer et al., hubness JMLR 2012 — https://jmlr.csail.mit.edu/papers/volume13/schnitzer12a/schnitzer12a.pdf
- Feldbauer & Flexer, hubness reduction comparison (2019) — https://link.springer.com/article/10.1007/s10115-018-1205-y
- ArchRAG — https://arxiv.org/pdf/2502.09891 (context for the rejected RAG-style approach, not a recommendation)
- GraphRAG-V — https://webhome.cs.uvic.ca/~thomo/papers/asonam2025-graphrag.pdf (same)

Two claims from the raw research were adversarially refuted and are deliberately excluded above:
"hubness is purely intrinsic to dimensionality, never dataset/distance-function dependent" and
"GraphRAG-V's VLouvain never materializes any similarity graph via pure matrix ops." Treat the
weaker, confirmed versions of both as accurate; do not cite the stronger forms.
