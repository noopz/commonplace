import { test } from "node:test";
import assert from "node:assert/strict";
import { linesAfter } from "./hook-log.ts";

test("lines are picked by timestamp, so a log trimmed mid-run still yields the session's lines", () => {
  const before = '{"at":"2026-01-01T00:00:00.000Z","stage":"prime:sync","decision":"candidate"}\n';
  const trimmed = 'garbage\n{"stage":"no-at"}\n{"at":"2026-01-01T00:00:05.000Z","stage":"prime:sync","decision":"skip-weak"}\n';
  const since = "2026-01-01T00:00:01.000Z";
  assert.deepEqual(linesAfter(before + trimmed, since).map((l) => l.decision), ["skip-weak"]);
  assert.deepEqual(linesAfter(trimmed, since).map((l) => l.decision), ["skip-weak"], "shorter than before, still found");
});
