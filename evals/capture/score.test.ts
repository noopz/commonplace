import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCase, summarize, type CaptureCase } from "./score.ts";

const c = (id: string, expect: "change" | "none", cls: CaptureCase["class"] = "web"): CaptureCase => ({
  id,
  class: cls,
  source: "https://example.com",
  kind: "k",
  older: { title: "Old", text: "t", claim: "c" },
  capture: { title: "Cap", text: "t" },
  expect,
});

test("a case changes on a majority of trials where the detector flagged it and the reviewer named a relation", () => {
  const r = scoreCase(c("a", "change"), [
    { detected: true, verdict: "contests", final: "contests" },
    { detected: true, verdict: "none", final: null },
    { detected: false, verdict: null, final: null },
  ]);
  assert.equal(r.got, "none");
  assert.equal(scoreCase(c("b", "none", "owner"), [{ detected: true, verdict: "supersedes", final: "supersedes" }]).limitBroken, false);
  assert.equal(scoreCase(c("b", "none"), [{ detected: true, verdict: "supersedes", final: "supersedes" }]).limitBroken, true);
});

test("the summary gates on precision, false change, recall and the limit", () => {
  const yes = { detected: true, verdict: "contests", final: "contests" };
  const no = { detected: false, verdict: null, final: null };
  const traps = Array.from({ length: 15 }, (_, i) => scoreCase(c(`n${i}`, "none"), [no]));
  const s = summarize([scoreCase(c("a", "change"), [yes]), ...traps]);
  assert.deepEqual([s.precision, s.recall, s.falseChange, s.pass], [1, 1, 0, true]);
  assert.equal(summarize([scoreCase(c("a", "change"), [yes]), ...traps.slice(3)]).pass, false, "too few traps to say");
  assert.equal(summarize([scoreCase(c("a", "change"), [yes]), scoreCase(c("b", "none"), [yes])]).pass, false);
});
