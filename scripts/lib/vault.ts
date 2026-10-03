import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from "fs";
import { recordsOfKind, type RecordKind } from "../../hooks/lib/index/records.js";
import { join, resolve, dirname, relative as relPath } from "path";
import { glob } from "glob";
import { isExcluded } from "../../hooks/lib/index/exclude.js";
import type {
  VaultConfig,
  WikiConfig,
  DomainRegistry,
  NoteType,
  SourceNote,
  ConceptNote,
  MocNote,
} from "./types.js";
import {
  type VaultRegistry,
  EMPTY_REGISTRY as EMPTY_VAULT_REGISTRY,
  parseRegistry,
  findById,
  getDefaultEntry,
  migrateFromVaultPath,
  findByRef,
  parsePins,
  pinFor,
  type VaultPins,
} from "./registry.js";

const EMPTY_REGISTRY: DomainRegistry = { domains: {} };

export function getVaultConfig(vaultPath: string): VaultConfig {
  const resolved = resolve(vaultPath);
  return {
    vaultPath: resolved,
    wikiPath: join(resolved, ".wiki"),
    claudeMdPath: join(resolved, "CLAUDE.md"),
  };
}

/**
 * Candidate locations for vaults.json / .vault-path, in priority order.
 * Mirrors the existing .vault-path search (CLAUDE_PLUGIN_DATA, plugin root,
 * then any commonplace-* marketplace data dir).
 */
function pluginDataLocations(filename: string): string[] {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const pluginRoot = resolve(import.meta.dirname!, "..", "..");
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const locs = [
    ...(dataDir ? [join(dataDir, filename)] : []),
    join(pluginRoot, filename),
  ];
  if (homeDir) {
    try {
      const root = join(homeDir, ".claude", "plugins", "data");
      for (const dir of readdirSync(root)) {
        if (dir.startsWith("commonplace-")) locs.push(join(root, dir, filename));
      }
    } catch {}
  }
  return locs;
}

/** Where new registry writes go: CLAUDE_PLUGIN_DATA if set, else plugin root. */
function primaryDataDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA ?? resolve(import.meta.dirname!, "..", "..");
}

let _vaultRegistryCache: VaultRegistry | null = null;

/**
 * Load the vault registry. If vaults.json is absent but a legacy
 * .vault-path exists, migrate it to a single-entry registry and persist
 * (best-effort). Cached for the process lifetime.
 */
export function loadVaultRegistry(): VaultRegistry {
  if (_vaultRegistryCache) return _vaultRegistryCache;
  for (const loc of pluginDataLocations("vaults.json")) {
    try {
      const reg = parseRegistry(readFileSync(loc, "utf-8"));
      if (reg.vaults.length > 0) { _vaultRegistryCache = reg; return reg; }
    } catch {}
  }
  // Migrate legacy .vault-path
  for (const loc of pluginDataLocations(".vault-path")) {
    try {
      const vp = readFileSync(loc, "utf-8").trim();
      if (vp && existsSync(vp)) {
        const reg = migrateFromVaultPath(resolve(vp));
        try { saveVaultRegistry(reg); } catch {}
        _vaultRegistryCache = reg;
        return reg;
      }
    } catch {}
  }
  _vaultRegistryCache = EMPTY_VAULT_REGISTRY;
  return EMPTY_VAULT_REGISTRY;
}

/** Persist the registry, and mirror the default path to .vault-path for back-compat. */
export function saveVaultRegistry(reg: VaultRegistry): void {
  const dir = primaryDataDir();
  try { mkdirSync(dir, { recursive: true }); } catch {}
  writeFileSync(join(dir, "vaults.json"), JSON.stringify(reg, null, 2) + "\n");
  const def = getDefaultEntry(reg);
  if (def) writeFileSync(join(dir, ".vault-path"), def.path + "\n");
  _vaultRegistryCache = reg;
}

/** Load project pins (`vault-pins.json`), first readable location wins. */
export function loadVaultPins(): VaultPins {
  for (const loc of pluginDataLocations("vault-pins.json")) {
    try {
      return parsePins(readFileSync(loc, "utf-8"));
    } catch {}
  }
  return {};
}

export function saveVaultPins(pins: VaultPins): void {
  const dir = primaryDataDir();
  try { mkdirSync(dir, { recursive: true }); } catch {}
  writeFileSync(join(dir, "vault-pins.json"), JSON.stringify(pins, null, 2) + "\n");
}

/** Which rule picked the vault — `commonplace vault` shows it. */
export type VaultChoice = {
  path: string;
  id: string | null;
  via: "explicit" | "pin" | "cwd" | "default";
};

/**
 * THE vault precedence, shared by every script and mirrored (and parity-
 * tested) by `bin/commonplace vault-path`:
 *
 *   1. explicit `--vault <id|alias|path>`
 *   2. a project pin (`commonplace vault use <id>`) covering the caller's cwd
 *   3. cwd walk-up to a vault marker (`.obsidian/` or `.wiki/`)
 *   4. the registry default — never a private vault
 *
 * The pin beats the walk-up on purpose: a pin is an explicit choice, the
 * walk-up an inference. Returns null when nothing applies.
 */
