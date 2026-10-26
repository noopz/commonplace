import { parseFrontmatter, type YamlMap } from "../../hooks/lib/index/yaml.js";

/**
 * gray-matter's `matter(raw)` on the module's own parser, so the CLI and the
 * module read frontmatter identically. Like gray-matter, it throws on YAML it
 * cannot read. Dates stay the strings the author wrote.
 */
export function matter(raw: string): { data: YamlMap; content: string } {
  const r = parseFrontmatter(raw);
  if (r.error) throw new Error(`frontmatter: ${r.error}`);
  return { data: r.data, content: r.body };
}
