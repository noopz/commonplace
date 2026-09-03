/**
 * Predicates for the two enforcement hooks in `register.ts`.
 *
 * Pure — no `$`, no Node builtins, no I/O — because the function-hooks
 * sandbox forbids all of them and because every decision that can refuse a
 * tool call must be unit-testable without a live engine. The caller wires
 * these to `tool.call` and returns `{ deny }` verbatim.
 *
 * Two CLAUDE.md hard rules exist precisely because prose has not stopped the
 * model from breaking them. These turn the rules into mechanism:
 *
 *   1. "Never use Python or shell one-liners to parse JSON" — the vault's
 *      `.wiki/*.jsonl` indexes are for Grep, JSON config is for Read, and the
 *      plugin's scripts are reached through the `commonplace` CLI, never by
 *      `npx tsx scripts/...`.
 *   2. Private vault content must never land in a public repo — test fixtures
 *      are invented, not copied.
 *
 * BIAS: this plugin is global, so a false positive blocks real work in a repo
 * that has nothing to do with the vault. Every rule below therefore requires
 * two independent signals (a vault artifact AND a parser; a distinctive
 * multi-word title AND a verbatim match) before it denies. Misses are
 * accepted; blocking a stranger's `jq . package.json` is not.
 */

// ---------------------------------------------------------------------------
// Shell parsing helpers
// ---------------------------------------------------------------------------

/**
 * Split a command string into pipelines, each a list of stages, honouring
 * shell quoting so a `|` inside `'...'` or `"..."` is text, not a pipe.
 *
 * Pipelines are the unit of judgement: `grep x .wiki/a.jsonl; python3 -c
 * 'print(1)'` is two unrelated commands, and must not be denied because the
 * artifact and the parser happen to share a line. Subshells and parentheses
 * are deliberately not tracked — `x=$(cat .wiki/a.jsonl | jq .)` still splits
 * at the pipe, which is the behaviour we want.
 */
export function splitPipelines(command: string): string[][] {
  const src = String(command ?? "");
  const pipelines: string[][] = [];
  let stages: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;

  const endStage = () => {
    if (cur.trim()) stages.push(cur.trim());
    cur = "";
  };
  const endPipeline = () => {
    endStage();
    if (stages.length) pipelines.push(stages);
    stages = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && next !== undefined) {
        cur += next;
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      cur += ch + next;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "|" && next === "|") {
      endPipeline();
      i++;
      continue;
    }
    if (ch === "&" && next === "&") {
      endPipeline();
      i++;
      continue;
    }
    if (ch === "|") {
      endStage();
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "&") {
      endPipeline();
      continue;
    }
    cur += ch;
  }
  endPipeline();
  return pipelines;
}

/**
 * Interpreters whose `-c` / `-e` style flags turn a shell line into an ad-hoc
 * JSON parser. A heredoc fed to one of these is code too, so it is kept.
 */
const INTERPRETER = /^(python[0-9.]*|node|nodejs|ruby|perl|deno|bun)$/;

/**
 * Drop heredoc bodies that are DATA (`cat <<EOF`, `tee`, a redirect into a
 * file) so example text quoting the forbidden pattern cannot trip the check.
 * A heredoc whose command line is an interpreter (`python3 - <<'EOF'`) is a
 * program, and is kept for inspection.
 */
export function stripDataHeredocs(command: string): string {
  const lines = String(command ?? "").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!m) continue;
    const terminator = m[2];
    const firstWord = firstCommandWord(line.split("|").pop() ?? line);
    const isProgram = INTERPRETER.test(firstWord);
    // Skip to the terminator. A program body is folded onto the command line
    // so the pipeline splitter sees it as part of the interpreter's stage.
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length && lines[j].trim() !== terminator) {
      if (isProgram) body.push(lines[j]);
      j++;
    }
    if (isProgram && body.length) out[out.length - 1] += " " + body.join(" ");
    i = j;
  }
  return out.join("\n");
}

