---
name: wiki-deep-link
description: "User-invoked: surface hidden concept connections via local embeddings (Ollama + nomic-embed-text). Flags related-but-unlinked (sentence, concept) pairs, then adds wikilinks where the connection holds. Invoke explicitly via /wiki-deep-link."
compatibility: Requires Ollama running locally with the nomic-embed-text model pulled.
disable-model-invocation: true
---

# Wiki Deep Link

Surface implicit concept connections that string-matching can't find. A paragraph discussing "iteratively adjusting parameters to minimize loss" should link to [[gradient descent]] even though the name never appears — this skill finds those connections.

## Why This Exists

The concept-linker handles exact name matches. But as the vault grows, agents traversing the knowledge graph hit blind spots where two things are clearly related but no wikilink connects them. This skill uses embedding similarity as a cheap pre-filter to surface candidates, then a Haiku agent reads the actual text and decides which connections to add.

This is not RAG. Nothing is retrieved at query time. This is a batch graph-improvement tool that strengthens the links future agents will traverse via wiki-query.

## Prerequisites

This skill requires Ollama running locally with the `nomic-embed-text` model. If not available, tell the user:

```
Deep linking requires Ollama with nomic-embed-text:
  1. Install Ollama: https://ollama.com
  2. Pull the model: ollama pull nomic-embed-text
  3. Start Ollama: ollama serve
```

## Workflow

### Step 1: Run the pre-filter

```bash
commonplace deep-link
```

Or scoped to a single note (useful after ingesting a new source):
```bash
commonplace deep-link --note "$VAULT_PATH/path/to/note.md"
```

Flags:
- `--threshold <float>` — similarity cutoff (default 0.7, lower to 0.55 for more candidates at lower confidence)
- `--top <int>` — max candidates per note (default 10)

The script embeds concept definitions and note sentences, compares them, filters out already-linked and name-mentioned pairs, and outputs candidates as JSON.

### Step 2: Review the output

Present a summary to the user:
```
Deep link scan complete:
  45 notes scanned, 82 concepts compared
  2,400 text chunks embedded in 12s
  47 candidate connections found across 18 notes
```

If zero candidates: "No hidden connections found — the vault's graph looks well-linked for the current concept definitions."

### Step 3: Dispatch the linking agent

If candidates were found, dispatch the `wiki-deep-linker` agent with the candidates JSON and vault path inline. The agent reads the actual text of each candidate pair, applies its built-in linking rules, and adds wikilinks where warranted.

Agents have isolated context windows — they cannot see this conversation. Include the full candidates JSON and vault path in the agent prompt.

### Step 4: Rebuild index and report

After the agent completes:

```bash
commonplace index --incremental
```

Report what was linked:
- How many connections were added
- Which notes were updated
- How many candidates were rejected (the agent reports rejection reasons)

### Log

```bash
commonplace log --entry "## [$(date +%Y-%m-%d)] deep-link | Semantic linking pass\n- Scanned N notes, found N candidates, linked N connections\n"
```
