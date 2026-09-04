/**
 * Tests for the shell-hook / in-process-module double-fire gate.
 *
 * FIXTURES ARE INVENTED. Per CLAUDE.md: this repo is public, so no path, note
 * title or session id below comes from a real vault or a real session.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { moduleIsLive, MODULE_MARKER } from "./lib/module-gate.ts";

function fakeVault(marker?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-gate-"));
  mkdirSync(join(dir, ".wiki"), { recursive: true });
  if (marker) {
    writeFileSync(join(dir, ".wiki", MODULE_MARKER), JSON.stringify(marker));
  }
  return dir;
}

function withoutEnv<T>(fn: () => T): T {
  const prev = process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
  delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
  try {
    return fn();
  } finally {
    if (prev !== undefined) process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = prev;
  }
}

test("the env var alone still means the module is live", () => {
  const prev = process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
  process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = "1";
  try {
    assert.equal(moduleIsLive(undefined, undefined), true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
    else process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = prev;
  }
});

test("a marker matching this session means the module is live", () => {
  // The case the env-var check missed entirely: the flag-based rollout, where
  // the module loads with nothing set in the environment.
  withoutEnv(() => {
    const vault = fakeVault({ sessionId: "session-alpha", at: "2020-01-01T00:00:00Z" });
    try {
      assert.equal(moduleIsLive("session-alpha", vault), true);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

test("a marker from a previous session does not match", () => {
  // Why ids and not timestamps: there is no staleness window to tune.
  withoutEnv(() => {
    const vault = fakeVault({ sessionId: "session-old" });
    try {
      assert.equal(moduleIsLive("session-new", vault), false);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

test("it fails OPEN on anything unreadable", () => {
  // For the large majority of users no marker exists and the shell hooks ARE
  // the plugin. Treating an unreadable marker as "module is live" would
  // silently disable them.
  withoutEnv(() => {
    const empty = fakeVault();
    const broken = fakeVault();
    writeFileSync(join(broken, ".wiki", MODULE_MARKER), "not json");
    try {
      assert.equal(moduleIsLive("session-alpha", empty), false, "no marker");
      assert.equal(moduleIsLive("session-alpha", broken), false, "unparseable marker");
      assert.equal(moduleIsLive("session-alpha", "/nope/does/not/exist"), false);
      assert.equal(moduleIsLive(undefined, empty), false, "no session id on the payload");
      assert.equal(moduleIsLive("session-alpha", undefined), false, "no vault");
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

test("the module writes the same marker filename this gate reads", () => {
  // The constant is duplicated in hooks/register.ts because the hooks sandbox
  // cannot import from scripts/. A rename on one side would silently un-gate
  // every shell hook, so assert the two literals agree by reading the source.
  const src = readFileSync(new URL("../hooks/register.ts", import.meta.url), "utf-8");
  const declared = /const MODULE_MARKER = "([^"]+)"/.exec(src)?.[1];
  assert.equal(declared, MODULE_MARKER);
  assert.ok(
    src.includes("`${vp}/.wiki/${MODULE_MARKER}`"),
    "register.ts must write the marker under the vault's .wiki/",
  );
});
