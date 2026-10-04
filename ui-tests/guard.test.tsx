/**
 * The first session after an install runs before `npm install` finishes, so
 * `commonplace vaults` fails. The guard must not go blind for that window:
 * it falls back to the default vault and still seals private folders.
 */
import { test, expect, mock } from "claude-code/testing";
import { serveVault, engineFloor, VAULT } from "./fixture.tsx";

const SEALED_NOTE = ["Research", "Gamma", "Gamma Orchard Ledger.md"].join("/");

for (const surface of ["terminal", "desktop"] as const) {
  test(`${surface}: a failed registry read still seals private folders`, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on, { registryDown: true });
    engineFloor(on);
    on("tool.call", { tool: "Read" }, async () => ({ result: "fixture: the file was read" }) as never);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });

    const listed = String(
      ((await $.tool.call({ tool: "mcp__commonplace__vault_list", tool_use_id: "toolu_g1", what: "domains" } as never)) as { result?: unknown }).result,
    );
    expect(listed).toMatch(/alpha/);
    expect(listed).not.toMatch(/gamma/);

    const r = await $.tool.call({ tool: "Read", tool_use_id: "toolu_g2", file_path: `${VAULT}/${SEALED_NOTE}` } as never);
    expect(JSON.stringify(r)).not.toMatch(/the file was read/);
  });
}
