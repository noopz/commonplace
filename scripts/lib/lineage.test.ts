import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendLineage } from "./lineage.ts";

function makeWikiDir(): string {
  return mkdtempSync(join(tmpdir(), "lineage-wiki-"));
}

test("appendLineage writes one JSONL line with a timestamp", () => {
  const wikiPath = makeWikiDir();
  try {
    appendLineage(wikiPath, { note: "sources/Foo.md", source: "moc-sync", writer: "moc-sync" });
    const lines = readFileSync(join(wikiPath, "lineage.jsonl"), "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.note, "sources/Foo.md");
    assert.equal(record.source, "moc-sync");
    assert.equal(record.writer, "moc-sync");
    assert.equal(typeof record.timestamp, "string");
    assert.ok(!Number.isNaN(Date.parse(record.timestamp)));
  } finally {
    rmSync(wikiPath, { recursive: true, force: true });
  }
});

test("appendLineage appends without truncating prior entries", () => {
  const wikiPath = makeWikiDir();
  try {
    appendLineage(wikiPath, { note: "a.md", source: "link", writer: "link" });
    appendLineage(wikiPath, { note: "b.md", source: "link", writer: "link" });
    const lines = readFileSync(join(wikiPath, "lineage.jsonl"), "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).note, "a.md");
    assert.equal(JSON.parse(lines[1]).note, "b.md");
  } finally {
    rmSync(wikiPath, { recursive: true, force: true });
  }
});
