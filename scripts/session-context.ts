#!/usr/bin/env tsx
/**
 * SessionStart hook: emits additionalContext orienting the model
 * toward the vault as an interconnected knowledge graph.
 *
 * Provides: what indexes exist, how to search them, the graph
 * traversal methodology, and a sample of top concepts for grounding.
 */

import { readFileSync } from "fs";
import { join } from "path";

// Resolve vault path
const dataDir = process.env.CLAUDE_PLUGIN_DATA;
const pluginRoot = join(import.meta.dirname!, "..");
let vaultPath: string | undefined;
for (const loc of [
  ...(dataDir ? [join(dataDir, ".vault-path")] : []),
  join(pluginRoot, ".vault-path"),
]) {
  try { vaultPath = readFileSync(loc, "utf-8").trim(); break; } catch {}
}
if (!vaultPath) process.exit(0);

const wikiPath = join(vaultPath, ".wiki");

// Read indexes
interface ConceptEntry { name: string; backlinkCount: number; isStub: boolean; domains: string[] }
interface SourceEntry { title: string; domain: string }
interface MocEntry { name: string }

let sources: SourceEntry[] = [];
let concepts: ConceptEntry[] = [];
let mocs: MocEntry[] = [];

function parseJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
}
try { sources = parseJsonl(join(wikiPath, "source-index.jsonl")); } catch {}
try { concepts = parseJsonl(join(wikiPath, "concept-index.jsonl")); } catch {}
try { mocs = parseJsonl(join(wikiPath, "moc-index.jsonl")); } catch {}

if (sources.length === 0) process.exit(0);

// Extract grounding signals
const domainSet = new Set<string>();
for (const s of sources) if (s.domain) domainSet.add(s.domain);
const domains = [...domainSet];

const topConcepts = concepts
  .filter(c => !c.isStub)
  .sort((a, b) => b.backlinkCount - a.backlinkCount)
  .slice(0, 20)
  .map(c => `${c.name} (${c.backlinkCount})`);

const mocNames = mocs.map(m => m.name);

const context = `The commonplace wiki plugin is active. The vault at ${vaultPath} is an interconnected knowledge graph with ${sources.length} sources, ${concepts.length} concepts, and ${mocs.length} MOCs across ${domains.length} domains (${domains.join(", ")}).

Searchable indexes at ${wikiPath}/:
- source-index.jsonl — one JSON record per line: {title, path, domain, scope, tags, concepts, mocs}
- concept-index.jsonl — one JSON record per line: {name, path, domains, backlinkCount, isStub}
- moc-index.jsonl — one JSON record per line: {name, path, sourceCount, sources}
Grep returns complete records — no context flags needed.

Hub concepts (highest cross-reference density): ${topConcepts.join(", ")}.
MOCs: ${mocNames.join(", ")}.

When the user asks about any of these topics or related areas, search the vault before answering from general knowledge. The vault contains specific paper analyses, cross-references, and synthesized insights.

How to search — the wiki-query methodology:
1. Grep the indexes with search terms (never load full index files). Iterate: what you find generates new search terms.
2. Traverse the graph — concepts are nodes, wikilinks are edges:
   - High backlinkCount = hub concept, prioritize. Follow edges by grepping [[ConceptName]] across vault .md files to find note clusters.
   - MOCs are pre-built cluster maps. Citation chains via builds_on/compares_with/uses_method frontmatter.
   - Concepts in 2+ domains are cross-domain bridges — powerful for synthesis.
3. Read matching notes, synthesize with specific citations.
4. File back: novel connections get written back to the vault (concept updates, synthesis pages). The vault grows smarter with every question.`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: context,
  },
}));
