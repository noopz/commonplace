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
