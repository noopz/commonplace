import { test } from "node:test";
import assert from "node:assert/strict";
import { capturePool, chunks, connectorRead, typedCapture } from "./capture-gate.ts";

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

test("a connector's read is captured; a write, an error or a scrap is not", () => {
  const long = "x".repeat(300);
  assert.deepEqual(connectorRead({ tool: "mcp__acme__fetch_page", url: "https://wiki.example.com/a" }, { text: long }), { class: "connector", source: "https://wiki.example.com/a", text: long });
  assert.equal(connectorRead({ tool: "mcp__acme__fetch_page" }, { result: [{ type: "text", text: long }] })?.source, "mcp__acme__fetch_page");
  for (const tool of ["mcp__acme__slack_send_message", "mcp__acme__notion-create-pages", "mcp__acme__createPage"]) assert.equal(connectorRead({ tool }, { text: long }), null, tool);
  assert.ok(connectorRead({ tool: "mcp__acme__createPage" }, { text: long, isReadOnly: true }), "the server's word wins");
  assert.equal(connectorRead({ tool: "mcp__acme__read" }, { text: long, isError: true }), null);
  assert.equal(connectorRead({ tool: "mcp__acme__read" }, { text: long, deny: "no" }), null);
  assert.equal(connectorRead({ tool: "mcp__acme__read" }, { text: "short" }), null);
});

test("typed words are the owner's; pasted text and commands are not", () => {
  const typed = "The kestrel pipeline moved to a nightly run in March, so anything that says it runs hourly is out of date now, and we should treat it so.";
  assert.deepEqual(typedCapture(typed, "2026-11-01"), { class: "owner", source: "conversation", text: typed, asOf: "2026-11-01" });
  assert.equal(typedCapture("short", "d"), null);
  assert.equal(typedCapture(`/vault ${typed}`, "d"), null);
  for (const t of [`${typed}\n\`\`\`\ncode\n\`\`\``, `> ${typed}`, `Subject: hello\n${typed}`, "y ".repeat(800)]) assert.equal(typedCapture(t, "d")?.class, "connector", t.slice(0, 20));
});
