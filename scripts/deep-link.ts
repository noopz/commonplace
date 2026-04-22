#!/usr/bin/env tsx
/**
 * deep-link — Embedding pre-filter for semantic linking.
 *
 * Two modes:
 *   --mode concepts (default): find note sentences semantically close to
 *     concept definitions but not already linked.
 *   --mode notes: find cross-domain note-to-note sentence pairs that are
 *     semantically similar — surfaces connections no concept mediates.
 *
 * Uses Ollama + nomic-embed-text. Transient: nothing is persisted.
 * Embeddings are computed, compared, and discarded every run.
 */

import { readFileSync, existsSync } from "fs";
import { join, relative } from "path";
import { resolveVault, loadIndexes, classifyNote } from "./lib/vault.js";
import type { ConceptNote, SourceNote } from "./lib/types.js";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const MODE = flag("mode", "concepts") as "concepts" | "notes";
const THRESHOLD = parseFloat(flag("threshold", MODE === "notes" ? "0.8" : "0.7"));
const TOP_PER_NOTE = parseInt(flag("top", "10"), 10);
const SINGLE_NOTE = flag("note", "");
const OLLAMA_URL = flag("ollama-url", "http://localhost:11434");
const MODEL = flag("model", "nomic-embed-text");

// ---------------------------------------------------------------------------
// Resolve vault
// ---------------------------------------------------------------------------

const explicitVault = flag("vault", "");
const config = resolveVault(explicitVault || undefined);
const { vaultPath, wikiPath } = config;

// ---------------------------------------------------------------------------
// Check Ollama
// ---------------------------------------------------------------------------

async function checkOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = data.models ?? [];
    return models.some((m) => m.name.startsWith(MODEL));
  } catch {
    return false;
  }
}

if (!(await checkOllama())) {
  console.error(`Error: Ollama is not running or ${MODEL} is not available.`);
  console.error("");
  console.error("Setup:");
  console.error("  1. Install Ollama: https://ollama.com");
  console.error(`  2. Pull the model: ollama pull ${MODEL}`);
  console.error("  3. Start Ollama: ollama serve");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load concepts (only non-stubs with real definitions)
// ---------------------------------------------------------------------------

interface ConceptEmbedding {
  name: string;
  path: string;
  definition: string;
  vector: Float32Array;
}

const { concepts, sources } = loadIndexes(config);

function extractDefinition(conceptPath: string): string | null {
  if (!existsSync(conceptPath)) return null;
  const content = readFileSync(conceptPath, "utf-8");

  // Strip frontmatter
  if (!content.startsWith("---")) return null;
  const fmEnd = content.indexOf("---", 3);
  if (fmEnd === -1) return null;
  const body = content.slice(fmEnd + 3).trim();

  // Skip the heading line
  const lines = body.split("\n");
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "" || lines[i].startsWith("#")) {
      start = i + 1;
      continue;
    }
    break;
  }

  // Collect the first paragraph (until blank line or heading)
  const para: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) break;
    // Skip stub marker
    if (line.includes("Definition pending")) return null;
    para.push(line);
  }

  const text = para.join(" ").trim();
  return text.length > 20 ? text : null;
}

