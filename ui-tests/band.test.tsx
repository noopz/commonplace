/**
 * The module's three drawings, on every surface it claims (plan §9): the
 * status band above the prompt, the vault tool's transcript row, and the
 * spinner text while a vault tool runs. Driven through the engine — a real
 * vault tool call against an invented vault — not by poking module state.
 */
import { test, expect, mock } from "claude-code/testing";
import { serveVault, engineFloor } from "./fixture.tsx";

const SURFACES = ["terminal", "desktop"] as const;
const LINKS = "mcp__commonplace__vault_links";

for (const surface of SURFACES) {
  test(`${surface}: an idle band adds nothing above the prompt`, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    const ui = await $.ui.mount({ plugin: "commonplace", surface, component: "AbovePrompt", props: { hasSurvey: false } as never });
    expect(await ui.find({ text: /vault ·/ })).toBeUndefined();
  });

  test(`${surface}: a vault_links call draws its own row and raises the band`, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });

    const r = await $.tool.call({ tool: LINKS, tool_use_id: "toolu_fixture_1", note: "Kestrel Calibration Protocol", direction: "both" } as never);
    const text = String((r as { result?: unknown }).result ?? JSON.stringify(r));
    expect(text).toMatch(/Marble Queue Sharding/);
    expect(text).not.toMatch(/Gamma Orchard Ledger/);

    const row = await $.ui.mount({
      plugin: "commonplace",
      surface,
      component: "ToolUse",
      requestId: "toolu_fixture_1",
      props: { tool_use_id: "toolu_fixture_1", tool: LINKS, isRunning: false, isErrored: false, isInterrupted: false } as never,
    });
    expect((await row.find({ text: /vault_links/ }))?.text).toMatch(/⟡ vault_links/);
    expect(await row.find({ text: /\[\[Kestrel Calibration Protocol\]\] · \d+ links · \d+ ms/ })).toBeDefined();

    const band = await $.ui.mount({ plugin: "commonplace", surface, component: "AbovePrompt", props: { hasSurvey: false } as never });
    expect((await band.find({ text: /vault ·/ }))?.text).toMatch(/^⟡ vault · following links of \[\[Kestrel Calibration Protocol\]\]/);
  });

  test(`${surface}: the spinner says "Reading the vault" only while a vault tool runs`, async ($, on) => {
    mock.store(on);
    const clock = mock.clock(on, { now: 1_000_000 });
    const { release } = serveVault(on, { hold: "Research/Alpha/Marble Queue Sharding.md" });
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    const props = { word: "Pondering", message: null } as never;

    const idle = await $.ui.mount({ plugin: "commonplace", surface, component: "Spinner", props });
    expect(await idle.find({ text: "Pondering" })).toBeDefined();

    const pending = $.tool.call({ tool: "mcp__commonplace__vault_note", tool_use_id: "toolu_fixture_2", note: "Marble Queue Sharding" } as never);
    await clock.settle();
    const busy = await $.ui.mount({ plugin: "commonplace", surface, component: "Spinner", props });
    expect(await busy.find({ text: "Reading the vault" })).toBeDefined();

    release();
    const r = await pending;
    expect(String((r as { result?: unknown }).result)).toMatch(/Marble Queue Sharding/);
    const after = await $.ui.mount({ plugin: "commonplace", surface, component: "Spinner", props });
    expect(await after.find({ text: "Pondering" })).toBeDefined();
  });

  test(`${surface}: /vault open raises the scope band and unseals the private domain`, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    const inLinks = async (id: string) =>
      String(((await $.tool.call({ tool: LINKS, tool_use_id: id, note: "Drift Budget", direction: "in" } as never)) as { result?: unknown }).result);

    const sealed = await inLinks("toolu_fixture_3");
    expect(sealed).toMatch(/Kestrel Calibration Protocol/);
    expect(sealed).not.toMatch(/Gamma Orchard Ledger/);

    const opened = await $.command.run({ command: "vault", args: "open gamma" } as never);
    expect(String((opened as { text?: unknown }).text)).toMatch(/^Opened gamma/);
    const band = await $.ui.mount({ plugin: "commonplace", surface, component: "AbovePrompt", props: { hasSurvey: false } as never });
    const line = await band.find({ text: /vault ·/ });
    expect(line?.text).toMatch(/^🔒 vault · open: gamma/);

    expect(await inLinks("toolu_fixture_4")).toMatch(/Gamma Orchard Ledger/);
  });
}
