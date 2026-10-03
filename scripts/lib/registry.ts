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
  /**
   * A private vault is explicit-entry: it is selected only by an explicit
   * `--vault`, a pin, or a session that starts inside it — never as the
   * registry default, which every unrelated repo falls back to.
   */
  isPrivate?: boolean;
}

export interface VaultRegistry {
  default: string | null; // id of the global-default vault
  vaults: VaultRegistryEntry[];
}

export const EMPTY_REGISTRY: VaultRegistry = Object.freeze({ default: null, vaults: Object.freeze([]) as unknown as VaultRegistryEntry[] }) as VaultRegistry;

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
      ...(e.isPrivate === true ? { isPrivate: true } : {}),
    });
  }
  // A private vault named as default (hand-edited registry) is ignored rather
  // than honoured: the default is what an unrelated repo falls back to.
  const def = typeof obj.default === "string" &&
    vaults.some((v) => v.id === obj.default && !v.isPrivate)
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

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "vault";
}

/** Return a new registry with `entry` added or replacing one of the same id/path. */
export function addVault(reg: VaultRegistry, entry: VaultRegistryEntry): VaultRegistry {
  const vaults = reg.vaults.filter((v) => v.id !== entry.id && v.path !== entry.path);
  vaults.push(entry);
  // A private vault never becomes the default by being first.
  const keep = reg.default && vaults.some((v) => v.id === reg.default) ? reg.default : null;
  const def = keep ?? (entry.isPrivate ? null : entry.id);
  return { default: def, vaults };
}

/** Find a vault by id, alias or label (case-insensitive), or by absolute path. */
export function findByRef(reg: VaultRegistry, ref: string): VaultRegistryEntry | undefined {
  const r = ref.trim().toLowerCase();
  if (!r) return undefined;
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  return (
    reg.vaults.find((v) => v.id.toLowerCase() === r) ??
    reg.vaults.find((v) => v.aliases.some((a) => a.toLowerCase() === r)) ??
    reg.vaults.find((v) => v.label.toLowerCase() === r) ??
    reg.vaults.find((v) => norm(v.path) === norm(ref.trim()))
  );
}

/** Make `id` the default. Refuses a private vault (returns an error string). */
export function setDefault(reg: VaultRegistry, id: string): VaultRegistry | string {
  const entry = findById(reg, id);
  if (!entry) return `no vault with id "${id}"`;
  if (entry.isPrivate) {
    return `"${id}" is private and cannot be the default — pin it per project with \`commonplace vault use ${id}\` instead`;
  }
  return { default: id, vaults: reg.vaults };
}

// ---------------------------------------------------------------------------
// Project pins — `commonplace vault use <id>` / `/vault use <id>`
// ---------------------------------------------------------------------------

/** project root (absolute) → vault id. One file shared by the CLI and the module. */
export type VaultPins = Record<string, string>;

export function parsePins(json: string): VaultPins {
  try {
    const raw = JSON.parse(json);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: VaultPins = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * The pin governing `cwd`: the longest pinned root that equals or contains it.
 * Longest wins so a pin on a subproject overrides one on its monorepo.
 */
export function pinFor(pins: VaultPins, cwd: string): string | undefined {
  const c = cwd.replace(/[\\/]+$/, "");
  let best: string | undefined;
  for (const root of Object.keys(pins)) {
    const r = root.replace(/[\\/]+$/, "");
    if ((c === r || c.startsWith(`${r}/`)) && (!best || r.length > best.length)) best = r;
  }
  return best === undefined ? undefined : pins[best] ?? pins[`${best}/`];
}

/** Build a single-entry registry from a legacy `.vault-path` value. */
export function migrateFromVaultPath(vaultPath: string): VaultRegistry {
  const base = vaultPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "vault";
  const id = slugify(base);
  return { default: id, vaults: [{ id, path: vaultPath, label: base, aliases: [] }] };
}
