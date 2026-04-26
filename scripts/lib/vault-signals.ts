/**
 * Vault-intent regex set, shared by agent-guard (PreToolUse) and
 * prompt-context (UserPromptSubmit). Both hooks need the same answer to
 * "does this prompt look vault-shaped?" — keeping the patterns in one
 * place avoids them drifting apart.
 *
 * Folder markers use [\\/] to match either separator so .wiki\foo on
 * Windows and .wiki/foo on POSIX both hit.
 */
export const VAULT_SIGNALS: RegExp[] = [
  /\bwiki-(query|ingest|domain|compile|deep-linker|moc-updater|linter|pruner|freshness-checker|domain-manager|conventions-tuner|cross-domain-linker|impact-checker)\b/i,
  /\bcommonplace\b/i,
  /\bMOC\b/,
  /\bobsidian\s+vault\b/i,
  /\b(my|the)\s+vault\b/i,
  /\b(concept|source|MOC)\s+note\b/i,
  /\bmy\s+notes\s+(on|about|say)\b/i,
  /\.wiki[\\/]/,
  /\.obsidian[\\/]/,
  /\[\[[^\[\]\n]+\]\]/, // [[Wikilink]] syntax — unmistakable vault-intent marker
];

export function hasVaultIntent(text: string, vaultPath?: string): boolean {
  if (VAULT_SIGNALS.some((re) => re.test(text))) return true;
  if (vaultPath) {
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
    if (norm(text).includes(norm(vaultPath))) return true;
  }
  return false;
}
