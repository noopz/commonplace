/**
 * Vault-intent regex set, shared by agent-guard (PreToolUse) and
 * prompt-context (UserPromptSubmit). Both hooks need the same answer to
 * "does this prompt look vault-shaped?" — keeping the patterns in one
 * place avoids them drifting apart.
 *
 * Folder markers use [\\/] to match either separator so .wiki\foo on
 * Windows and .wiki/foo on POSIX both hit.
 */
// Precision over recall: this guard only blocks Agent/Task dispatches, and
// wiki-query already auto-triggers as a skill, so a missed signal costs at most
// one inefficient dispatch. A false positive, by contrast, BLOCKS legitimate
// work — including dev tasks in unrelated repos, since this is a global plugin
// hook. So every signal here must be one that effectively never appears outside
// a genuine vault-content question. Bare words that collide with normal dev
// vocabulary ("vault" → HashiCorp Vault, "MOC", "commonplace", bash "[[ ]]")
// are deliberately excluded or verb-gated.
export const VAULT_SIGNALS: RegExp[] = [
  // wiki-* skill / agent names — unambiguous vault tooling.
  /\bwiki-(query|ingest|domain|compile|deep-linker|moc-updater|linter|pruner|freshness-checker|domain-manager|conventions-tuner|cross-domain-linker|impact-checker)\b/i,
  // commonplace CLI invocation — require a known subcommand; the bare project
  // name matched far too much (esp. when developing commonplace itself).
  /\bcommonplace\s+(query|ingest|index|lint|validate|scope-check|score|prune|init|post-write|raw|freshen|deep-link|log|supersede|vault-path|config|paper:)/i,
  // Obsidian-specific phrasing only — generic "the/my vault" hit HashiCorp Vault.
  /\bobsidian\s+vault\b/i,
  /\b(concept|source|MOC)\s+note\b/i,
  /\bmy\s+notes\s+(on|about|say)\b/i,
  /\.wiki[\\/]/,
  /\.obsidian[\\/]/,
  // [[Wikilink]] syntax. The (?!\s) lookahead rejects a bash `[[ -f x ]]` test,
  // which always has whitespace after the brackets; real wikilinks never do.
  /\[\[(?!\s)[^\[\]\n]+\]\]/,
];

export function hasVaultIntent(text: string, vaultPaths?: string | string[]): boolean {
  if (VAULT_SIGNALS.some((re) => re.test(text))) return true;
  const paths = vaultPaths == null ? [] : Array.isArray(vaultPaths) ? vaultPaths : [vaultPaths];
  if (paths.length > 0) {
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
    const t = norm(text);
    if (paths.some((p) => p && t.includes(norm(p)))) return true;
  }
  return false;
}
