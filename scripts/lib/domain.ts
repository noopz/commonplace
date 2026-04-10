import type { DomainRegistry } from "./types.js";

/**
 * Infer domain slug from a source note's file path.
 * Domain = parent directory name under the matching registry path.
 */
export function inferSourceDomain(
  filePath: string,
  vaultPath: string,
  registry: DomainRegistry
): string {
  const relative = filePath.startsWith(vaultPath)
    ? filePath.slice(vaultPath.length + 1)
    : filePath;

  for (const [slug, entry] of Object.entries(registry.domains)) {
    if (relative.startsWith(entry.path)) {
      return slug;
    }
  }

  return "unknown";
}

/**
 * Infer concept domains from backlinks.
 * A concept belongs to every domain that references it.
 */
export function inferConceptDomains(
  conceptName: string,
  sourcesByDomain: Map<string, Set<string>>
): string[] {
  const domains: string[] = [];
  for (const [domain, concepts] of sourcesByDomain) {
    if (concepts.has(conceptName)) {
      domains.push(domain);
    }
  }
  return [...new Set(domains)];
}

export function lookupScope(
  domain: string,
  registry: DomainRegistry
): "professional" | "hobby" {
  return registry.domains[domain]?.scope ?? "professional";
}

/**
 * Normalize a concept name to a slug for near-duplicate comparison.
 * Lowercase, strip hyphens/spaces, remove common stop words.
 */
export function normalizeConceptSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-\s]+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Check if a concept name looks like a sentence fragment rather than a real concept.
 * Returns true if the name is likely malformed.
 */
export function isMalformedConceptName(name: string): boolean {
  const words = name.trim().split(/\s+/);

  // Too many words for a concept name
  if (words.length > 6) return true;

  // Ends with common mid-sentence words
  const lastWord = words[words.length - 1].toLowerCase();
  const midSentenceEndings = [
    "and", "or", "the", "a", "an", "to", "of", "in", "for",
    "with", "on", "at", "by", "from", "as", "is", "are", "was",
    "were", "be", "been", "being", "have", "has", "had", "do",
    "does", "did", "will", "would", "could", "should", "may",
    "might", "shall", "can", "that", "which", "who", "whom",
    "both", "either", "neither", "not", "only", "also",
  ];
  if (midSentenceEndings.includes(lastWord)) return true;

  return false;
}
