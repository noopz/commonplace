/**
 * Vault skills (plan §7): the vault's own Claude Code skills —
 * `<vault>/.claude/skills/<name>/SKILL.md`, and the same under any folder
 * inside the vault (`<folder>/.claude/skills/…`) — usable from a session
 * started anywhere. A session started in the vault gets them from Claude Code
 * itself; this module serves every other session.
 *
 * Trust boundary (§7.4): a skill is instructions that then run in other
 * projects, and Claude can write into the vault, so
 *   - a skill is loadable outside the vault only once the PERSON has trusted
 *     its exact content (asked when discovered, or `/vault skills trust`; the
 *     SHA-256 is pinned) — any edit, including one Claude made, untrusts it;
 *   - a skill in a folder holding or inside a private domain loads only while
 *     that domain is open (`skillGateShards`);
 *   - a skill with a `domain:` loads only while that domain is visible, and
 *     an undomained skill whose text reproduces a sealed title is hidden.
 *
 * Pure: register.tsx finds and reads the files and computes the hashes.
 */

import { parseFrontmatter } from "../index/yaml.js";
import { findPrivateMatches } from "../guard.js";

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SKILL_BODY_MAX = 20_000;

export type VaultSkill = {
  name: string;
  description: string;
  domain?: string;
  argumentHint?: string;
  body: string;
  hash: string;
  trusted: boolean;
  /** Trusted before, edited since. */
  changed: boolean;
  /** Vault-relative path of the SKILL.md, for the person to review. */
  path: string;
};

/** `dir` is the skill folder's name; `base` the vault-relative folder holding `.claude/skills` ("" for the vault root). */
export type SkillFile = { dir: string; text: string; hash: string; base?: string };

/**
 * The private shards a skill folder belongs to: a nested `.claude/skills`
 * under a private domain, or above one (`08 - Group/.claude/skills` above
 * `08 - Group/Secret`), carries that domain's scope. The vault root's skills
 * are vault-wide and gated by nothing.
 */
export function skillGateShards(
  base: string,
  domains: Readonly<Record<string, { path?: string; scope?: string; linkGroup?: string }>>,
): string[] {
  const b = base.replace(/\/+$/, "");
  if (!b) return [];
  const out = new Set<string>();
  for (const [id, d] of Object.entries(domains)) {
    if (d.scope !== "private" || !d.path) continue;
    const p = d.path.replace(/\/+$/, "");
    if (p === b || p.startsWith(`${b}/`) || b.startsWith(`${p}/`)) out.add(d.linkGroup || id);
  }
  return [...out];
}

/** Parse one SKILL.md; null when malformed or misnamed. */
export function parseSkill(file: SkillFile): Omit<VaultSkill, "trusted" | "changed" | "path"> | null {
  const name = file.dir;
  if (!SKILL_NAME_RE.test(name)) return null;
  const { data, body } = parseFrontmatter(file.text);
  const fmName = typeof data.name === "string" ? data.name.trim() : name;
  if (fmName !== name) return null;
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!description) return null;
  return {
    name,
    description: description.slice(0, 300),
    ...(typeof data.domain === "string" && data.domain.trim() ? { domain: data.domain.trim() } : {}),
    ...(typeof data.argumentHint === "string" ? { argumentHint: data.argumentHint.slice(0, 60) } : {}),
    body: body.trim().slice(0, SKILL_BODY_MAX),
    hash: file.hash,
  };
}

/**
 * The skills a session may see: parsed, trust applied, domain-scoped ones only
 * when their domain is visible, undomained ones hidden if they reproduce a
 * sealed title.
 */
export function visibleSkills(
  files: readonly SkillFile[],
  trusted: Readonly<Record<string, string>>,
  isDomainVisible: (domain: string) => boolean,
  sealedNames: readonly string[],
  isShardOpen: (shard: string) => boolean = () => false,
  domains: Readonly<Record<string, { path?: string; scope?: string; linkGroup?: string }>> = {},
): VaultSkill[] {
  const out: VaultSkill[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const s = parseSkill(f);
    if (!s || seen.has(s.name)) continue;
    const gate = skillGateShards(f.base ?? "", domains);
    if (!gate.every(isShardOpen)) continue;
    seen.add(s.name);
    if (s.domain && !isDomainVisible(s.domain)) continue;
    if (!s.domain && gate.length === 0 && findPrivateMatches(`${s.name}\n${s.description}\n${s.body}`, [...sealedNames]).length > 0) continue;
    const pinned = trusted[s.name];
    const path = `${f.base ? `${f.base}/` : ""}.claude/skills/${f.dir}/SKILL.md`;
    out.push({ ...s, trusted: pinned === s.hash, changed: Boolean(pinned) && pinned !== s.hash, path });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The text a loaded skill is delivered as (tool result or command context). */
export function skillBlock(s: VaultSkill, vaultId: string, args = ""): string {
  return [
    `<vault-skill name="${s.name}" vault="${vaultId}" trusted="true">`,
    "Instructions authored by the vault owner and trusted by them for this exact content. Follow them for this task.",
    args ? `Arguments: ${args}` : "",
    "",
    s.body,
    "</vault-skill>",
  ]
    .filter((l, i) => l !== "" || i === 3)
    .join("\n");
}

/** Hex SHA-256 via WebCrypto (available in the module sandbox and in Node). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
