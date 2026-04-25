import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "fs";
import { join, resolve, dirname, relative as relPath } from "path";
import { glob } from "glob";
import type {
  VaultConfig,
  WikiConfig,
  DomainRegistry,
  NoteType,
  SourceNote,
  ConceptNote,
  MocNote,
} from "./types.js";

const EMPTY_REGISTRY: DomainRegistry = { domains: {} };

export function getVaultConfig(vaultPath: string): VaultConfig {
  const resolved = resolve(vaultPath);
  return {
    vaultPath: resolved,
    wikiPath: join(resolved, ".wiki"),
    claudeMdPath: join(resolved, "CLAUDE.md"),
  };
}

export function discoverVault(startPath: string): string | null {
  let current = resolve(startPath);
  while (current !== "/") {
    // Obsidian vault marker
    if (existsSync(join(current, ".obsidian"))) return current;
    // Already-initialized wiki folder (any markdown depot, no Obsidian required)
    if (existsSync(join(current, ".wiki"))) return current;
    current = resolve(current, "..");
  }
  return null;
}

export function resolveVault(explicitPath?: string): VaultConfig {
  let vaultPath: string | null = null;

  if (explicitPath) {
    vaultPath = resolve(explicitPath);
  } else {
    // Prefer configured vault — if the user ran `init`, that vault wins
    // Check CLAUDE_PLUGIN_DATA first (survives plugin updates), fall back to plugin root
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    const pluginRoot = resolve(import.meta.dirname!, "..", "..");
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const locations = [
      ...(dataDir ? [join(dataDir, ".vault-path")] : []),
      join(pluginRoot, ".vault-path"),
    ];
    // Scan all possible plugin data dirs (marketplace name varies)
    if (homeDir) {
      try {
        const pluginDataRoot = join(homeDir, ".claude", "plugins", "data");
        for (const dir of readdirSync(pluginDataRoot)) {
          if (dir.startsWith("commonplace-")) {
            locations.push(join(pluginDataRoot, dir, ".vault-path"));
          }
        }
      } catch {}
    }
    for (const loc of locations) {
      try {
        const stored = readFileSync(loc, "utf-8").trim();
        if (stored && existsSync(stored)) { vaultPath = stored; break; }
      } catch {}
    }

    // Fall back to cwd discovery (walk up looking for .obsidian/ or .wiki/)
    // Use caller's cwd if available (bin/commonplace sets COMMONPLACE_CALLER_CWD)
    if (!vaultPath) {
      const callerCwd = process.env.COMMONPLACE_CALLER_CWD || process.cwd();
      vaultPath = discoverVault(callerCwd);
    }
  }

  if (!vaultPath) {
    console.error(
      "Error: Could not find vault. Run from vault directory or pass --vault <path>"
    );
    process.exit(1);
  }

  return getVaultConfig(vaultPath);
}

export function loadWikiConfig(config: VaultConfig): WikiConfig | null {
  const configPath = join(config.wikiPath, "config.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as WikiConfig;
  } catch {
    console.error(`Warning: Failed to parse ${configPath}, ignoring wiki config`);
    return null;
  }
}

export function loadDomainRegistry(wikiPath: string): DomainRegistry {
  const domainsPath = join(wikiPath, "domains.json");
  if (!existsSync(domainsPath)) return EMPTY_REGISTRY;
  try {
    return JSON.parse(readFileSync(domainsPath, "utf-8")) as DomainRegistry;
  } catch {
    console.error("Warning: Could not parse domains.json, using empty registry");
    return EMPTY_REGISTRY;
  }
}

export function saveDomainRegistry(wikiPath: string, registry: DomainRegistry): void {
  writeFileSync(join(wikiPath, "domains.json"), JSON.stringify(registry, null, 2) + "\n");
}

/**
 * Auto-register a domain for a note in an unregistered path.
 * Derives slug from the deepest meaningful directory segment.
 * Returns the new domain slug, or null if registration fails.
 */
export function autoRegisterDomain(
  filePath: string,
  vaultPath: string,
  wikiPath: string,
  registry: DomainRegistry,
): string | null {
  const rel = filePath.startsWith(vaultPath + "/")
    ? filePath.slice(vaultPath.length + 1)
    : filePath;
  const dir = dirname(rel);
  if (!dir || dir === ".") return null;

  // Check if this path is already covered by an existing domain
  for (const entry of Object.values(registry.domains)) {
    if (rel.startsWith(entry.path + "/")) return null;
  }

  // Use the full directory path as the domain path (e.g., "04 - Explorations/FPV")
  // Slug from the deepest segment (e.g., "fpv")
  const segments = dir.split("/");
  const deepest = segments[segments.length - 1];
  const slug = deepest.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) return null;

  // Avoid slug collisions — append parent if needed
  let finalSlug = slug;
  if (registry.domains[finalSlug]) {
    const parent = segments.length > 1 ? segments[segments.length - 2] : "";
    const parentSlug = parent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    finalSlug = parentSlug ? `${parentSlug}-${slug}` : slug;
    if (registry.domains[finalSlug]) return null; // give up on double collision
  }

  registry.domains[finalSlug] = { path: dir, scope: "public" };
  saveDomainRegistry(wikiPath, registry);
  return finalSlug;
}

