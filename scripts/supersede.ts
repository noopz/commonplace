#!/usr/bin/env tsx
/**
 * wiki-supersede CLI — deterministic file ops + heuristic-classified scan.
 *
 * Modes:
 *   --scan --old X [--new Y] [--scope path]
 *       Find all prose mentions of `old` across the vault. Heuristically
 *       classify each into {historical, comparison, already-retired, live}.
 *       Emit JSON for the skill driver to review live-class hits.
 *
 *   --retire --old X --new Y --reason "..." [--date YYYY-MM-DD]
 *       Rename old's file to "(Retired) <title>.md", add `retired` tag,
 *       inject a > [!warning] callout, update every wikilink across the
 *       vault to the renamed path, and write a breadcrumb to
 *       .wiki/supersessions.jsonl.
 *
 *   --check
 *       Vault punch list: retired notes whose bare-prose name still
 *       appears in non-retired siblings (live framing on a known-retired
 *       entity), and new notes containing supersession language not yet
 *       processed.
 *
 *   --list
 *       Print breadcrumbs from .wiki/supersessions.jsonl.
 *
 * Classification heuristics are intentionally conservative: when unsure,
 * tag as "needs-review" rather than "live" so the LLM driver can verify.
 * Inside code fences, classify as "live-in-code" with a `rewriteSafety`
 * flag set to "rename-only" or "structural" — only rename-only is safe
 * to auto-propose.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  appendFileSync,
} from "fs";
import { appendLineage } from "./lib/lineage.js";
import { basename, dirname, join, resolve, relative } from "path";
import { parseArgs } from "util";
import {
  resolveVault,
  ensureIndex,
  loadIndexes,
  findAllNotes,
} from "./lib/vault.js";
import { parseNote, extractWikilinks } from "./lib/frontmatter.js";
import { buildNameIndex, normalizeWikilinkTarget } from "./lib/resolve.js";

const { values } = parseArgs({
  options: {
    scan: { type: "boolean", default: false },
    retire: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    old: { type: "string" },
    new: { type: "string" },
    reason: { type: "string" },
    date: { type: "string" },
    scope: { type: "string" },
    json: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const config = resolveVault();
const breadcrumbPath = join(config.wikiPath, "supersessions.jsonl");

type Classification =
  | "historical"
  | "comparison"
  | "already-retired"
  | "live"
  | "live-in-code"
  | "needs-review";

interface Hit {
  file: string;
  line: number;
  match: string;
  paragraph: string;
  classification: Classification;
  inCodeFence: boolean;
  fenceLang: string | null;
  rewriteSafety?: "rename-only" | "structural";
  reason: string;
}

interface Breadcrumb {
  old: string;
  new: string;
  date: string;
  reason: string;
  filesTouched: string[];
}

function loadBreadcrumbs(): Breadcrumb[] {
  if (!existsSync(breadcrumbPath)) return [];
  const raw = readFileSync(breadcrumbPath, "utf-8");
  const out: Breadcrumb[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  return out;
}

// --- Heuristics ---------------------------------------------------------

const PAST_TENSE_NEAR =
  /\b(was|were|used to|previously|originally|formerly|once|historically|before|prior|legacy)\b/i;
const COMPARISON_MARKERS =
  /\b(not|instead of|rather than|replaces?|supersedes?|predecessor|successor|migrated from|in place of|in lieu of|vs\.?|versus)\b/i;
const RETIREMENT_HEADER =
  /^>\s*\[!(warning|info|note|caution)\][^\n]*(?:retired|deprecated|historical|migration|predecessor)/im;

function isInCodeFence(
  body: string,
  offset: number,
): { inFence: boolean; lang: string | null } {
  // Walk lines counting fenced blocks until we reach offset.
  let pos = 0;
  let inFence = false;
  let lang: string | null = null;
  const lines = body.split("\n");
  for (const line of lines) {
    const lineEnd = pos + line.length + 1;
    const fenceMatch = line.match(/^```(\S*)?/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        lang = fenceMatch[1] || null;
      } else {
        inFence = false;
        lang = null;
      }
    }
    if (offset < lineEnd) return { inFence, lang };
    pos = lineEnd;
  }
  return { inFence, lang };
}

function findParagraph(body: string, offset: number): string {
  // Paragraph = surrounding blank-line-bounded block.
  const before = body.slice(0, offset).lastIndexOf("\n\n");
  const afterRel = body.slice(offset).indexOf("\n\n");
  const start = before === -1 ? 0 : before + 2;
  const end = afterRel === -1 ? body.length : offset + afterRel;
  return body.slice(start, end).trim();
}

function classifyHit(
  paragraph: string,
  match: string,
  matchOffsetInPara: number,
  filePath: string,
  inFence: boolean,
  fenceLang: string | null,
  newTitle: string | null,
): Pick<Hit, "classification" | "reason" | "rewriteSafety"> {
  // already-retired: file itself is retired
  const fileBase = basename(filePath);
  if (/^\(Retired\)/i.test(fileBase)) {
    return { classification: "already-retired", reason: "file is retired" };
  }

  // already-retired: hit is inside a retirement callout block
  if (RETIREMENT_HEADER.test(paragraph)) {
    return {
      classification: "already-retired",
      reason: "inside retirement callout",
    };
  }

  // already-retired: wikilink target starts with (Retired)
  const wikilinkAroundMatch = paragraph.match(
    new RegExp(`\\[\\[\\(Retired\\)[^\\]]*${escapeRegex(match)}[^\\]]*\\]\\]`, "i"),
  );
  if (wikilinkAroundMatch) {
    return {
      classification: "already-retired",
      reason: "wikilink target is already (Retired)",
    };
  }

  // Compute a small window around the match for tense/comparison checks.
  const windowStart = Math.max(0, matchOffsetInPara - 80);
  const windowEnd = Math.min(paragraph.length, matchOffsetInPara + match.length + 80);
  const window = paragraph.slice(windowStart, windowEnd);

  if (COMPARISON_MARKERS.test(window)) {
    return {
      classification: "comparison",
      reason: "comparison/negation marker in window",
    };
  }

  if (PAST_TENSE_NEAR.test(window)) {
    return {
      classification: "historical",
      reason: "past-tense marker in window",
    };
  }

  // Inside a code fence: classify separately.
  if (inFence) {
    // Heuristic for rewrite safety: if a rename-only swap of `match` →
    // `successor token` would only touch identifier/string runs, mark safe.
    // We can't fully verify without parsing the language, so rely on
    // language hint + token shape: identifier-ish tokens (alnum + _ - .)
    // are rename-safe; if match contains spaces or appears outside an
    // identifier boundary, mark structural.
    const identifierLike = /^[\w@.\-]+$/.test(match);
    const safety: "rename-only" | "structural" = identifierLike
      ? "rename-only"
      : "structural";
    return {
      classification: "live-in-code",
      reason: `inside ${fenceLang ?? "unfenced"} code block`,
      rewriteSafety: safety,
    };
  }

  // Default: candidate live framing. The LLM driver verifies.
  return {
    classification: "needs-review",
    reason: "no historical/comparison signal — verify with LLM",
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Modes --------------------------------------------------------------

if (values.list) {
  const crumbs = loadBreadcrumbs();
  if (values.json) {
    console.log(JSON.stringify(crumbs, null, 2));
  } else if (crumbs.length === 0) {
    console.log("No supersessions recorded.");
  } else {
    for (const c of crumbs) {
      console.log(`${c.date}  ${c.old}  →  ${c.new}  (${c.filesTouched.length} files touched)`);
    }
  }
  process.exit(0);
}

if (values.scan) {
  if (!values.old) {
    console.error("--scan requires --old");
    process.exit(1);
  }
  if (!ensureIndex(config)) {
    console.error("supersede: index not built — run `commonplace index`");
    process.exit(1);
  }
  const old = values.old.replace(/^\[\[|\]\]$/g, "").trim();
  const newTitle = values.new ? values.new.replace(/^\[\[|\]\]$/g, "").trim() : null;

  const allFiles = await findAllNotes(config.vaultPath);
  const scopeFilter = values.scope ? resolve(values.scope) : null;

  const re = new RegExp(`\\b${escapeRegex(old)}\\b`, "gi");
  const hits: Hit[] = [];

  for (const filePath of allFiles) {
    if (scopeFilter && !filePath.includes(scopeFilter) && !filePath.includes(values.scope!)) continue;
    let body: string;
    try {
      body = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    if (!re.test(body)) continue;
    re.lastIndex = 0;

    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const offset = m.index;
      const fenceState = isInCodeFence(body, offset);
      const para = findParagraph(body, offset);
      const matchOffsetInPara = para.toLowerCase().indexOf(m[0].toLowerCase());
      const lineNo = body.slice(0, offset).split("\n").length;
      const cls = classifyHit(
        para,
        m[0],
        matchOffsetInPara >= 0 ? matchOffsetInPara : 0,
        filePath,
        fenceState.inFence,
        fenceState.lang,
        newTitle,
      );
      hits.push({
        file: filePath,
        line: lineNo,
        match: m[0],
        paragraph: para,
        classification: cls.classification,
        inCodeFence: fenceState.inFence,
        fenceLang: fenceState.lang,
        ...(cls.rewriteSafety ? { rewriteSafety: cls.rewriteSafety } : {}),
        reason: cls.reason,
      });
    }
  }

  if (values.json) {
    console.log(JSON.stringify({ old, new: newTitle, hits }, null, 2));
  } else {
    const buckets: Record<Classification, Hit[]> = {
      historical: [],
      comparison: [],
      "already-retired": [],
      live: [],
      "live-in-code": [],
      "needs-review": [],
    };
    for (const h of hits) buckets[h.classification].push(h);
    console.log(`Scanning for "${old}" — ${hits.length} hits across ${new Set(hits.map((h) => h.file)).size} files\n`);
    for (const [cls, list] of Object.entries(buckets)) {
      if (list.length === 0) continue;
      console.log(`${cls} (${list.length}):`);
      for (const h of list) {
        const tag = h.classification === "live-in-code" ? ` [${h.fenceLang ?? "code"}/${h.rewriteSafety ?? "?"}]` : "";
        console.log(`  ${h.file}:${h.line}${tag}`);
      }
      console.log("");
    }
    const actionable = buckets.live.length + buckets["live-in-code"].length + buckets["needs-review"].length;
    if (actionable > 0) {
      console.log(`${actionable} hit${actionable > 1 ? "s" : ""} need review. Re-run with --json to drive review programmatically.`);
    } else {
      console.log("No live framing detected. Vault is consistent with this supersession.");
    }
  }
  process.exit(0);
}

if (values.retire) {
  if (!values.old || !values.new || !values.reason) {
    console.error("--retire requires --old, --new, --reason");
    process.exit(1);
  }
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  const old = values.old.replace(/^\[\[|\]\]$/g, "").trim();
  const newTitle = values.new.replace(/^\[\[|\]\]$/g, "").trim();
  const dryRun = values["dry-run"];

  if (!ensureIndex(config)) {
    console.error("supersede: index not built — run `commonplace index`");
    process.exit(1);
  }

  const allFiles = await findAllNotes(config.vaultPath);
  const nameIndex = buildNameIndex(allFiles, config.vaultPath);

  // Resolve old → file path
  const oldKey = old.toLowerCase();
  const oldCanonical = nameIndex.get(oldKey);
  if (!oldCanonical) {
    console.error(`supersede: cannot resolve "${old}" — no matching note in vault`);
    process.exit(1);
  }
  const oldPath = allFiles.find((f) => basename(f, ".md").toLowerCase() === oldCanonical.toLowerCase());
  if (!oldPath) {
    console.error(`supersede: name index resolves "${old}" but no file found at expected path`);
    process.exit(1);
  }

  // Verify new exists
  const newKey = newTitle.toLowerCase();
  if (!nameIndex.has(newKey)) {
    console.error(`supersede: --new target "${newTitle}" must already exist in the vault`);
    process.exit(1);
  }

  const oldDir = dirname(oldPath);
  const oldBase = basename(oldPath, ".md");
  if (/^\(Retired\)/i.test(oldBase)) {
    console.error(`supersede: "${oldBase}" is already retired`);
    process.exit(1);
  }
  const newRetiredBase = `(Retired) ${oldBase}`;
  const newRetiredPath = join(oldDir, `${newRetiredBase}.md`);

  // Cycle check: refuse if newTitle is itself retired
  const newPath = allFiles.find((f) => basename(f, ".md").toLowerCase() === newKey);
  if (newPath && /^\(Retired\)/i.test(basename(newPath, ".md"))) {
    console.error(`supersede: --new target "${newTitle}" is itself retired — refusing cycle`);
    process.exit(1);
  }

  // --- Step 1: rewrite old file's content (callout + tag) ---
  let oldRaw = readFileSync(oldPath, "utf-8");

  // Frontmatter tag injection
  const fmMatch = oldRaw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    const fmBody = fmMatch[1];
    if (!/(^|\n)tags:[^\n]*\bretired\b/.test(fmBody)) {
      let newFm: string;
      if (/^tags:\s*\[/m.test(fmBody)) {
        newFm = fmBody.replace(
          /^tags:\s*\[([^\]]*)\]/m,
          (_full, list) => `tags: [${list.trim() ? list.trim() + ", retired" : "retired"}]`,
        );
      } else if (/^tags:\s*$/m.test(fmBody) || /^tags:\s*\n( {2}-)/m.test(fmBody)) {
        newFm = fmBody.replace(/^tags:\s*\n/m, `tags:\n  - retired\n`);
      } else {
        newFm = `${fmBody}\ntags: [retired]`;
      }
      oldRaw = oldRaw.replace(fmMatch[1], newFm);
    }
  }

  // Callout injection at top of body (after frontmatter and H1).
  const calloutBlock = `\n> [!warning] Retired ${date}\n> ${values.reason}\n> Superseded by [[${newTitle}]].\n\n`;
  if (!oldRaw.includes("[!warning] Retired")) {
    // Insert after H1 if present, else after frontmatter.
    const h1Match = oldRaw.match(/^# .+\n/m);
    if (h1Match) {
      const idx = (h1Match.index ?? 0) + h1Match[0].length;
      oldRaw = oldRaw.slice(0, idx) + calloutBlock + oldRaw.slice(idx);
    } else if (fmMatch) {
      const idx = fmMatch[0].length;
      oldRaw = oldRaw.slice(0, idx) + calloutBlock + oldRaw.slice(idx);
    } else {
      oldRaw = calloutBlock + oldRaw;
    }
  }

  // --- Step 2: rename file ---
  if (!dryRun) {
    writeFileSync(oldPath, oldRaw, "utf-8");
    renameSync(oldPath, newRetiredPath);
    appendLineage(config.wikiPath, {
      note: relative(config.vaultPath, newRetiredPath),
      source: `supersede --retire --old "${old}" --new "${newTitle}"`,
      writer: "supersede",
    });
  } else {
    console.log(`(dry-run) would write callout + tag to ${oldPath}`);
    console.log(`(dry-run) would rename ${oldPath} → ${newRetiredPath}`);
  }

  // --- Step 3: update wikilinks vault-wide ---
  const filesTouched: string[] = [dryRun ? oldPath : newRetiredPath];
  const linkRe = new RegExp(
    `\\[\\[(${escapeRegex(oldBase)})(\\|[^\\]]+)?\\]\\]`,
    "g",
  );
  for (const f of allFiles) {
    if (f === oldPath) continue;
    let body: string;
    try {
      body = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    if (!linkRe.test(body)) continue;
    linkRe.lastIndex = 0;
    const replaced = body.replace(linkRe, (_full, _target, alias) => {
      const a = alias ?? "";
      return `[[${newRetiredBase}${a}]]`;
    });
    if (replaced !== body) {
      filesTouched.push(f);
      if (!dryRun) {
        writeFileSync(f, replaced, "utf-8");
        appendLineage(config.wikiPath, {
          note: relative(config.vaultPath, f),
          source: `supersede --retire (wikilink update: "${oldBase}" → "${newRetiredBase}")`,
          writer: "supersede",
        });
      }
    }
  }

  // --- Step 4: append "Related" entry to new note pointing back ---
  if (newPath) {
    let newRaw = readFileSync(newPath, "utf-8");
    const backref = `[[${newRetiredBase}]]`;
    if (!newRaw.includes(backref)) {
      // Look for ## Related section; append there or create.
      if (/^##\s+Related/m.test(newRaw)) {
        newRaw = newRaw.replace(
          /(^##\s+Related[^\n]*\n)/m,
          `$1- ${backref} — historical predecessor (retired ${date})\n`,
        );
      } else {
        newRaw = newRaw.trimEnd() + `\n\n## Related\n- ${backref} — historical predecessor (retired ${date})\n`;
      }
      if (!dryRun) {
        writeFileSync(newPath, newRaw, "utf-8");
        appendLineage(config.wikiPath, {
          note: relative(config.vaultPath, newPath),
          source: `supersede --retire (back-reference to "${newRetiredBase}")`,
          writer: "supersede",
        });
      }
      filesTouched.push(newPath);
    }
  }

  // --- Step 5: write breadcrumb ---
  const crumb: Breadcrumb = {
    old,
    new: newTitle,
    date,
    reason: values.reason,
    filesTouched,
  };
  if (!dryRun) {
    appendFileSync(breadcrumbPath, JSON.stringify(crumb) + "\n", "utf-8");
  }

  console.log(
    `${dryRun ? "(dry-run) " : ""}retired "${old}" → "${newTitle}"; touched ${filesTouched.length} file${filesTouched.length > 1 ? "s" : ""}`,
  );
  process.exit(0);
}

if (values.check) {
  // Punch list: (a) retired notes whose bare-prose name still appears in
  // non-retired siblings (live framing on a known-retired entity);
  // (b) new notes with supersession language not yet processed.
  const allFiles = await findAllNotes(config.vaultPath);
  const crumbs = loadBreadcrumbs();
  const knownPairs = new Set(crumbs.map((c) => `${c.old}|${c.new}`));

  const punchList: Array<{ kind: string; detail: string; file: string }> = [];

  // (a) For each retired file, scan vault for bare-prose mentions of its
  // pre-retirement title in non-retired notes.
  for (const f of allFiles) {
    const base = basename(f, ".md");
    const m = base.match(/^\(Retired\)\s+(.+)$/i);
    if (!m) continue;
    const oldName = m[1];
    const re = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "i");
    for (const target of allFiles) {
      if (target === f) continue;
      if (/^\(Retired\)/i.test(basename(target, ".md"))) continue;
      let body: string;
      try {
        body = readFileSync(target, "utf-8");
      } catch {
        continue;
      }
      if (!re.test(body)) continue;
      // Quick filter: skip if the only mention is a wikilink to the retired file.
      const onlyAsRetiredLink = new RegExp(`\\[\\[\\(Retired\\)\\s+${escapeRegex(oldName)}`, "i");
      const stripped = body.replace(new RegExp(`\\[\\[\\(Retired\\)[^\\]]*\\]\\]`, "g"), "");
      if (!re.test(stripped)) continue;
      punchList.push({
        kind: "stale-mention",
        detail: `"${oldName}" mentioned in prose; retired note: ${basename(f)}`,
        file: target,
      });
    }
  }

  // (b) New notes with supersession language not yet processed.
  const supersedeRe = /\b(supersedes?|replaces?|migrated from|formerly|previously known as|in place of)\s+\[\[([^\]]+)\]\]/i;
  for (const f of allFiles) {
    if (/^\(Retired\)/i.test(basename(f, ".md"))) continue;
    let body: string;
    try {
      body = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    const m = body.match(supersedeRe);
    if (!m) continue;
    const oldName = m[2].split("|")[0].trim();
    const newName = basename(f, ".md");
    if (knownPairs.has(`${oldName}|${newName}`)) continue;
    punchList.push({
      kind: "unprocessed-declaration",
      detail: `note declares supersession of "${oldName}" but no breadcrumb exists`,
      file: f,
    });
  }

  if (values.json) {
    console.log(JSON.stringify({ punchList }, null, 2));
  } else if (punchList.length === 0) {
    console.log("No supersession debt detected.");
  } else {
    console.log(`Supersession punch list: ${punchList.length} item${punchList.length > 1 ? "s" : ""}\n`);
    for (const p of punchList) {
      console.log(`[${p.kind}] ${p.file}`);
      console.log(`  ${p.detail}`);
    }
  }
  process.exit(0);
}

console.error(
  "Usage: commonplace supersede [--scan|--retire|--check|--list] [args...]",
);
console.error(
  "  --scan --old X [--new Y] [--scope path] [--json]      Find + classify mentions",
);
console.error(
  "  --retire --old X --new Y --reason \"...\" [--date YYYY-MM-DD] [--dry-run]",
);
console.error(
  "  --check [--json]                                       Punch list of supersession debt",
);
console.error(
  "  --list [--json]                                        Show recorded supersessions",
);
process.exit(1);
