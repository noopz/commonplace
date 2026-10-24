/**
 * The surfaces' pure logic on invented notes: wikilinks and the citation
 * footer, link triage, and the witness.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { wikiRefs, linkWikiRefs, fileHref, citationFooter, citationCounts, segments } from "./wikilinks.ts";
import { pastedUrls, sameUrl, parseTriage, triageLine, addLater, formatLater, triagePrompt, LATER_MAX } from "./triage.ts";
import { Witness, renderWitness, WITNESS_MAX } from "./witness.ts";

test("wikilinks: found once each, outside code, with labels and headings", () => {
  const text = [
    "See [[Alpha Method]] and [[alpha method|the method]], then [[Gamma Term#Usage]].",
    "Inline `[[Not A Link]]` is code.",
    "```",
    "[[Fenced Example]]",
    "```",
    "And [[Beta Report|its report]].",
  ].join("\n");
  assert.deepEqual(wikiRefs(text).map((r) => r.title), ["Alpha Method", "Gamma Term", "Beta Report"]);
  assert.equal(wikiRefs(text)[2].label, "its report");
});

test("wikilinks: only resolved titles become links; code and unresolved stay as written", () => {
  const text = "Read [[Alpha Method]], not [[Nowhere Note]]. `[[Alpha Method]]`";
  const out = linkWikiRefs(text, (t) => (t === "Alpha Method" ? fileHref("/v/acme/Alpha Method.md") : null));
  assert.equal(out, "Read [Alpha Method](file:///v/acme/Alpha%20Method.md), not [[Nowhere Note]]. `[[Alpha Method]]`");
  assert.equal(linkWikiRefs("[[A [x]|b]]", () => "file:///a"), "[[A [x]|b]]", "a title with brackets does not match");
  assert.equal(linkWikiRefs("[[A|x [y]]", () => "file:///a"), "[x \\[y](file:///a)", "brackets in a label are escaped");
});

test("segments: an unclosed backtick is text, a longer fence closes only on its own length", () => {
  assert.deepEqual(segments("a `b").map((s) => s.code), [false]);
  const s = segments("````\n```\n[[x]]\n````\nafter [[y]]");
  assert.equal(s[0].code, true);
  assert.match(s[0].text, /\[\[x\]\]/);
  assert.equal(s[1].text, "after [[y]]");
});

test("citation footer: only citations that do not hold up get a line", () => {
  const cited = [
    { title: "Alpha Method", status: "ok" as const, href: "file:///a", supersededBy: ["Beta Report"] },
    { title: "Gamma Term", status: "unread" as const },
    { title: "Nowhere Note", status: "missing" as const },
    { title: "Plain Note", status: "ok" as const, href: "file:///p" },
  ];
  assert.deepEqual(citationFooter(cited).split("  \n"), [
    "⚠ [Alpha Method](file:///a) · superseded by [[Beta Report]]",
    "⚠ [[Gamma Term]] · cited without being read this session",
    "✗ [[Nowhere Note]] is not a note in your vault",
  ]);
  assert.equal(citationFooter([{ title: "Plain Note", status: "ok" }]), "", "sound citations draw no footer");
  const many = Array.from({ length: 8 }, (_, i) => ({ title: `Missing ${i}`, status: "missing" as const }));
  assert.match(citationFooter(many), /… 2 more$/);
  assert.deepEqual(citationCounts(cited), { refs: 4, missing: 1, unread: 1 });
});
test("triage: urls are trimmed and capped; the verdict must name a candidate", () => {
  assert.deepEqual(pastedUrls("see https://example.org/a), and http://x.test/b. and https://example.org/a"), ["https://example.org/a", "http://x.test/b"]);
  assert.ok(sameUrl("https://www.acme.example/paper/#s2", "http://acme.example/paper"));
  assert.ok(!sameUrl("https://acme.example/paper", "https://acme.example/paper/v2"));
  const cands = ["Alpha Method", "Beta Report"];
  assert.deepEqual(parseTriage('Sure: {"verdict":"extends","note":"alpha method","why":"adds a benchmark"}', cands), {
    verdict: "extends", note: "Alpha Method", why: "adds a benchmark",
  });
  assert.deepEqual(parseTriage('{"verdict":"extends","note":"Invented Title","why":"x"}', cands), { verdict: "new", note: "", why: "x" }, "an invented title is dropped");
  assert.equal(parseTriage('{"verdict":"maybe"}', cands), null);
  assert.equal(parseTriage("no json here", cands), null);
  assert.equal(triageLine({ verdict: "extends", note: "Alpha Method", why: "adds a benchmark" }, "https://www.example.org/x"), "example.org · extends [[Alpha Method]] — adds a benchmark");
  assert.match(triagePrompt(["https://e.test"], []), /no candidate notes/);
});

test("triage: the later list dedupes by url and keeps the newest", () => {
  let list = addLater([], { url: "https://a.test", verdict: "new", note: "", why: "", at: "2026-01-01T00:00:00Z" });
  list = addLater(list, { url: "https://a.test", verdict: "extends", note: "Alpha Method", why: "w", at: "2026-01-02T00:00:00Z" });
  assert.equal(list.length, 1);
  assert.equal(list[0].verdict, "extends");
  for (let i = 0; i < LATER_MAX + 5; i++) list = addLater(list, { url: `https://e.test/${i}`, verdict: "new", note: "", why: "", at: "2026-01-03T00:00:00Z" });
  assert.equal(list.length, LATER_MAX);
  assert.match(formatLater(list), /^· https:\/\/e\.test\/204/);
});

test("witness: keeps the newest, counts every character, renders verbatim", () => {
  const w = new Witness();
  w.add("prime", "", 0);
  assert.equal(w.list().length, 0);
  for (let i = 0; i < WITNESS_MAX + 2; i++) w.add("context", `entry ${i}`, i);
  assert.equal(w.list().length, WITNESS_MAX);
  assert.equal(w.list()[0].text, "entry 2");
  assert.ok(w.chars() > 0);
  const md = renderWitness(w);
  assert.match(md, /^\*\*100 hidden additions/);
  assert.match(md, /entry 101/);
  w.clear();
  assert.match(renderWitness(w), /Nothing hidden/);
});
