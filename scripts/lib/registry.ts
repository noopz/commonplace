/**
 * Pure registry logic — no fs, no env, no process. The disk/env wrapper
 * lives in vault.ts. Keeping this module side-effect-free makes the
 * selection rules unit-testable.
 */

export interface VaultRegistryEntry {
  id: string;
  path: string; // absolute
  label: string;
  aliases: string[];
}

export interface VaultRegistry {
  default: string | null; // id of the global-default vault
  vaults: VaultRegistryEntry[];
}

export const EMPTY_REGISTRY: VaultRegistry = { default: null, vaults: [] };

export function parseRegistry(json: string): VaultRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return EMPTY_REGISTRY;
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { vaults?: unknown }).vaults)) {
    return EMPTY_REGISTRY;
  }
  const obj = raw as { default?: unknown; vaults: unknown[] };
  const vaults: VaultRegistryEntry[] = [];
  for (const v of obj.vaults) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.path !== "string") continue;
    vaults.push({
      id: e.id,
      path: e.path,
      label: typeof e.label === "string" ? e.label : e.id,
      aliases: Array.isArray(e.aliases) ? e.aliases.filter((a): a is string => typeof a === "string") : [],
    });
  }
  const def = typeof obj.default === "string" && vaults.some((v) => v.id === obj.default)
    ? obj.default
    : null;
  return { default: def, vaults };
}

export function findById(reg: VaultRegistry, id: string): VaultRegistryEntry | undefined {
  return reg.vaults.find((v) => v.id === id);
}

export function getDefaultEntry(reg: VaultRegistry): VaultRegistryEntry | undefined {
  if (!reg.default) return undefined;
  return findById(reg, reg.default);
}

/**
 * Find registry entries whose id, label, or any alias appears as a whole
 * word in `phrase`. Whole-word matching avoids "a" matching inside
 * "search". Returns ALL matches so the caller can disambiguate (ask the
 * user) when more than one vault matches.
 */
export function matchByPhrase(reg: VaultRegistry, phrase: string): VaultRegistryEntry[] {
  const hay = ` ${phrase.toLowerCase()} `;
  const hasWord = (needle: string): boolean => {
    const n = needle.toLowerCase().trim();
    if (!n) return false;
    // word boundary on both sides; escape regex metacharacters in the needle
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(hay);
  };
  const hasWordComponent = (needle: string): boolean => {
    // Check if the whole needle matches, or any alphanumeric component of it
    if (hasWord(needle)) return true;
    // Split by non-alphanumerics and check if any component matches
    const components = needle.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return components.some(hasWord);
  };
  return reg.vaults.filter((v) =>
    hasWordComponent(v.id) || hasWordComponent(v.label) || v.aliases.some(hasWordComponent),
  );
}
