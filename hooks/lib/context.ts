/**
 * First-message context block for the `prompt.context` function hook.
 *
 * Replaces `scripts/prompt-context.ts` (a `UserPromptSubmit` shell hook that
 * spawned node on every prompt and re-counted three indexes each time).
 * `prompt.context` fires once per conversation and is cached, so the block is
 * computed once and can be read like a briefing rather than a reminder.
 *
 * Pure — no `$`, no Node builtins. `hooks/register.ts` gathers the facts
 * (vault resolution, index line counts, conventions.json) and passes them in
 * as plain data; everything that decides what gets said lives here so it can
 * be unit-tested without a filesystem.
 */

/** Name of the block this plugin contributes. Stable so re-runs replace, not stack. */
export const VAULT_BLOCK_NAME = "commonplaceVault";

export interface ContextBlock {
  name: string;
  text: string;
}

/** Everything the block needs to know, gathered by the caller. */
export interface VaultFacts {
  /** Resolved vault root, or null when the plugin is not configured for any vault. */
  vaultPath: string | null;
  /** True when the conversation's cwd is inside `vaultPath`. */
  inVault: boolean;
  sources: number;
  concepts: number;
  mocs: number;
  /** Genres in `.wiki/conventions.json` that have no rules yet. */
  untunedGenres: string[];
}

/**
 * Build the plugin's context block, or null when there is nothing to orient
 * the model with: no configured vault, or an in-vault session on a vault with
 * no ingested sources (the indexes are empty, so nothing below would be true).
 *
 * Two tiers, matching the shell hook's shape — though NOT its gating; see the
 * note on the deleted vault-intent heuristic below:
 *
 *   - Outside the vault: one paragraph. The vault exists at <path>; route reads
 *     through wiki-query and writes through wiki-ingest rather than touching
 *     vault files directly. Skill name + description are always loaded by the
 *     engine, so the block does not teach what those skills are — only that
 *     they, not bare Grep/Edit, are the way in.
 *
 *   - Inside the vault: a short briefing. What survived from the ~800-word
 *     original is the information the model cannot infer on its own:
 *       * where the vault is and how big it is (grounds "is this worth a
 *         wiki-query?" and "how many hits should I expect?");
 *       * the index files and their record shapes (a Grep against a JSONL
 *         index only works if you know the field names);
 *       * the routing rule — skills for structural operations, direct edits of
 *         existing note bodies are fine, direct Grep is fine for a narrow
 *         lookup but questions go through wiki-query;
 *       * three facts about the toolchain that are not guessable and are
 *         costly to get wrong: `paper:*` over pdftotext, `commonplace`
 *         commands + Grep/Read over ad-hoc parsing scripts, `raw/` is
 *         immutable;
 *       * untuned genres, because that is actionable state, not a rule.
 *     What was cut: the per-skill bullet list (the engine already loads every
 *     skill's description), the "proactively offer to save / run a pre-ingest
 *     relevance check" paragraph (that behaviour is the wiki-ingest and
 *     wiki-query trigger descriptions' job, and restating it here is what made
 *     the old hook read as nagging), and the repeated "use the vault instead of
 *     Claude's memory" framing, which is now a single clause.
 */
export function buildVaultBlock(v: VaultFacts): ContextBlock | null {
  if (!v.vaultPath) return null;

  if (!v.inVault) {
    return {
      name: VAULT_BLOCK_NAME,
      text:
        `The user's commonplace vault is at ${v.vaultPath}. Route vault reads through the ` +
        `wiki-query skill (iterative search, MOC traversal, file-back) and vault writes through ` +
        `wiki-ingest. Don't grep or edit vault files directly from here — the skills keep the ` +
        `structure consistent the way a linter would.`,
    };
  }

  if (v.sources <= 0) return null;

  const wiki = `${v.vaultPath}/.wiki`;
  const lines = [
    `The commonplace vault at ${v.vaultPath} is active in this session ` +
      `(${v.sources} sources, ${v.concepts} concepts, ${v.mocs} MOCs). ` +
      `It is the user's persistent knowledge base — prefer it over Claude's memory.`,
    ``,
    `Routing: use the plugin's skills for structural operations (new source/concept notes, ` +
      `domains, indexes); editing an existing note's body directly is fine. Questions whose ` +
      `answer may live in notes go through wiki-query; direct Grep is fine for a narrow lookup ` +
      `(a known title or path).`,
    ``,
    `Indexes at ${wiki}/ — one JSON record per line, so Grep returns whole records:`,
    `- source-index.jsonl {title, path, domain, scope, tags, concepts, mocs}`,
    `- concept-index.jsonl {name, path, domains, backlinkCount, isStub}`,
    `- moc-index.jsonl {name, path, sourceCount, sources}`,
    `- domain-index.jsonl {domain, scope, sourceCount, conceptCount}`,
    ``,
    `Toolchain: \`commonplace paper:*\` for research papers (not pdftotext); \`commonplace\` ` +
      `commands plus Grep/Read for any vault analysis (never ad-hoc Python/shell parsing); ` +
      `files under raw/ are permanent originals — never modify, rename, or delete them.`,
  ];

  if (v.untunedGenres.length > 0) {
    lines.push(
      ``,
      `${v.untunedGenres.length} genre(s) have no conventions rules yet: ` +
        `${v.untunedGenres.join(", ")}. The wiki-conventions-tuner agent can propose them.`,
    );
  }

  return { name: VAULT_BLOCK_NAME, text: lines.join("\n") };
}

/**
 * Merge our block into the engine's list. Core blocks (`claudeMd`, `userEmail`,
 * `attachedProject`, `currentDate`, and anything else we did not author) are
 * never touched or reordered. If a block with our name is already present it
 * is replaced in place; otherwise ours is appended; if `ours` is null any
 * previous copy of ours is removed. Applying the merge twice yields the same
 * list, which matters because the engine may re-run the hook after a cache
 * invalidation against a list that already contains our block.
 */
export function mergeBlocks(
  existing: readonly ContextBlock[],
  ours: ContextBlock | null,
): ContextBlock[] {
  const name = ours?.name ?? VAULT_BLOCK_NAME;
  const out: ContextBlock[] = [];
  let placed = false;
  for (const b of existing) {
    if (b.name === name) {
      if (ours && !placed) {
        out.push(ours);
        placed = true;
      }
      continue; // drop stale/duplicate copies of our own block only
    }
    out.push(b);
  }
  if (ours && !placed) out.push(ours);
  return out;
}

/*
 * VAULT_SIGNALS / vaultIntent used to live here — a port of
 * `scripts/lib/vault-signals.ts`, which gated the OLD shell hook so it only
 * injected context when the user's prompt mentioned the vault. It was never
 * called from `register.ts` and is deleted rather than kept as ballast.
 *
 * The gate is genuinely gone, and that IS a behaviour change: the
 * outside-vault paragraph now goes into every conversation in every repo.
 * That is an accepted trade, not an oversight. `prompt.context` builds a real
 * context block ONCE PER CONVERSATION, where the shell hook injected
 * transcript text on EVERY prompt — so the thing the gate protected against
 * (repeating ~150 words at someone working in an unrelated repo) is already
 * two orders of magnitude smaller. Gating it again would need `prompt.submit`
 * to stash the prompt text and `$.ui.invalidate("prompt.context")` to force a
 * rebuild, which is real ordering complexity to save one short paragraph once.
 *
 * If the block ever grows back toward its original size, restore the gate —
 * `scripts/lib/vault-signals.ts` still has the regexes and their rationale.
 */
