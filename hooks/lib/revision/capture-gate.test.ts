import { test } from "node:test";
import assert from "node:assert/strict";
import { capturePool, chunks } from "./capture-gate.ts";

test("chunks cuts paragraphs into bounded pieces and samples a long text evenly", () => {
  const text = Array.from({ length: 100 }, (_, i) => `Paragraph ${i} about the kestrel pipeline and its nightly run time.`).join("\n\n");
  const c = chunks(text, 10);
  assert.equal(c.length, 10);
  assert.ok(c[0].startsWith("Paragraph 0"));
  assert.ok(c.every((x) => x.length <= 1050));
  assert.deepEqual(chunks(""), []);
});

test("capturePool keeps strong hits only, most-matched chunks first", () => {
  const text = ["The kestrel pipeline now takes 41 minutes per nightly run.", "Weather was mild.", "Kestrel pipeline storage moved to the new cluster."].join("\n\n\n\n" + "x".repeat(700) + "\n\n");
  const search = (q: string) => {
    if (/kestrel/i.test(q)) return [{ id: 7, score: 30, matched: ["kestrel", "pipeline", "run"] }, { id: 9, score: 12, matched: ["pipeline"] }];
    return [{ id: 3, score: 40, matched: ["weather"] }];
  };
  assert.deepEqual(capturePool(text, search), [7]);
  assert.deepEqual(capturePool("nothing", () => []), []);
});