export function chooseVault(explicit: string | undefined, callerCwd: string): VaultChoice | null {
  const reg = loadVaultRegistry();
  if (explicit) {
    const hit = findByRef(reg, explicit);
    if (hit) return { path: hit.path, id: hit.id, via: "explicit" };
    return { path: resolve(explicit), id: null, via: "explicit" };
  }
  const pinned = pinFor(loadVaultPins(), resolve(callerCwd));
  if (pinned) {
    const hit = findByRef(reg, pinned);
    if (hit) return { path: hit.path, id: hit.id, via: "pin" };
  }
  const discovered = discoverVault(callerCwd);
  if (discovered) {
    const hit = reg.vaults.find((v) => resolve(v.path) === discovered);
    return { path: discovered, id: hit?.id ?? null, via: "cwd" };
  }
  const def = getDefaultEntry(reg);
  if (def) return { path: def.path, id: def.id, via: "default" };
  return null;
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

export function resolveVault(explicit?: string): VaultConfig {
  const callerCwd = process.env.COMMONPLACE_CALLER_CWD || process.cwd();
  const choice = chooseVault(explicit, callerCwd);
  if (choice) return getVaultConfig(choice.path);
  console.error(
    "Error: Could not find vault. Run from a vault directory, pass --vault <id|path>, or run `commonplace init`."
  );
  process.exit(1);
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

  // Use the full directory path as the domain path (e.g., "04 - Explorations/Chess")
  // Slug from the deepest segment (e.g., "chess")
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
  // Underscore-prefixed directories (e.g. _raw/) are scaffolding, not managed
  // notes — raw scrape dumps, attachments, templates. A domain-path fallback
  // would otherwise classify a frontmatter-less _raw/ dump as a "source" and
  // let it pollute the index, lint, seed, and score. The rule (plus dot-dirs
  // and non-.md) lives in hooks/lib/index/exclude.ts, shared with the hooks
  // module's sweep so the CLI and the module agree on what a note is.
  return matches.filter((f) => !isExcluded(relPath(vaultPath, f)));
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
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(line => line)
    .map(line => JSON.parse(line) as T);
}

/**
 * Resolve a vault-relative path from an index back to absolute.
 * Tolerates legacy absolute paths (returns as-is) so a stale .wiki/ won't
 * silently break; a warning is emitted once per load by loadIndexes.
 */
export function resolveIndexPath(p: string, vaultPath: string): string {
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return p;
  return join(vaultPath, p);
}

let _staleIndexWarned = false;
function warnIfStale(records: { path?: string }[]): void {
  if (_staleIndexWarned) return;
  const first = records.find((r) => typeof r.path === "string");
  if (first && (first.path!.startsWith("/") || /^[A-Za-z]:[\\/]/.test(first.path!))) {
    _staleIndexWarned = true;
    console.error(
      "warning: .wiki/ indexes contain absolute paths (legacy format). Run `commonplace index` to rebuild.",
    );
  }
}

/**
 * Private shards whose legacy rows a CLI run may read, from
 * `COMMONPLACE_OPEN` (comma-separated shard ids, or `*` for every shard).
 *
 * The public `*-index.jsonl` files hold no private row at all (v2 split).
 * The hooks module sets this on the model's `commonplace` Bash commands to the
 * shards the session has opened, so a lint or impact run inside a session sees
 * exactly what the vault tools see; a person at a terminal can set it to `*`.
 */
export function openShardsFromEnv(env: NodeJS.ProcessEnv = process.env): { all: boolean; shards: Set<string> } {
  const raw = String(env.COMMONPLACE_OPEN ?? "").trim();
  const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
  return { all: list.includes("*"), shards: new Set(list.filter((x) => x !== "*")) };
}

const _recordText = new Map<string, { mt: number; text: string }>();
function readRecordFile(path: string): string | null {
  let mt: number;
  try {
    mt = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const hit = _recordText.get(path);
  if (hit && hit.mt === mt) return hit.text;
  const text = readFileSync(path, "utf-8");
  _recordText.set(path, { mt, text });
  return text;
}

/**
 * Maintenance records of one kind: the public shard's plus those of every
 * shard open in `COMMONPLACE_OPEN` (hooks/lib/index/records.ts). A vault not
 * yet rebuilt by v2 has no records file; its v1 `<kind>-index.jsonl` is read
 * instead, so pre-v2 vaults and hand-written fixtures keep working.
 */
export function readLegacyIndex<T>(config: VaultConfig, name: RecordKind): T[] {
  const pub = readRecordFile(join(config.wikiPath, "graph", "records.jsonl"));
  if (pub === null) return parseJsonl<T>(join(config.wikiPath, `${name}-index.jsonl`));
  const rows = recordsOfKind<T>(pub, name);
  const open = openShardsFromEnv();
  if (!open.all && open.shards.size === 0) return rows;
  const sealed = join(config.wikiPath, "sealed");
  const shards = open.all
    ? existsSync(sealed)
      ? readdirSync(sealed, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : []
    : [...open.shards];
  for (const shard of shards) {
    if (!/^[A-Za-z0-9_.-]+$/.test(shard)) continue;
    rows.push(...recordsOfKind<T>(readRecordFile(join(sealed, shard, "records.jsonl")), name));
  }
  return rows;
}

export function loadIndexes(config: VaultConfig): {
  sources: SourceNote[];
  concepts: ConceptNote[];
  mocs: MocNote[];
} {
  const sources = readLegacyIndex<SourceNote>(config, "source");
  const concepts = readLegacyIndex<ConceptNote>(config, "concept");
  const mocs = readLegacyIndex<MocNote>(config, "moc");
  warnIfStale([...sources, ...concepts, ...mocs]);
  for (const s of sources) s.path = resolveIndexPath(s.path, config.vaultPath);
  for (const c of concepts) c.path = resolveIndexPath(c.path, config.vaultPath);
  for (const m of mocs) m.path = resolveIndexPath(m.path, config.vaultPath);
  return { sources, concepts, mocs };
}

export function ensureIndex(config: VaultConfig): boolean {
  if (
    (existsSync(join(config.wikiPath, "graph", "records.jsonl")) ||
      existsSync(join(config.wikiPath, "source-index.jsonl"))) &&
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
