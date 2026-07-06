import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { join } from "path";

// Drive the real hook end-to-end: pipe a PreToolUse payload on stdin and read
// the decision back. The guard always exits 0 — a block is signalled by a
// `permissionDecision: "deny"` JSON on stdout; an allow is empty stdout.
const BIN = join(import.meta.dirname!, "..", "bin", "commonplace");
const OUTSIDE = "/tmp"; // cwd outside commonplace's own repo, so the repo exemption doesn't fire

function runGuard(toolInput: Record<string, unknown>, cwd = OUTSIDE): { denied: boolean; out: string } {
  const payload = JSON.stringify({ tool_name: "Agent", tool_input: toolInput, cwd });
  const out = execFileSync("node", [BIN, "agent-guard"], { input: payload, encoding: "utf-8" }).trim();
  return { denied: out.includes('"permissionDecision":"deny"'), out };
}

test("blocks a general-purpose agent whose prompt carries a vault signal", () => {
  const { denied } = runGuard({ subagent_type: "general-purpose", prompt: "Summarize what [[Alpha Method]] says" });
  assert.ok(denied, "expected a vault-shaped research dispatch to be denied");
});

test("ALLOW_VAULT_AGENT marker bypasses the guard (orchestrated work)", () => {
  const { denied, out } = runGuard({
    subagent_type: "general-purpose",
    prompt: "Compile a grounded definition for [[Alpha Method]] from [[Acme Report]]. ALLOW_VAULT_AGENT",
  });
  assert.equal(denied, false);
  assert.equal(out, "", "override should produce no output (allow)");
});

test("a registered (non-general-purpose) agent type is never gated", () => {
  const { denied } = runGuard({ subagent_type: "commonplace:wiki-linter", prompt: "Fix [[Alpha Method]] in .wiki/" });
  assert.equal(denied, false);
});

test("a prompt with no vault vocabulary passes through", () => {
  const { denied } = runGuard({ subagent_type: "general-purpose", prompt: "Refactor the auth middleware in src/server.ts" });
  assert.equal(denied, false);
});

test("dispatches from inside commonplace's own repo are exempt even with a signal", () => {
  const repoRoot = join(import.meta.dirname!, "..");
  const { denied } = runGuard(
    { subagent_type: "general-purpose", prompt: "Trace how [[wikilinks]] resolve in .wiki/" },
    repoRoot,
  );
  assert.equal(denied, false, "working on commonplace source is not a vault-content question");
});
