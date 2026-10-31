import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { allowedRelations, captureHash, captureNote, plannedRel, privateHost, rawRelFor, type Capture } from "./capture.ts";

test("only a page fetched from the older note's own address may supersede it", () => {
  const own = ["https://docs.example.com/limits"];
  assert.ok(allowedRelations({ class: "web", source: "https://www.docs.example.com/limits/#top" }, own).includes("supersedes"));
  assert.deepEqual(allowedRelations({ class: "connector", source: "https://docs.example.com/limits" }, own), ["contests", "withdrawsSupport"]);
  assert.deepEqual(allowedRelations({ class: "web", source: "https://docs.example.com/limits?page=2" }, own), ["contests", "withdrawsSupport"]);
  assert.ok(allowedRelations({ class: "owner", source: "conversation" }, []).includes("supersedes"));
});

test("intranet and local hosts are private; public hosts are not", () => {
  for (const u of ["http://localhost:3000/a", "https://wiki.corp/x", "http://10.0.0.4/", "http://192.168.1.2", "https://intranet/x", "http://[::1]/", "https://team.internal/p"]) assert.equal(privateHost(u), true, u);
  for (const u of ["https://example.com/a", "https://docs.acme.io", "not a url"]) assert.equal(privateHost(u), false, u);
});

test("the same words as the owner's and as a page's are two captures", () => {
  assert.notEqual(captureHash("same text", "owner"), captureHash("same text", "web"));
});

test("a capture's planned note is reused by its own second edge, never by another capture's", () => {
  const v = mkdtempSync(join(tmpdir(), "cp-cap-"));
  try {
    const cap: Capture = { hash: "a".repeat(32), class: "owner", source: "conversation", title: "In conversation - kestrel", capturedAt: "2026-10-01T12:00:00Z", text: "x" };
    const first = plannedRel(v, "Alpha/Old One.md", cap);
    mkdirSync(join(v, "Alpha"), { recursive: true });
    writeFileSync(join(v, first), captureNote(cap, rawRelFor(first)));
    assert.equal(plannedRel(v, "Alpha/Old Two.md", cap), first);
    const other = { ...cap, hash: "b".repeat(32) };
    assert.notEqual(plannedRel(v, "Alpha/Old Two.md", other), first);
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});
