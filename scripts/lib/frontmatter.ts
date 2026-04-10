import { readFileSync } from "fs";
import matter from "gray-matter";
import type { ParsedNote, NoteType, ValidationError } from "./types.js";
import { classifyNote } from "./vault.js";

/**
 * Strip malformed date lines (P25-11-07) from raw content before parsing.
 * These bare lines inside frontmatter cause gray-matter's YAML parser to fail.
 * They also appear in the body and should be cleaned everywhere.
 */
function stripMalformedDateLines(raw: string): string {
  return raw.replace(/^P\d{2}-\d{2}-\d{2}$/gm, "");
}

export function parseNote(filePath: string, vaultPath: string): ParsedNote {
  const raw = readFileSync(filePath, "utf-8");
  const cleaned = stripMalformedDateLines(raw);
  const { data, content } = matter(cleaned);
  const noteType = classifyNote(filePath, vaultPath);

  // Extract title from first H1 or filename
  const h1Match = content.match(/^#\s+(.+)$/m);
  const title =
    h1Match?.[1] ||
    filePath
      .split("/")
      .pop()!
      .replace(/\.md$/, "");

  return {
    filePath,
    title,
    frontmatter: data,
    body: content,
    raw,
    noteType,
  };
}

export function extractWikilinks(text: string): string[] {
  const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const links: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    links.push(match[1].trim());
  }
  return [...new Set(links)];
}

export function extractFrontmatterWikilinks(
  value: unknown
): string[] {
  if (!value) return [];
  if (typeof value === "string") {
    return extractWikilinks(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap((v) =>
      typeof v === "string" ? extractWikilinks(v) : []
    );
  }
  return [];
}

export function extractAllFrontmatterLinks(
  fm: Record<string, unknown>
): string[] {
  return [
    ...new Set([
      ...extractFrontmatterWikilinks(fm.concepts),
      ...extractFrontmatterWikilinks(fm.mocs),
      ...extractFrontmatterWikilinks(fm.builds_on),
      ...extractFrontmatterWikilinks(fm.compares_with),
      ...extractFrontmatterWikilinks(fm.uses_method),
    ]),
  ];
}

export function isStub(body: string): boolean {
  return body.includes("Definition pending - please update.");
}

export function hasMalformedDateLine(raw: string): string | null {
  // These appear as bare lines like P25-11-07 outside of frontmatter
  const lines = raw.split("\n");
  let inFrontmatter = false;
  let frontmatterClosed = false;
  let dashCount = 0;

  for (const line of lines) {
    if (line.trim() === "---") {
      dashCount++;
      if (dashCount === 1) inFrontmatter = true;
      if (dashCount === 2) {
        inFrontmatter = false;
        frontmatterClosed = true;
      }
      continue;
    }

    // Check for malformed date lines both inside frontmatter (after first ---)
    // and in body. They appear as bare P25-11-07 style lines.
    const match = line.trim().match(/^P\d{2}-\d{2}-\d{2}$/);
    if (match) {
      return match[0];
    }
  }

  return null;
}

const REQUIRED_FIELDS: Record<NoteType, string[]> = {
  source: ["tags", "cssclasses", "created", "concepts", "mocs"],
  concept: ["tags", "cssclasses", "created"],
  moc: ["tags", "cssclasses", "created"],
  other: [],
};

export function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  noteType: NoteType
): ValidationError[] {
  const errors: ValidationError[] = [];
  const required = REQUIRED_FIELDS[noteType];

  for (const field of required) {
    if (!(field in frontmatter) || frontmatter[field] === undefined) {
      errors.push({ field, message: `Missing required field: ${field}` });
      continue;
    }

    // Check arrays aren't empty for source notes
    if (
      noteType === "source" &&
      (field === "concepts" || field === "mocs" || field === "tags")
    ) {
      const val = frontmatter[field];
      if (Array.isArray(val) && val.length === 0) {
        errors.push({ field, message: `${field} array is empty` });
      }
    }
  }

  // Check tags is an array
  if (
    "tags" in frontmatter &&
    frontmatter.tags !== undefined &&
    !Array.isArray(frontmatter.tags)
  ) {
    errors.push({ field: "tags", message: "tags must be an array" });
  }

  // Check for duplicate entries in array fields
  for (const field of ["concepts", "mocs", "builds_on", "compares_with", "uses_method", "tags"]) {
    const val = frontmatter[field];
    if (Array.isArray(val)) {
      const seen = new Set<string>();
      for (const item of val) {
        const str = String(item);
        if (seen.has(str)) {
          errors.push({
            field,
            message: `Duplicate entry in ${field}: ${str}`,
          });
        }
        seen.add(str);
      }
    }
  }

  return errors;
}