// Cache config.json per vault path so classifyNote doesn't hit disk on every call
const _wikiConfigCache = new Map<string, WikiConfig | null>();

function loadWikiConfigCached(vaultPath: string): WikiConfig | null {
  if (_wikiConfigCache.has(vaultPath)) return _wikiConfigCache.get(vaultPath)!;
  const configPath = join(vaultPath, ".wiki", "config.json");
  let cfg: WikiConfig | null = null;
  if (existsSync(configPath)) {
    try { cfg = JSON.parse(readFileSync(configPath, "utf-8")) as WikiConfig; } catch { /* ignore */ }
  }
  _wikiConfigCache.set(vaultPath, cfg);
  return cfg;
}

// Cache domains.json per wiki path
const _registryCache = new Map<string, DomainRegistry>();

export function loadDomainRegistryCached(wikiPath: string): DomainRegistry {
  if (_registryCache.has(wikiPath)) return _registryCache.get(wikiPath)!;
  const reg = loadDomainRegistry(wikiPath);
  _registryCache.set(wikiPath, reg);
  return reg;
}

export function clearRegistryCache(): void {
  _registryCache.clear();
}

export function classifyNote(
  filePath: string,
  vaultPath: string,
  wikiConfig?: WikiConfig | null,
  registry?: DomainRegistry,
): NoteType {
  const relative = filePath.startsWith(vaultPath + "/")
    ? filePath.slice(vaultPath.length + 1)
    : filePath;

  // Load from config.json if not explicitly provided — never fall back to hardcoded PARA paths
  const cfg = wikiConfig ?? loadWikiConfigCached(vaultPath);
  const sources = cfg?.structure.sources ?? "";
  const concepts = cfg?.structure.concepts ?? "";
  const mocs = cfg?.structure.mocs ?? "";

  if (sources && relative.startsWith(sources + "/")) return "source";
  if (concepts && relative.startsWith(concepts + "/")) return "concept";
  if (mocs && relative.startsWith(mocs + "/")) return "moc";

  // Fallback: check if note is in a registered domain path
  const wikiPath = join(vaultPath, ".wiki");
  const reg = registry ?? loadDomainRegistryCached(wikiPath);
  for (const entry of Object.values(reg.domains)) {
    if (relative.startsWith(entry.path + "/")) return "source";
  }

  return "other";
}

export async function findNotesByGlob(
  vaultPath: string,
  pattern: string
): Promise<string[]> {
  const matches = await glob(pattern, { cwd: vaultPath, absolute: true });
  return matches.filter((f) => f.endsWith(".md"));
}

export async function findAllNotes(vaultPath: string): Promise<string[]> {
  return findNotesByGlob(vaultPath, "**/*.md");
}

export function isInVault(filePath: string, vaultPath: string): boolean {
  const resolved = resolve(filePath);
  const vaultResolved = resolve(vaultPath);
  // Trailing "/" prevents `/Vault` matching `/VaultArchive/...`
  return resolved.startsWith(vaultResolved + "/") && resolved.endsWith(".md");
}

/** Parse a JSONL file (one JSON object per line) into an array */
function parseJsonl<T>(filePath: string): T[] {
  return readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(line => line)
    .map(line => JSON.parse(line) as T);
}

export function loadIndexes(config: VaultConfig): {
  sources: SourceNote[];
  concepts: ConceptNote[];
  mocs: MocNote[];
} {
  return {
    sources: parseJsonl<SourceNote>(join(config.wikiPath, "source-index.jsonl")),
    concepts: parseJsonl<ConceptNote>(join(config.wikiPath, "concept-index.jsonl")),
    mocs: parseJsonl<MocNote>(join(config.wikiPath, "moc-index.jsonl")),
  };
}

export function ensureIndex(config: VaultConfig): boolean {
  if (
    existsSync(join(config.wikiPath, "source-index.jsonl")) &&
    existsSync(join(config.wikiPath, ".last-index"))
  ) {
    return true;
  }
  console.error(
    "Warning: .wiki/ index missing. Run index.ts to generate it."
  );
  return false;
}

export function getLastIndexTime(config: VaultConfig): number {
  const lastIndexPath = join(config.wikiPath, ".last-index");
  if (!existsSync(lastIndexPath)) return 0;
  const content = readFileSync(lastIndexPath, "utf-8").trim();
  return parseInt(content, 10) || 0;
}

export function getFileMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}
