/**
 * A vault with no v2 index yet: the first vault tool call starts the build
 * and waits for it, answering normally instead of "retry in a moment".
 */
import { test, expect, mock } from "claude-code/testing";
import { serveVault, engineFloor } from "./fixture.tsx";

for (const surface of ["terminal", "desktop"] as const) {
  test(`${surface}: the first vault call waits for the first build`, async ($, on) => {
    mock.store(on);
    const clock = mock.clock(on, { now: 1_000_000 });
    const vault = serveVault(on, { unbuilt: true, buildDelay: () => clock.sleep(400) });
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });

    const pending = $.tool.call({ tool: "mcp__commonplace__vault_links", tool_use_id: "toolu_b1", note: "Kestrel Calibration Protocol" } as never);
    await clock.advance(400); // the build finishes while the call is waiting
    const r = await pending;
    const text = String((r as { result?: unknown }).result);
    expect(text).not.toMatch(/ERROR/);
    expect(text).toMatch(/Marble Queue Sharding/);
    expect(vault.builds()).toBe(1);
  });
}
