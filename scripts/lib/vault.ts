import { readFileSync, existsSync, statSync } from "fs";
import { join, resolve } from "path";
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

// Minimal fallback — only used when vault CLAUDE.md is missing or unparseable.
// Real domain registries live in the vault's CLAUDE.md between DOMAIN_REGISTRY_START/END sentinels.
const DEFAULT_REGISTRY: DomainRegistry = {
  domains: {
    research: { path: "02 - Areas/Research", scope: "professional" },
    projects: { path: "01 - Projects", scope: "professional" },
  },
};

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
    try {
      const pluginRoot = resolve(import.meta.dirname!, "..", "..");
      const stored = readFileSync(join(pluginRoot, ".vault-path"), "utf-8").trim();
      if (stored && existsSync(stored)) vaultPath = stored;
    } catch {}

    // Fall back to cwd discovery (walk up looking for .obsidian/ or .wiki/)
    if (!vaultPath) {
      vaultPath = discoverVault(process.cwd());
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

export function loadDomainRegistry(claudeMdPath: string): DomainRegistry {
  if (!existsSync(claudeMdPath)) {
    console.error(
      `Warning: ${claudeMdPath} not found, using default domain registry`
    );
    return DEFAULT_REGISTRY;
  }

  const content = readFileSync(claudeMdPath, "utf-8");
  const startMarker = "<!-- DOMAIN_REGISTRY_START -->";
  const endMarker = "<!-- DOMAIN_REGISTRY_END -->";

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error(
      "Warning: Domain registry markers not found in CLAUDE.md, using defaults"
    );
    return DEFAULT_REGISTRY;
  }

  const yamlBlock = content
    .slice(startIdx + startMarker.length, endIdx)
    .replace(/```yaml\n?/, "")
    .replace(/```\n?/, "")
    .trim();

  // Simple YAML parser for our known structure
  const registry: DomainRegistry = { domains: {} };
  let currentDomain = "";

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "domains:" || trimmed === "" || trimmed.startsWith("#"))
      continue;

    // Domain name line: "  ai-development:"
    const domainMatch = trimmed.match(/^([a-z0-9-]+):$/);
    if (domainMatch) {
      currentDomain = domainMatch[1];
      registry.domains[currentDomain] = { path: "", scope: "professional" };
      continue;
    }

    if (currentDomain) {
      const pathMatch = trimmed.match(/^path:\s*"(.+)"$/);
      if (pathMatch) {
        registry.domains[currentDomain].path = pathMatch[1];
        continue;
      }
      const scopeMatch = trimmed.match(/^scope:\s*(\w+)$/);
      if (scopeMatch) {
        registry.domains[currentDomain].scope = scopeMatch[1] as
          | "professional"
          | "hobby";
      }
    }
  }

  if (Object.keys(registry.domains).length === 0) {
    console.error(
      "Warning: No domains parsed from CLAUDE.md, using defaults"
    );
    return DEFAULT_REGISTRY;
  }

  return registry;
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

export function classifyNote(
  filePath: string,
  vaultPath: string,
  wikiConfig?: WikiConfig | null
): NoteType {
  const relative = filePath.startsWith(vaultPath)
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
  return resolved.startsWith(vaultResolved) && resolved.endsWith(".md");
}

export function loadIndexes(config: VaultConfig): {
  sources: SourceNote[];
  concepts: ConceptNote[];
  mocs: MocNote[];
} {
  return {
    sources: JSON.parse(
      readFileSync(join(config.wikiPath, "source-index.json"), "utf-8")
    ),
    concepts: JSON.parse(
      readFileSync(join(config.wikiPath, "concept-index.json"), "utf-8")
    ),
    mocs: JSON.parse(
      readFileSync(join(config.wikiPath, "moc-index.json"), "utf-8")
    ),
  };
}

export function ensureIndex(config: VaultConfig): boolean {
  if (
    existsSync(join(config.wikiPath, "source-index.json")) &&
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
