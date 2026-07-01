/**
 * Defense-in-depth sanitization for newly-ingested source note bodies.
 * Removes two specific beacon/tracking vectors Obsidian would otherwise
 * render silently: remote markdown image embeds and over-length URLs.
 * Deliberately narrow — does not touch local `![[wikilink]]` embeds, which
 * lack the `(url)` suffix this regex requires.
 */
export interface SanitizeResult {
  body: string;
  stripped: string[];
}

const REMOTE_IMAGE_EMBED_RE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)\]]+/g;
const MAX_URL_LENGTH = 300;

/**
 * Split a note's raw file text into its frontmatter block (delimiters
 * included, byte-for-byte as written) and everything after it. Callers that
 * need to rewrite only the body — e.g. post-write's sanitization step —
 * should splice into this `body` half and reassemble with `frontmatterBlock`
 * untouched, rather than re-serializing frontmatter through a YAML dumper
 * (which silently reformats arrays/dates, e.g. turning an Obsidian-native
 * bare `YYYY-MM-DD` date into a full ISO timestamp).
 */
export function splitFrontmatterRaw(raw: string): { frontmatterBlock: string; body: string } {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!match) return { frontmatterBlock: "", body: raw };
  return { frontmatterBlock: match[0], body: raw.slice(match[0].length) };
}

export function sanitizeIngestedBody(body: string): SanitizeResult {
  const stripped: string[] = [];

  let out = body.replace(REMOTE_IMAGE_EMBED_RE, (_match, alt: string, url: string) => {
    stripped.push(`remote image embed removed (alt="${alt}", url="${url}")`);
    return `[image removed: ${alt || "untitled"}]`;
  });

  out = out.replace(BARE_URL_RE, (url) => {
    if (url.length <= MAX_URL_LENGTH) return url;
    stripped.push(`over-length URL removed (${url.length} chars, exceeded ${MAX_URL_LENGTH})`);
    return `[URL removed: ${url.length} chars, exceeded ${MAX_URL_LENGTH}-char limit]`;
  });

  return { body: out, stripped };
}