/** Full-line `# comments` are prose; keep inline `#` since it may be quoted. */
function stripCommentLines(command: string): string {
  return String(command ?? "")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/** Prefixes that wrap a command without changing what it is. */
const WRAPPERS = new Set(["sudo", "command", "time", "env", "exec", "nohup", "builtin"]);

/** The program a stage actually runs, past `VAR=x` assignments and wrappers. */
export function firstCommandWord(stage: string): string {
  const words = String(stage ?? "").trim().split(/\s+/);
  let inWrapper = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    if (WRAPPERS.has(w)) {
      inWrapper = true;
      continue;
    }
    if (inWrapper && w.startsWith("-")) {
      // `sudo -u alpha`, `env -C dir`: these flags consume the next word.
      if (/^-(u|g|C|S)$/.test(w)) i++;
      continue;
    }
    return w.replace(/^.*\//, ""); // basename: /usr/bin/python3 → python3
  }
  return "";
}

// ---------------------------------------------------------------------------
// Rule 1 — JSON one-liners and manual script invocation
// ---------------------------------------------------------------------------

/**
 * A stage that parses its input or a named file as an ad-hoc program.
 *
 * `jq`/`yq` always count. An interpreter counts only with an eval flag
 * (`-c`, `-e`, `-p`, `-m json.tool`, `eval`) or a heredoc/stdin program —
 * `python3 build.py` and `node --test x.ts` are not one-liners.
 */
export function isParserStage(stage: string): boolean {
  const s = String(stage ?? "").trim();
  const word = firstCommandWord(s);
  if (word === "jq" || word === "gojq" || word === "yq") return true;
  if (!INTERPRETER.test(word)) return false;
  if (/<<-?\s*['"]?[A-Za-z_]/.test(s)) return true;
  if (/(^|\s)-\s*($|<)/.test(s)) return true; // `python3 - < file`
  if (/^python/.test(word)) {
    return /(^|\s)-c(\s|$)/.test(s) || /(^|\s)-m\s+json(\.tool)?(\s|$)/.test(s);
  }
  if (word === "node" || word === "nodejs" || word === "bun") {
    return /(^|\s)(-e|-p|--eval|--print)(\s|=|$)/.test(s);
  }
  if (word === "deno") return /(^|\s)eval(\s|$)/.test(s);
  return /(^|\s)-e(\s|$)/.test(s); // ruby, perl
}

/**
 * Does the text name a vault JSON artifact? Deliberately narrow: `.wiki/`
 * paths, the five index basenames, and the plugin's `vaults.json` registry.
 * A bare `config.json` or `data.jsonl` in some other repo is NOT a vault
 * artifact, and `jq` over it is nobody's business.
 */
export function mentionsVaultJson(text: string): boolean {
  const t = String(text ?? "");
  if (/\.wiki\/[^\s'"|;&)]*\.jsonl?\b/.test(t)) return true;
  if (/\b(source|concept|moc|domain|backlink)-index\.jsonl\b/.test(t)) return true;
  // The vault registry lives under CLAUDE_PLUGIN_DATA, so require that
  // context. A bare `jq . vaults.json` in a HashiCorp or gamedev repo is a
  // different file entirely and none of this guard's business.
  if (/(CLAUDE_PLUGIN_DATA|commonplace)[^\s'"|;&)]*\/vaults\.json\b/.test(t)) return true;
  return false;
}

/** A `commonplace ... --json` stage — machine output the model should read as-is. */
function isCommonplaceJsonStage(stage: string): boolean {
  return firstCommandWord(stage) === "commonplace" && /(^|\s)--json(\s|$)/.test(stage);
}

/*
 * There used to be a PLUGIN_SCRIPTS basename allowlist here, so that a bare
 * `npx tsx scripts/lint.ts` was recognised as a plugin script without knowing
 * the cwd. It was removed: this hook is GLOBAL, and the list contained
 * `seed`, `index`, `init`, `lint`, `validate` and `log` — so it denied
 * `npx tsx scripts/seed.ts` in every Prisma or Drizzle project on the machine.
 * A guard that blocks unrelated repos' ordinary work is worse than a guard
 * that occasionally misses.
 *
 * It was also wrong for the one repo it targeted: inside commonplace itself,
 * running `npx tsx scripts/<name>.ts` by hand is the only way to exercise
 * UNCOMMITTED script code, because the `commonplace` bin runs the installed
 * plugin's copy. Only an explicit plugin path is denied now.
 */

/**
 * A stage that runs one of the plugin's TypeScript scripts by hand instead of
 * through the `commonplace` CLI. Matches `npx tsx`, `tsx`, `node`, `bun`,
 * `deno run` against a `scripts/<name>.ts` path that is visibly inside
 * the plugin (`commonplace/scripts/`, `${CLAUDE_PLUGIN_ROOT}/scripts/`) —
 * an explicit plugin path. Test runs (`--test`, `*.test.ts`) are the legitimate
 * way to exercise those files and are never denied.
 */
export function manualScriptPath(stage: string): string | null {
  const s = String(stage ?? "").trim();
  const word = firstCommandWord(s);
  const runner =
    word === "tsx" || word === "node" || word === "bun" ||
    (word === "npx" && /(^|\s)npx\s+(-[^\s]+\s+)*tsx(\s|$)/.test(s)) ||
    (word === "deno" && /(^|\s)run(\s|$)/.test(s));
  if (!runner) return null;
  if (/(^|\s)--test(\s|$)/.test(s)) return null;
  const m = s.match(/(?:^|[\s'"=])((?:[^\s'"]*\/)?scripts\/([A-Za-z0-9_.-]+)\.ts)(?:[\s'"]|$)/);
  if (!m) return null;
  const [, path, base] = m;
  if (base.endsWith(".test")) return null;
  return /commonplace\/|CLAUDE_PLUGIN_ROOT/.test(path) ? path : null;
}

/**
 * Deny a Bash command that breaks the "never parse JSON with one-liners" rule
 * or reaches past the `commonplace` CLI to run a plugin script by hand.
 *
 * Denies when, within ONE pipeline, a vault JSON artifact (or a `commonplace
 * --json` stage) meets a parser stage (`jq`, `python3 -c`, `node -e`, ...).
 * Denies a runner stage pointed at a recognisable plugin script.
 *
 * Never denies: `commonplace` calls, grep/rg over the indexes, `cat` of a
 * note, interpreters doing unrelated work, `jq` over files outside the vault,
 * or example text inside a data heredoc / echo / comment. Conservative on
 * purpose — see the module header.
 */
export function checkBashCommand(command: string): { deny: string } | null {
  const cleaned = stripCommentLines(stripDataHeredocs(String(command ?? "")));
  if (!cleaned.trim()) return null;

  for (const stages of splitPipelines(cleaned)) {
    for (const stage of stages) {
      const path = manualScriptPath(stage);
      if (path) {
        return {
          deny:
            `Do not run plugin scripts by hand (${path}). ` +
            `Use the \`commonplace\` CLI instead — it is already on PATH: ` +
            `\`commonplace <cmd>\` (see CLAUDE.md, "Scripts").`,
        };
      }
    }

    const hasParser = stages.some(isParserStage);
    if (!hasParser) continue;
    const pipelineText = stages.join(" | ");
    const viaCli = stages.some(isCommonplaceJsonStage);
    if (!mentionsVaultJson(pipelineText) && !viaCli) continue;

    return {
      deny:
        `Never parse vault JSON with a shell one-liner (CLAUDE.md hard rule). ` +
        (viaCli
          ? `\`commonplace <cmd> --json\` already prints valid JSON — run it alone and read the output directly. `
          : `To search a \`.wiki/*.jsonl\` index use the Grep tool; to read a JSON file use the Read tool; ` +
            `for computed results use \`commonplace <cmd> --json\` and read its output directly. `) +
        `Not python3 -c / jq / node -e.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 2 — private vault material in a public repo
// ---------------------------------------------------------------------------

/**
 * Words that carry no identity on their own. A title made only of these
 * ("Weekly Review", "Project Notes") cannot be recognised in prose without
 * an unacceptable false-positive rate, so it is only ever caught via an
 * explicit `[[wikilink]]`.
 */
const WEAK = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "over", "under",
  "about", "after", "before", "between", "through", "during", "using",
  "note", "notes", "guide", "handbook", "overview", "summary", "review",
  "plan", "plans", "planning", "project", "projects", "list", "lists",
  "weekly", "daily", "monthly", "annual", "meeting", "meetings", "log",
  "index", "misc", "general", "personal", "private", "home", "work",
  "ideas", "idea", "todo", "todos", "draft", "drafts", "new", "old",
]);

/** Lowercase, punctuation to spaces, whitespace collapsed. */
export function normalizePhrase(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Tokens that contribute identity: not in WEAK, at least three characters. */
function strongTokens(title: string): string[] {
  return normalizePhrase(title)
    .split(" ")
    .filter((t) => t.length >= 3 && !WEAK.has(t));
}

/**
 * Whether a title is distinctive enough for a verbatim prose match to count
 * as evidence. Threshold: at least TWO strong tokens, or one strong token of
 * twelve-plus characters (a coined term, not a dictionary word).
 *
 * Failure modes, stated plainly:
 * - A two-word title of ordinary words ("Alpha Method") WILL fire when that
 *   exact phrase appears in unrelated text. The phrase must be verbatim and
 *   contiguous, which keeps this rare, and the deny names the title so the
 *   user can judge.
 * - A single common-word title ("Rust") never fires in prose, even when the
 *   text is genuinely about the private note. Only a `[[Rust]]` wikilink
 *   catches it.
 * - Paraphrase is invisible. This catches copy-paste, not summary.
 */
export function isDistinctiveTitle(title: string): boolean {
  const strong = strongTokens(title);
  if (strong.length >= 2) return true;
  return strong.length === 1 && strong[0].length >= 12;
}

/** Regex-escape a normalized phrase for a whole-word search. */
function phraseRe(phrase: string): RegExp {
  return new RegExp(`(^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);
}

/**
 * Titles from `privateTitles` that `text` reproduces. Two ways to match:
 *
 * - An explicit `[[Title]]` / `[[Title|alias]]` / `[[Title#heading]]`
 *   wikilink, for ANY title — a wikilink is a literal reference into the
 *   vault, never a coincidence of vocabulary.
 * - The normalized title as a contiguous whole-word phrase in the normalized
 *   text, for DISTINCTIVE titles only (see `isDistinctiveTitle`).
 */
export function findPrivateMatches(text: string, privateTitles: string[]): string[] {
  const raw = String(text ?? "");
  if (!raw.trim()) return [];
  const norm = " " + normalizePhrase(raw) + " ";
  const links = new Set<string>();
  for (const m of raw.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    links.add(normalizePhrase(m[1]));
  }

  const hits: string[] = [];
  for (const t of privateTitles ?? []) {
    const title = String(t ?? "").trim();
    const nt = normalizePhrase(title);
    if (!nt) continue;
    if (links.has(nt)) {
      hits.push(title);
      continue;
    }
    if (isDistinctiveTitle(title) && phraseRe(nt).test(norm)) hits.push(title);
  }
  return hits;
}

/**
 * Deny a write whose text reproduces private-domain vault material.
 *
 * There was a `{repoIsPublic}` option here; it was always passed `true` and
 * the private-repo branch was dead. Nothing available to the caller can
 * actually determine a repo's visibility — `$.session.repo().internal` means
 * "a repo this build treats as its own", which a private personal repo is
 * not — so the rule enforced is the one that holds either way: private vault
 * material belongs in the vault, and copying it into a code repository is
 * suspect regardless of who can read that repository.
 *
 * `privateTitles` is the caller's concern: source titles AND concept names
 * from every `scope: "private"` domain. This function only decides whether
 * the text contains them; see `findPrivateMatches` for the matching rule and
 * its limits.
 */
export function checkPrivateLeak(
  text: string,
  privateTitles: string[],
): { deny: string } | null {
  const hits = findPrivateMatches(text, privateTitles);
  if (hits.length === 0) return null;
  const shown = hits.slice(0, 3).map((h) => `"${h}"`).join(", ");
  const more = hits.length > 3 ? ` (+${hits.length - 3} more)` : "";
  return {
    deny:
      `This write reproduces private vault material outside the vault: ${shown}${more}. ` +
      `Invent fixtures and examples instead (\`Alpha Method\`, \`Gamma Term\`, domains \`alpha\`/\`gamma\`) — ` +
      `see CLAUDE.md, "Test fixtures must be invented".`,
  };
}
