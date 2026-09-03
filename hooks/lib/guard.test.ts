/**
 * Tests for the enforcement predicates in guard.ts.
 *
 * FIXTURES ARE INVENTED. Per CLAUDE.md: this repo is public, so no note title,
 * concept name, domain slug or body text below comes from a real vault. Every
 * title is a placeholder (`Alpha Method`, `Gamma Term`, ...).
 *
 * False positives are the risk here — the plugin is global, and a wrong deny
 * blocks real work in an unrelated repo — so the "must NOT deny" cases are
 * the larger half of this file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  splitPipelines,
  stripDataHeredocs,
  firstCommandWord,
  isParserStage,
  mentionsVaultJson,
  manualScriptPath,
  checkBashCommand,
  normalizePhrase,
  isDistinctiveTitle,
  findPrivateMatches,
  checkPrivateLeak,
} from "./guard.ts";

// ---------------------------------------------------------------------------
// Shell parsing helpers
// ---------------------------------------------------------------------------

test("splitPipelines splits on unquoted pipes and separators only", () => {
  assert.deepEqual(splitPipelines("a | b; c && d || e\nf"), [
    ["a", "b"], ["c"], ["d"], ["e"], ["f"],
  ]);
  // a pipe inside quotes is text
  assert.deepEqual(splitPipelines(`echo 'x | y' | wc`), [["echo 'x | y'", "wc"]]);
  assert.deepEqual(splitPipelines(`echo "x | y"`), [[`echo "x | y"`]]);
  // an escaped pipe is text
  assert.deepEqual(splitPipelines(`grep a\\|b file`), [["grep a\\|b file"]]);
  // empty input
  assert.deepEqual(splitPipelines(""), []);
  assert.deepEqual(splitPipelines(undefined as unknown as string), []);
});

test("firstCommandWord skips assignments, wrappers, and directory prefixes", () => {
  assert.equal(firstCommandWord("FOO=1 BAR=2 /usr/bin/python3 -c x"), "python3");
  assert.equal(firstCommandWord("sudo -u alpha jq . f"), "jq");
  assert.equal(firstCommandWord("env -i node -e 1"), "node");
  assert.equal(firstCommandWord("  commonplace lint"), "commonplace");
  assert.equal(firstCommandWord(""), "");
});

test("stripDataHeredocs removes data heredocs but keeps program heredocs", () => {
  const data = [
    "cat <<'EOF' > notes.md",
    "example: cat .wiki/moc-index.jsonl | python3 -c 'import json'",
    "EOF",
    "echo done",
  ].join("\n");
  const stripped = stripDataHeredocs(data);
  assert.ok(!stripped.includes("moc-index"), "data body must be dropped");
  assert.ok(stripped.includes("echo done"), "lines after the terminator survive");

  const program = [
    "python3 - <<'EOF'",
    "import json; json.load(open('.wiki/config.json'))",
    "EOF",
  ].join("\n");
  assert.ok(stripDataHeredocs(program).includes(".wiki/config.json"), "program body is kept");
});

test("isParserStage recognises ad-hoc parsers and nothing else", () => {
  for (const s of [
    "jq .x file", "python3 -c 'print(1)'", "python -c x", "python3.12 -c x",
    "python3 -m json.tool f", "node -e 'x'", "node --eval x", "node -p 1",
    "ruby -e x", "perl -e x", "deno eval x", "bun -e x",
    "python3 - < f", "python3 - <<'EOF'", "/usr/bin/jq .", "sudo jq .",
  ]) {
    assert.equal(isParserStage(s), true, `should be a parser stage: ${s}`);
  }
  for (const s of [
    "python3 build.py", "python3 -m pytest", "node --import tsx --test x.test.ts",
    "node server.js", "grep x f", "cat f", "commonplace lint --json",
    "rg pattern", "deno run x.ts", "ruby script.rb", "",
  ]) {
    assert.equal(isParserStage(s), false, `should NOT be a parser stage: ${s}`);
  }
});

test("mentionsVaultJson is narrow: .wiki paths, index basenames, vaults.json", () => {
  for (const t of [
    ".wiki/concept-index.jsonl", "$VAULT/.wiki/config.json",
    "/home/u/notes/.wiki/domains.json", "concept-index.jsonl",
    "backlink-index.jsonl", "vaults.json", "open('.wiki/freshness.json')",
  ]) {
    assert.equal(mentionsVaultJson(t), true, `should match: ${t}`);
  }
  for (const t of [
    "package.json", "config.json", "data.jsonl", "tsconfig.json",
    "/tmp/other/events.jsonl", ".wiki/log.md", ".wiki/", "index.json",
  ]) {
    assert.equal(mentionsVaultJson(t), false, `should NOT match: ${t}`);
  }
});

test("manualScriptPath recognises plugin scripts run by hand", () => {
  assert.equal(manualScriptPath("npx tsx scripts/lint.ts"), "scripts/lint.ts");
  assert.equal(manualScriptPath("node scripts/index.ts --incremental"), "scripts/index.ts");
  assert.equal(manualScriptPath("tsx ./scripts/seed.ts --query x"), "./scripts/seed.ts");
  assert.equal(
    manualScriptPath("node ${CLAUDE_PLUGIN_ROOT}/scripts/anything.ts"),
    "${CLAUDE_PLUGIN_ROOT}/scripts/anything.ts",
  );
  assert.equal(
    manualScriptPath('npx tsx "/u/z/projects/commonplace/scripts/custom.ts"'),
    "/u/z/projects/commonplace/scripts/custom.ts",
  );
  assert.equal(manualScriptPath("bun scripts/lint.ts"), "scripts/lint.ts");
  assert.equal(manualScriptPath("deno run scripts/lint.ts"), "scripts/lint.ts");
});

test("manualScriptPath leaves foreign repos, tests, and the bin shim alone", () => {
  for (const s of [
    "npx tsx scripts/migrate.ts",            // unknown basename, not in plugin
    "node scripts/build.js",                 // .js, never a plugin script
    "node --import tsx --test scripts/lint.test.ts",
    "npx tsx scripts/index.test.ts",
    "node ${CLAUDE_PLUGIN_ROOT}/bin/commonplace lint",
    "commonplace lint",
    "npx prettier scripts/lint.ts",          // npx of something other than tsx
    "cat scripts/lint.ts",
    "",
  ]) {
    assert.equal(manualScriptPath(s), null, `should be allowed: ${s}`);
  }
});

// ---------------------------------------------------------------------------
// checkBashCommand — true positives
// ---------------------------------------------------------------------------

test("checkBashCommand denies the exact CLAUDE.md examples", () => {
  const r1 = checkBashCommand(
    `cat .wiki/moc-index.jsonl | python3 -c "import json,sys; ..."`,
  );
  assert.ok(r1, "python3 -c over a vault index must be denied");
  assert.match(r1.deny, /Grep/);
  assert.match(r1.deny, /Read/);

  const r2 = checkBashCommand(
    `cat .wiki/config.json | python3 -c "import json,sys; data=json.load(sys.stdin); ..."`,
  );
  assert.ok(r2);
});

test("checkBashCommand denies jq, node -e, and python reading a vault file directly", () => {
  for (const c of [
    "jq '.domains' .wiki/domains.json",
    "jq -r '.path' $VAULT/.wiki/source-index.jsonl",
    "node -e \"console.log(require('./.wiki/config.json'))\"",
    `python3 -c "import json; print(json.load(open('.wiki/domains.json')))"`,
    "python3 -m json.tool .wiki/config.json",
    "grep alpha .wiki/concept-index.jsonl | jq .name",
    "cat concept-index.jsonl | jq -c .",
    "x=$(cat .wiki/config.json | jq -r .vault)",
    "jq .default \"$CLAUDE_PLUGIN_DATA/vaults.json\"",
    "python3 - <<'EOF'\nimport json\njson.load(open('.wiki/config.json'))\nEOF",
  ]) {
    assert.ok(checkBashCommand(c), `should deny: ${c}`);
  }
});

test("checkBashCommand denies piping commonplace --json into a parser", () => {
  const r = checkBashCommand("commonplace lint --json | jq '.stubs | length'");
  assert.ok(r);
  assert.match(r.deny, /read the output directly/);
});

test("checkBashCommand denies manual plugin script invocation with a CLI pointer", () => {
  const r = checkBashCommand("npx tsx scripts/index.ts --incremental");
  assert.ok(r);
  assert.match(r.deny, /commonplace/);
  assert.ok(checkBashCommand("cd /x && node scripts/lint.ts --json"));
});

// ---------------------------------------------------------------------------
// checkBashCommand — must NOT deny (the risk side)
// ---------------------------------------------------------------------------

test("checkBashCommand allows commonplace CLI calls of every shape", () => {
  for (const c of [
    "commonplace lint",
    "commonplace lint --json",
    "commonplace index --incremental",
    "commonplace seed --query \"alpha method\" --json",
    "OUT=$(commonplace score --json)",
    "commonplace eval:retrieval --gold .wiki/evals/gold.jsonl --json",
    "node ${CLAUDE_PLUGIN_ROOT}/bin/commonplace post-write",
    "commonplace lint --json > /tmp/out.json && echo ok",
  ]) {
    assert.equal(checkBashCommand(c), null, `should allow: ${c}`);
  }
});

test("checkBashCommand allows grep, rg, cat, head, wc over vault files", () => {
  for (const c of [
    'grep "Alpha Method" .wiki/concept-index.jsonl',
    "rg -c alpha $VAULT/.wiki/source-index.jsonl",
    "cat notes/alpha-method.md",
    "cat .wiki/log.md",
    "head -n 5 .wiki/moc-index.jsonl",
    "wc -l .wiki/*.jsonl",
    "ls .wiki/",
    "grep -l gamma .wiki/backlink-index.jsonl | xargs wc -l",
    "cat .wiki/config.json",   // the tool of choice is Read, but cat is not a parser
  ]) {
    assert.equal(checkBashCommand(c), null, `should allow: ${c}`);
  }
});

test("checkBashCommand allows interpreters doing unrelated work", () => {
  for (const c of [
    "python3 -c 'print(1+1)'",
    "python3 -c \"import sys; print(sys.version)\"",
    "python3 -m json.tool package.json",
    "python3 manage.py migrate",
    "node -e \"console.log(process.version)\"",
    "node --import tsx --test hooks/lib/guard.test.ts",
    "node server.js",
    "ruby -e 'puts 1'",
    "perl -e 'print 1'",
    "deno run main.ts",
  ]) {
    assert.equal(checkBashCommand(c), null, `should allow: ${c}`);
  }
});

test("checkBashCommand allows jq over files outside the vault", () => {
  for (const c of [
    "jq . package.json",
    "jq -r '.version' package.json",
    "cat tsconfig.json | jq .compilerOptions",
    "jq . /etc/some/config.json",
    "curl -s https://example.invalid/api | jq .items",
    "jq -c . /tmp/other/events.jsonl",
    "kubectl get pods -o json | jq '.items[].metadata.name'",
    "gh pr view 12 --json title | jq .title",
  ]) {
    assert.equal(checkBashCommand(c), null, `should allow: ${c}`);
  }
});

test("checkBashCommand judges per pipeline, not per command string", () => {
  // artifact and parser in DIFFERENT pipelines: unrelated, allowed
  for (const c of [
    "grep alpha .wiki/concept-index.jsonl; python3 -c 'print(1)'",
    "cat .wiki/config.json && jq . package.json",
    "jq . package.json\ngrep x .wiki/moc-index.jsonl",
  ]) {
    assert.equal(checkBashCommand(c), null, `should allow: ${c}`);
  }
});

test("checkBashCommand ignores quoted example text, comments, and data heredocs", () => {
  for (const c of [
    // echo of a forbidden pattern as a string is not execution
    "echo 'cat .wiki/moc-index.jsonl | python3 -c \"...\"'",
    "printf '%s\\n' 'jq . .wiki/domains.json'",
    // a full-line comment
    "# never: cat .wiki/moc-index.jsonl | jq .\ngrep alpha .wiki/moc-index.jsonl",
    // a data heredoc writing docs that quote the anti-pattern
    [
      "cat <<'EOF' > docs/rules.md",
      "Never do this:",
      "cat .wiki/moc-index.jsonl | python3 -c \"import json\"",
      "jq . .wiki/domains.json",
      "EOF",
    ].join("\n"),
    // heredoc fed to tee, same thing
    "tee notes.md <<EOF\njq . .wiki/config.json\nEOF",
  ]) {
    assert.equal(checkBashCommand(c), null, `should allow: ${c}`);
  }
});

test("checkBashCommand allows foreign-repo scripts and .js scripts", () => {
  for (const c of [
    "npx tsx scripts/migrate.ts",
    "node scripts/build.js",
    "npm run build",
    "pnpm tsx scripts/deploy.ts",
    "node --import tsx --test scripts/index.test.ts",
  ]) {
    assert.equal(checkBashCommand(c), null, `should allow: ${c}`);
  }
});

test("checkBashCommand tolerates empty and non-string input", () => {
  assert.equal(checkBashCommand(""), null);
  assert.equal(checkBashCommand("   \n  "), null);
  assert.equal(checkBashCommand(undefined as unknown as string), null);
  assert.equal(checkBashCommand(null as unknown as string), null);
});

// ---------------------------------------------------------------------------
// checkPrivateLeak
// ---------------------------------------------------------------------------

test("normalizePhrase lowercases, strips punctuation, collapses whitespace", () => {
  assert.equal(normalizePhrase("  Alpha-Method: v2  (Draft) "), "alpha method v2 draft");
  assert.equal(normalizePhrase(""), "");
  assert.equal(normalizePhrase(undefined as unknown as string), "");
});

test("isDistinctiveTitle needs two strong tokens or one coined long word", () => {
  for (const t of [
    "Alpha Method", "Gamma Term Calibration", "Alpha-Gamma Bridge",
    "Zeptoquantization",              // single coined word, 12+ chars
    "Weekly Review of Alpha Method",  // weak words plus two strong ones
  ]) {
    assert.equal(isDistinctiveTitle(t), true, `should be distinctive: ${t}`);
  }
  for (const t of [
    "Alpha",            // one short word
    "Weekly Review",    // only weak words
    "Project Notes",
    "Meeting Log",
    "Home",
    "",
    "The",
  ]) {
    assert.equal(isDistinctiveTitle(t), false, `should NOT be distinctive: ${t}`);
  }
});

test("findPrivateMatches catches a verbatim distinctive title, case-insensitively", () => {
  const titles = ["Alpha Method", "Gamma Term"];
  assert.deepEqual(
    findPrivateMatches("We compared the alpha method to a baseline.", titles),
    ["Alpha Method"],
  );
  assert.deepEqual(
    findPrivateMatches('const name = "Gamma Term";', titles),
    ["Gamma Term"],
  );
  // punctuation between the words still reads as the phrase
  assert.deepEqual(findPrivateMatches("alpha-method", titles), ["Alpha Method"]);
});

test("findPrivateMatches does not fire on partial or non-contiguous words", () => {
  const titles = ["Alpha Method"];
  for (const text of [
    "the alphabet method",             // 'alpha' is a prefix of 'alphabet'
    "alpha and then the method",       // not contiguous
    "method alpha",                    // wrong order
    "an alphamethod",                  // one token
    "",
  ]) {
    assert.deepEqual(findPrivateMatches(text, titles), [], `should not match: ${text}`);
  }
});

test("findPrivateMatches never fires on a common single-word title in prose", () => {
  // 'Home' and 'Alpha' as bare private titles would otherwise deny nearly
  // every file; only an explicit wikilink counts for these.
  const titles = ["Home", "Alpha", "Weekly Review"];
  const prose = "go home; the alpha channel; our weekly review found nothing";
  assert.deepEqual(findPrivateMatches(prose, titles), []);
});

test("findPrivateMatches catches any title written as a wikilink", () => {
  const titles = ["Home", "Alpha", "Weekly Review", "Gamma Term"];
  assert.deepEqual(findPrivateMatches("see [[Home]] for context", titles), ["Home"]);
  assert.deepEqual(findPrivateMatches("see [[alpha|the alpha note]]", titles), ["Alpha"]);
  assert.deepEqual(findPrivateMatches("see [[Weekly Review#Monday]]", titles), ["Weekly Review"]);
  // an unrelated wikilink is not a hit
  assert.deepEqual(findPrivateMatches("see [[Delta Rule]]", titles), []);
});

test("checkPrivateLeak returns null for a private repo regardless of content", () => {
  assert.equal(
    checkPrivateLeak("the Alpha Method in full", ["Alpha Method"], { repoIsPublic: false }),
    null,
  );
});

test("checkPrivateLeak denies a public-repo write that reproduces a private title", () => {
  const r = checkPrivateLeak(
    'test("links Alpha Method to Gamma Term", () => {})',
    ["Alpha Method", "Gamma Term", "Delta Rule"],
    { repoIsPublic: true },
  );
  assert.ok(r);
  assert.match(r.deny, /"Alpha Method"/);
  assert.match(r.deny, /"Gamma Term"/);
  assert.ok(!r.deny.includes("Delta Rule"), "unmatched titles are not named");
  assert.match(r.deny, /invent/i);
});

test("checkPrivateLeak caps the titles it names but counts the rest", () => {
  const titles = ["Alpha Method", "Gamma Term", "Delta Rule", "Epsilon Bound", "Zeta Cohort"];
  const text = titles.join(", ");
  const r = checkPrivateLeak(text, titles, { repoIsPublic: true });
  assert.ok(r);
  assert.match(r.deny, /\+2 more/);
});

test("checkPrivateLeak allows invented fixtures, empty lists, and empty text", () => {
  const priv = ["Alpha Method", "Gamma Term"];
  assert.equal(
    checkPrivateLeak('test("Beta Rule links to Delta Cohort")', priv, { repoIsPublic: true }),
    null,
  );
  assert.equal(checkPrivateLeak("anything at all", [], { repoIsPublic: true }), null);
  assert.equal(checkPrivateLeak("", priv, { repoIsPublic: true }), null);
  assert.equal(
    checkPrivateLeak(undefined as unknown as string, priv, { repoIsPublic: true }),
    null,
  );
  assert.equal(
    checkPrivateLeak("x", undefined as unknown as string[], { repoIsPublic: true }),
    null,
  );
  assert.equal(checkPrivateLeak("Alpha Method", priv, undefined as never), null);
});

test("checkPrivateLeak tolerates junk in the title list", () => {
  const priv = ["", "   ", "---", undefined as unknown as string, "Alpha Method"];
  assert.equal(checkPrivateLeak("nothing here", priv, { repoIsPublic: true }), null);
  assert.ok(checkPrivateLeak("alpha method", priv, { repoIsPublic: true }));
});
