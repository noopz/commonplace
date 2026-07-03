/**
 * Richer invented fixture vault for the retrieval eval. All names are
 * invented — never copy real vault domains, folders, or note titles; the
 * repo is public. Prebuilt JSONL indexes, same shape the real indexer
 * writes (vault-relative paths).
 *
 * Retrieval-relevant structure:
 * - alpha + beta are public; gamma is private.
 * - "Cue Anchors" bridges alpha↔beta (cross-domain questions).
 * - "Beta Consolidation Report" is reachable ONLY via the concept word
 *   "consolidation" — gold question q3 asks about it in paraphrase
 *   ("combining stored memories") sharing zero strings with the record:
 *   the Memora abstraction-gap case. Flat-mode recall for q3 is 0 by
 *   construction; the abstraction layer is expected to lift it.
 * - "Sparse Rewards" is a stub concept (no abstraction, 1 backlink).
 */

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function makeRetrievalFixtureVault(): { vaultRoot: string } {
  const vaultRoot = mkdtempSync(join(tmpdir(), "retrieval-eval-vault-"));
  const wiki = join(vaultRoot, ".wiki");
  mkdirSync(wiki, { recursive: true });

  writeFileSync(join(wiki, "domains.json"), JSON.stringify({
    domains: {
      alpha: { path: "02 - Research/Alpha", scope: "public" },
      beta: { path: "02 - Research/Beta", scope: "public" },
      gamma: { path: "04 - Explorations/Gamma", scope: "private" },
    },
  }, null, 2));

  const sources = [
    { title: "Harmonic Retrieval Survey", rel: "02 - Research/Alpha/Harmonic Retrieval Survey.md", domain: "alpha", scope: "public", tags: ["survey"], concepts: ["Query Seeding", "Graph Traversal"], mocs: ["Alpha MOC"] },
    { title: "Latent Anchor Methods", rel: "02 - Research/Alpha/Latent Anchor Methods.md", domain: "alpha", scope: "public", tags: ["method"], concepts: ["Cue Anchors", "Query Seeding"], mocs: ["Alpha MOC"] },
    { title: "Frontier Ranking Study", rel: "02 - Research/Alpha/Frontier Ranking Study.md", domain: "alpha", scope: "public", tags: ["study"], concepts: ["Authority Ranking", "Graph Traversal"], mocs: ["Alpha MOC"] },
    { title: "Anchor Precision Benchmarks", rel: "02 - Research/Alpha/Anchor Precision Benchmarks.md", domain: "alpha", scope: "public", tags: ["benchmark"], concepts: ["Cue Anchors", "Authority Ranking"], mocs: ["Alpha MOC"] },
    { title: "Beta Consolidation Report", rel: "02 - Research/Beta/Beta Consolidation Report.md", domain: "beta", scope: "public", tags: ["report"], concepts: ["Memory Consolidation", "Cue Anchors"], mocs: ["Beta MOC"] },
    { title: "Beta Archive Overview", rel: "02 - Research/Beta/Beta Archive Overview.md", domain: "beta", scope: "public", tags: ["overview"], concepts: ["Memory Consolidation"], mocs: ["Beta MOC"] },
    { title: "Consolidation Failure Modes", rel: "02 - Research/Beta/Consolidation Failure Modes.md", domain: "beta", scope: "public", tags: ["analysis"], concepts: ["Memory Consolidation", "Graph Traversal"], mocs: ["Beta MOC"] },
    { title: "Gamma Field Journal", rel: "04 - Explorations/Gamma/Gamma Field Journal.md", domain: "gamma", scope: "private", tags: ["journal"], concepts: ["Sparse Rewards"], mocs: [] },
  ];

  const sourceLines: string[] = [];
  for (const s of sources) {
    const abs = join(vaultRoot, s.rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, `# ${s.title}\n\nFixture body for ${s.title}.\n`);
    sourceLines.push(JSON.stringify({
      title: s.title,
      path: s.rel,
      domain: s.domain,
      scope: s.scope,
      tags: s.tags,
      concepts: s.concepts,
      mocs: s.mocs,
      buildsOn: [],
      comparesWith: [],
      usesMethod: [],
    }));
  }
  writeFileSync(join(wiki, "source-index.jsonl"), sourceLines.join("\n") + "\n");

  const concepts = [
    { name: "Query Seeding", backlinkCount: 2, isStub: false },
    { name: "Cue Anchors", backlinkCount: 3, isStub: false },
    { name: "Graph Traversal", backlinkCount: 3, isStub: false },
    { name: "Authority Ranking", backlinkCount: 2, isStub: false },
    { name: "Memory Consolidation", backlinkCount: 3, isStub: false },
    { name: "Sparse Rewards", backlinkCount: 1, isStub: true },
  ];
  writeFileSync(
    join(wiki, "concept-index.jsonl"),
    concepts.map((c) => JSON.stringify({
      name: c.name,
      path: `03 - Concepts/${c.name}.md`,
      domains: ["alpha", "beta"],
      backlinkCount: c.backlinkCount,
      isStub: c.isStub,
    })).join("\n") + "\n",
  );

  const mocs = [
    { name: "Alpha MOC", members: sources.filter((s) => s.mocs.includes("Alpha MOC")).map((s) => s.title) },
    { name: "Beta MOC", members: sources.filter((s) => s.mocs.includes("Beta MOC")).map((s) => s.title) },
  ];
  writeFileSync(
    join(wiki, "moc-index.jsonl"),
    mocs.map((m) => JSON.stringify({
      name: m.name,
      path: `05 - MOCs/${m.name}.md`,
      domains: ["alpha", "beta"],
      sourceCount: m.members.length,
      sources: m.members,
      declaredCount: m.members.length,
    })).join("\n") + "\n",
  );

  // Future timestamp → any incremental index run sees no changes and
  // leaves these prebuilt indexes intact.
  writeFileSync(join(wiki, ".last-index"), String(Date.now() + 3_600_000));

  return { vaultRoot };
}

export function removeRetrievalFixtureVault(vaultRoot: string): void {
  rmSync(vaultRoot, { recursive: true, force: true });
}