const conceptDefs: { name: string; path: string; definition: string }[] = [];
if (MODE === "concepts") {
  for (const c of concepts) {
    if (c.isStub) continue;
    const def = extractDefinition(c.path);
    if (def) conceptDefs.push({ name: c.name, path: c.path, definition: def });
  }

  if (conceptDefs.length === 0) {
    console.error("No non-stub concepts with definitions found. Nothing to compare.");
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Load and chunk source notes
// ---------------------------------------------------------------------------

interface Chunk {
  notePath: string;
  noteTitle: string;
  section: string;
  text: string;
  domain: string;
  existingLinks: Set<string>;
}

function extractWikilinks(text: string): Set<string> {
  const links = new Set<string>();
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    links.add(m[1].toLowerCase());
  }
  return links;
}

function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by space or newline
  const raw = text.split(/(?<=[.!?])\s+|\n+/);
  return raw
    .map((s) => s.trim())
    .filter((s) => {
      if (s.length === 0) return false;
      if (s.split(/\s+/).length <= 5) return false;
      // Skip markdown table rows — they embed as structural format, not semantic content
      if (s.startsWith("|") || s.startsWith("|-")) return false;
      // Skip bullet-point fragments that are just labels
      if (s.startsWith("- **") && s.split(/\s+/).length < 10) return false;
      // Skip any **Field:** or **Field** metadata lines — they embed as structure, not content
      if (/^\*\*\w[^*]*\*\*/.test(s)) return false;
      // Skip italic boilerplate lines (*Analysis generated...*, *Note:...*)
      if (/^\*[^*]+\*$/.test(s)) return false;
      // Skip reference list items (- Source Name: ..., - URL, - Wikipedia: ...)
      if (/^-\s+(?:https?:\/\/|[A-Z][\w\s]*:)/.test(s)) return false;
      // Skip ASCII art / box-drawing diagrams
      if (/[─━│┃┌┐└┘├┤┬┴┼╔╗╚╝║═►◄▶◀]/.test(s)) return false;
      // Skip enumeration fragments ("Hand 1  Hand 2  Hand 3", "Item 1  Item 2")
      if (/\w+\s+\d\s{2,}\w+\s+\d/.test(s)) return false;
      return true;
    });
}

function chunkNote(notePath: string, domain: string = "unknown"): Chunk[] {
  if (!existsSync(notePath)) return [];
  const content = readFileSync(notePath, "utf-8");

  // Extract frontmatter links (concepts already declared for this note)
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n?/);
  const frontmatter = fmMatch ? fmMatch[0] : "";
  const frontmatterLinks = extractWikilinks(frontmatter);
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;

  // Extract title from first heading or filename
  const titleMatch = body.match(/^#\s+(.+)/m);
  const noteTitle = titleMatch ? titleMatch[1].trim() : notePath.split("/").pop()?.replace(".md", "") ?? "";

  // Split by sections
  const sections: { heading: string; text: string }[] = [];
  let currentHeading = "(intro)";
  let currentLines: string[] = [];

  for (const line of body.split("\n")) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, text: currentLines.join("\n") });
      }
      currentHeading = line.trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    sections.push({ heading: currentHeading, text: currentLines.join("\n") });
  }

  // Skip boilerplate sections that produce structural matches, not semantic content
  const boilerplateHeadings = /^#{1,3}\s+(sources|references|bibliography|citation|metadata|links|related papers|further reading)\s*$/i;

  const chunks: Chunk[] = [];
  for (const sec of sections) {
    if (boilerplateHeadings.test(sec.heading)) continue;
    const sectionLinks = extractWikilinks(sec.text);
    const sentences = splitSentences(sec.text);

    // Single sentences
    for (const sent of sentences) {
      chunks.push({
        notePath,
        noteTitle,
        domain,
        section: sec.heading,
        text: sent,
        existingLinks: new Set([...frontmatterLinks, ...sectionLinks, ...extractWikilinks(sent)]),
      });
    }

    // 2-sentence sliding windows
    for (let i = 0; i < sentences.length - 1; i++) {
      const window = sentences[i] + " " + sentences[i + 1];
      chunks.push({
        notePath,
        noteTitle,
        domain,
        section: sec.heading,
        text: window,
        existingLinks: new Set([
          ...frontmatterLinks,
          ...sectionLinks,
          ...extractWikilinks(sentences[i]),
          ...extractWikilinks(sentences[i + 1]),
        ]),
      });
    }
  }

  return chunks;
}

// Build domain lookup from source index
const domainByPath = new Map<string, string>();
for (const s of sources) {
  domainByPath.set(s.path, s.domain);
}

