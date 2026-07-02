import { mkdirSync, writeFileSync, rmSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Build a throwaway vault with a domain registry and PREBUILT indexes.
 *
 * All names are invented — never copy real vault domains, folders, or note
 * titles into this file; the repo is public. Only the structural SHAPE
 * matters, and two properties of it are load-bearing:
 *
 * 1. Numbered folder prefixes with a space before the topic word
 *    ("02 - Research/Alpha") — the exact path shape a naive slash-delimited
 *    substring gate (`includes("/Research/")`) fails to match.
 * 2. A bridge concept spanning public AND private domains — public/public
 *    hits must surface, private ones must be scope-filtered.
 *
 *   02 - Research/Alpha        → alpha   (public)
 *   02 - Research/Beta         → beta    (public)
 *   04 - Explorations/Gamma    → gamma   (private, no linkGroup)
 *   04 - Explorations/Delta    → delta   (private, linkGroup "grouped")
 *   04 - Explorations/Epsilon  → epsilon (private, linkGroup "grouped")
 *
 * All five source notes share the concept "Shared Bridge Concept".
 *
 * `.last-index` is stamped in the future so `index.ts --incremental`
 * (which the post-write-research hook runs first) sees no changed files,
 * exits early, and leaves these prebuilt indexes intact.
 */
export function makeFixtureVault(): {
  vaultRoot: string;
  paths: {
    alphaNote: string;   // public — the "just written" note
    betaNote: string;    // public — the note that must be found
    gammaNote: string;   // private, no linkGroup — must never surface
    deltaNote: string;   // private, linkGroup "grouped"
    epsilonNote: string; // private, linkGroup "grouped"
  };
} {
  const vaultRoot = mkdtempSync(join(tmpdir(), "cdr-vault-"));
  const wiki = join(vaultRoot, ".wiki");
  mkdirSync(wiki, { recursive: true });

  writeFileSync(join(wiki, "domains.json"), JSON.stringify({
    domains: {
      "alpha": { path: "02 - Research/Alpha", scope: "public" },
      "beta": { path: "02 - Research/Beta", scope: "public" },
      "gamma": { path: "04 - Explorations/Gamma", scope: "private" },
      "delta": { path: "04 - Explorations/Delta", scope: "private", linkGroup: "grouped" },
      "epsilon": { path: "04 - Explorations/Epsilon", scope: "private", linkGroup: "grouped" },
    },
  }, null, 2));

  // alpha/beta/gamma additionally share "Second Bridge Concept" so that
  // impact.ts's 2+-shared-concept threshold is met for those pairs — this
  // lets impact.test.ts exercise its scope filter without perturbing
  // cross-domain.test.ts, which only keys off "Shared Bridge Concept"
  // (the sole entry in concept-index.jsonl's bridge map).
  const notes = [
    { rel: "02 - Research/Alpha/Alpha Source Note.md", title: "Alpha Source Note", domain: "alpha", scope: "public", key: "alphaNote", extraConcepts: ["Second Bridge Concept"] },
    { rel: "02 - Research/Beta/Beta Bridge Target.md", title: "Beta Bridge Target", domain: "beta", scope: "public", key: "betaNote", extraConcepts: ["Second Bridge Concept"] },
    { rel: "04 - Explorations/Gamma/Gamma Private Note.md", title: "Gamma Private Note", domain: "gamma", scope: "private", key: "gammaNote", extraConcepts: ["Second Bridge Concept"] },
    { rel: "04 - Explorations/Delta/Delta Private Note.md", title: "Delta Private Note", domain: "delta", scope: "private", key: "deltaNote", extraConcepts: [] },
    { rel: "04 - Explorations/Epsilon/Epsilon Private Note.md", title: "Epsilon Private Note", domain: "epsilon", scope: "private", key: "epsilonNote", extraConcepts: [] },
  ] as const;

  const paths = {} as Record<(typeof notes)[number]["key"], string>;
  const sourceLines: string[] = [];
  for (const n of notes) {
    const abs = join(vaultRoot, n.rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, `# ${n.title}\n`);
    paths[n.key] = abs;
    sourceLines.push(JSON.stringify({
      title: n.title,
      path: n.rel, // vault-relative, as the real indexer writes them
      domain: n.domain,
      scope: n.scope,
      tags: [],
      concepts: ["Shared Bridge Concept", ...n.extraConcepts],
      mocs: [],
      buildsOn: [],
      comparesWith: [],
      usesMethod: [],
    }));
  }

  writeFileSync(join(wiki, "source-index.jsonl"), sourceLines.join("\n") + "\n");
  writeFileSync(join(wiki, "concept-index.jsonl"), JSON.stringify({
    name: "Shared Bridge Concept",
    path: "03 - Concepts/Shared Bridge Concept.md",
    domains: ["alpha", "beta", "gamma", "delta", "epsilon"],
    backlinkCount: 5,
    isStub: false,
  }) + "\n");
  writeFileSync(join(wiki, "moc-index.jsonl"), "");
  // Future timestamp → ensureIndex passes AND index.ts --incremental no-ops.
  writeFileSync(join(wiki, ".last-index"), String(Date.now() + 3_600_000));

  return { vaultRoot, paths };
}

export function removeFixtureVault(vaultRoot: string): void {
  rmSync(vaultRoot, { recursive: true, force: true });
}
