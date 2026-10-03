/**
 * Vault skills (plan §7): prompt-only `SKILL.md` files the user keeps in
 * `<vault>/.wiki/skills/<name>/SKILL.md`, usable from any session without
 * starting in the vault.
 *
 * Trust boundary (§7.4): a skill is instructions authored outside Claude, so
 *   - the model can never write there (the sealing guard denies it);
 *   - a skill is loadable only once the PERSON has trusted its exact content
 *     (`/vault skills trust <name>` stores its SHA-256); any edit untrusts it;
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
};

export type SkillFile = { dir: string; text: string; hash: string };

/** Parse one SKILL.md; null when malformed or misnamed. */
export function parseSkill(file: SkillFile): Omit<VaultSkill, "trusted" | "changed"> | null {
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
): VaultSkill[] {
  const out: VaultSkill[] = [];
  for (const f of files) {
    const s = parseSkill(f);
    if (!s) continue;
    if (s.domain && !isDomainVisible(s.domain)) continue;
    if (!s.domain && findPrivateMatches(`${s.name}\n${s.description}\n${s.body}`, [...sealedNames]).length > 0) continue;
    const pinned = trusted[s.name];
    out.push({ ...s, trusted: pinned === s.hash, changed: Boolean(pinned) && pinned !== s.hash });
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