// Determine which notes to scan
let notePaths: string[];
if (SINGLE_NOTE) {
  if (MODE === "notes" && !domainByPath.has(SINGLE_NOTE)) {
    console.error(`Note "${SINGLE_NOTE}" not found in source index — cannot determine domain for cross-domain comparison.`);
    console.error("Run 'commonplace index' first, or use --mode concepts instead.");
    process.exit(1);
  }
  // In notes mode, scan the single note against all other notes
  notePaths = MODE === "notes" ? sources.map((s) => s.path) : [SINGLE_NOTE];
} else {
  notePaths = sources.map((s) => s.path);
}

const allChunks: Chunk[] = [];
for (const p of notePaths) {
  const domain = domainByPath.get(p) ?? "unknown";
  allChunks.push(...chunkNote(p, domain));
}

if (allChunks.length === 0) {
  console.error("No text chunks found in source notes.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Embed via Ollama
// ---------------------------------------------------------------------------

async function embed(texts: string[]): Promise<Float32Array[]> {
  const BATCH_SIZE = 500;
  const vectors: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: batch }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Ollama embed error: ${res.status} ${err}`);
      process.exit(1);
    }

    const data = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings)) {
      console.error(`Ollama returned unexpected response (no embeddings array)`);
      process.exit(1);
    }
    for (const vec of data.embeddings) {
      vectors.push(new Float32Array(vec));
    }
  }

  if (vectors.length !== texts.length) {
    console.error(`Embedding count mismatch: sent ${texts.length}, got ${vectors.length}`);
    process.exit(1);
  }
  return vectors;
}

// Pre-normalize for fast cosine similarity (dot product = cosine after normalization)
function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

const embedStart = Date.now();

// Embed chunks (used by both modes)
const chunkTexts = allChunks.map((c) => c.text);
const chunkVectors = (await embed(chunkTexts)).map(normalize);

// Embed concepts (concepts mode only)
let conceptVectors: Float32Array[] = [];
if (MODE === "concepts") {
  const conceptTexts = conceptDefs.map((c) => c.definition);
  conceptVectors = (await embed(conceptTexts)).map(normalize);
}

const embedTimeMs = Date.now() - embedStart;

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

const compareStart = Date.now();

if (MODE === "concepts") {
  // --- Concepts mode: chunks → concept definitions ---

  interface ConceptCandidate {
    note: string;
    noteTitle: string;
    section: string;
    sentence: string;
    concept: string;
    conceptPath: string;
    similarity: number;
  }

  const allCandidates: ConceptCandidate[] = [];

  for (let ci = 0; ci < conceptDefs.length; ci++) {
    const concept = conceptDefs[ci];
    const conceptNameLower = concept.name.toLowerCase();

    for (let chi = 0; chi < allChunks.length; chi++) {
      const chunk = allChunks[chi];

      // Filter: already linked
      if (chunk.existingLinks.has(conceptNameLower)) continue;

      // Filter: name mentioned literally (string-matching linker's job)
      if (chunk.text.toLowerCase().includes(conceptNameLower)) continue;

      // Filter: don't suggest links in concept notes
      if (chunk.notePath === concept.path) continue;

      const sim = dot(chunkVectors[chi], conceptVectors[ci]);
      if (sim >= THRESHOLD) {
        allCandidates.push({
          note: relative(vaultPath, chunk.notePath),
          noteTitle: chunk.noteTitle,
          section: chunk.section,
          sentence: chunk.text.slice(0, 200),
          concept: concept.name,
          conceptPath: relative(vaultPath, concept.path),
          similarity: Math.round(sim * 1000) / 1000,
        });
      }
    }
  }

  const compareTimeMs = Date.now() - compareStart;

  // Group by note, sort, cap
  const byNote = new Map<string, ConceptCandidate[]>();
  for (const c of allCandidates) {
    const arr = byNote.get(c.note) ?? [];
    arr.push(c);
    byNote.set(c.note, arr);
  }

  const candidates: ConceptCandidate[] = [];
  for (const [, arr] of byNote) {
    arr.sort((a, b) => b.similarity - a.similarity);
    candidates.push(...arr.slice(0, TOP_PER_NOTE));
  }
  candidates.sort((a, b) => b.similarity - a.similarity);

  console.log(JSON.stringify({
    mode: "concepts",
    candidates,
    stats: {
      notesScanned: notePaths.length,
      conceptsEmbedded: conceptDefs.length,
      chunksEmbedded: allChunks.length,
      candidatesFound: candidates.length,
      embedTimeMs,
      compareTimeMs,
    },
  }, null, 2));

} else {
  // --- Notes mode: cross-domain chunk-to-chunk ---

  interface NotePairCandidate {
    noteA: string;
    noteTitleA: string;
    sectionA: string;
    sentenceA: string;
    domainA: string;
    noteB: string;
    noteTitleB: string;
    sectionB: string;
    sentenceB: string;
    domainB: string;
    similarity: number;
  }

  // Build set of shared concepts between note pairs for filtering
  const conceptsByNote = new Map<string, Set<string>>();
  for (const s of sources) {
    conceptsByNote.set(s.path, new Set(s.concepts.map((c) => c.toLowerCase())));
  }

  const allCandidates: NotePairCandidate[] = [];

  // To avoid duplicate pairs, only compare chi < chj
  for (let chi = 0; chi < allChunks.length; chi++) {
    const chunkA = allChunks[chi];
    if (chunkA.domain === "unknown") continue;

    for (let chj = chi + 1; chj < allChunks.length; chj++) {
      const chunkB = allChunks[chj];

      // Cross-domain only
      if (chunkA.domain === chunkB.domain) continue;

      // Skip pairs from the same note
      if (chunkA.notePath === chunkB.notePath) continue;

      const sim = dot(chunkVectors[chi], chunkVectors[chj]);
      if (sim >= THRESHOLD) {
        allCandidates.push({
          noteA: relative(vaultPath, chunkA.notePath),
          noteTitleA: chunkA.noteTitle,
          sectionA: chunkA.section,
          sentenceA: chunkA.text.slice(0, 200),
          domainA: chunkA.domain,
          noteB: relative(vaultPath, chunkB.notePath),
          noteTitleB: chunkB.noteTitle,
          sectionB: chunkB.section,
          sentenceB: chunkB.text.slice(0, 200),
          domainB: chunkB.domain,
          similarity: Math.round(sim * 1000) / 1000,
        });
      }
    }
  }

  const compareTimeMs = Date.now() - compareStart;

  // Deduplicate: keep highest-similarity pair per (noteA, noteB) combination
  const byNotePair = new Map<string, NotePairCandidate[]>();
  for (const c of allCandidates) {
    const key = [c.noteA, c.noteB].sort().join("|||");
    const arr = byNotePair.get(key) ?? [];
    arr.push(c);
    byNotePair.set(key, arr);
  }

  const candidates: NotePairCandidate[] = [];
  for (const [, arr] of byNotePair) {
    arr.sort((a, b) => b.similarity - a.similarity);
    candidates.push(...arr.slice(0, 3)); // top 3 sentence pairs per note pair
  }
  candidates.sort((a, b) => b.similarity - a.similarity);

  // Count unique note pairs and domains
  const uniquePairs = new Set(
    candidates.map((c) => [c.noteA, c.noteB].sort().join("|||"))
  );
  const domainsInvolved = new Set(
    candidates.flatMap((c) => [c.domainA, c.domainB])
  );

  console.log(JSON.stringify({
    mode: "notes",
    candidates,
    stats: {
      notesScanned: notePaths.length,
      chunksEmbedded: allChunks.length,
      candidatesFound: candidates.length,
      uniqueNotePairs: uniquePairs.size,
      domainsInvolved: [...domainsInvolved],
      embedTimeMs,
      compareTimeMs,
    },
  }, null, 2));
}
