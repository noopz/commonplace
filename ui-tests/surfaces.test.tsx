/**
 * The reply surfaces on an invented vault: [[links]] drawn as links with
 * citation flags, and the witness. Driven
 * through real vault tool calls, then a reply drawn through the module.
 */
import { test, expect, mock } from "claude-code/testing";
import { serveVault, engineFloor } from "./fixture.tsx";

const SURFACES = ["terminal", "desktop"] as const;
const REPLY =
  "Per [[Kestrel Calibration Protocol]] and [[Marble Queue Sharding|the sharding note]]; " +
  "see also [[Nowhere Note]] and [[Gamma Orchard Ledger]]. `[[Kestrel Calibration Protocol]]` in code stays.";

const reply = (text: string, requestId = "msg_fixture_1") =>
  ({ component: "AssistantMessage", requestId, props: { text, isFirstOfReply: true } as never }) as const;

for (const surface of SURFACES) {
  test(`${surface}: a reply's [[links]] resolve, and the footer checks each citation`, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    await $.tool.call({ tool: "mcp__commonplace__vault_note", tool_use_id: "toolu_s1", note: "Kestrel Calibration Protocol" } as never);

    const ui = await $.ui.mount({ plugin: "commonplace", surface, ...reply(REPLY) });
    const text = String((await ui.find({ text: /Per / }))?.text);
    expect(text).toContain("[Kestrel Calibration Protocol](file:///fixture/acme-vault/Research/Alpha/Kestrel%20Calibration%20Protocol.md)");
    expect(text).toContain("[the sharding note](file:///fixture/acme-vault/Research/Alpha/Marble%20Queue%20Sharding.md)");
    expect(text).toContain("`[[Kestrel Calibration Protocol]]` in code stays");
    expect(text).toMatch(/⚠ \[the sharding note\]|⚠ \[Marble Queue Sharding\]\(file:[^)]*\) · cited without being read this session/);
    // Read this session, not superseded: no line for it.
    expect(text).not.toMatch(/⚠ \[Kestrel Calibration Protocol\]/);
    expect(text).toContain("✗ [[Nowhere Note]] is not a note in your vault");
    // A sealed title is left exactly as written and never flagged or linked.
    expect(text).toContain("[[Gamma Orchard Ledger]]");
    expect(text).not.toMatch(/Gamma Orchard Ledger\]\] is not/);
    expect(text).not.toMatch(/Gamma%20Orchard/);
  });

  test(`${surface}: with vault links off a reply is drawn as written`, { options: { vaultLinks: false } }, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    await $.tool.call({ tool: "mcp__commonplace__vault_note", tool_use_id: "toolu_s2", note: "Kestrel Calibration Protocol" } as never);
    const ui = await $.ui.mount({ plugin: "commonplace", surface, ...reply(REPLY, "msg_fixture_2") });
    expect((await ui.find({ text: /Per / }))?.text).toBe(REPLY);
  });

  test(`${surface}: the witness records a note a vault tool attached to its result`, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    await $.tool.call({ tool: "mcp__commonplace__vault_note", tool_use_id: "toolu_s4", note: "Kestrel Calibration Protocol" } as never);
    // No pane is placed under the kit, so the command answers with the record itself.
    const out = String(((await $.command.run({ command: "vault", args: "witness" } as never)) as { text?: unknown }).text);
    expect(out).toMatch(/hidden addition/);
    expect(out).toMatch(/vault_note note/);
  });
}

for (const surface of SURFACES) {
  test(`${surface}: a pasted link ends its turn with a triage card, and Later keeps it`, { options: { linkTriage: true } }, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    // The fetch itself, answered beneath the plugin as core would.
    on("tool.call", { tool: "WebFetch" }, async (_$, e) => ({ result: { code: 200, codeText: "OK", bytes: 10, result: "a drift study", durationMs: 1, url: (e as { url: string }).url } }) as never);
    const forks: string[] = [];
    on("model.fork", async (_$, e) => {
      forks.push(String((e as { prompt: string }).prompt));
      return { value: { isAnswered: true, text: '{"verdict":"extends","note":"Kestrel Calibration Protocol","why":"adds a field drift study"}' } } as never;
    });
    const opened: string[] = [];
    on("ui.open", async (_$, e) => {
      opened.push(String((e as { id: string }).id));
      return { value: { isPlaced: true } } as never;
    });
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    // Loads the index, as any session that has used the vault has.
    await $.tool.call({ tool: "mcp__commonplace__vault_list", tool_use_id: "toolu_t0", what: "domains" } as never);

    await $.prompt.submit({ text: "What does this add? https://acme.example/kestrel-drift", origin: { kind: "composer" } } as never);
    await $.turn.start({ turnId: "turn-1", text: "What does this add? https://acme.example/kestrel-drift" } as never);
    await $.tool.call({ tool: "WebFetch", tool_use_id: "toolu_f1", url: "https://www.acme.example/kestrel-drift/", prompt: "summarize" } as never);
    await $.turn.complete({ turnId: "turn-1", answer: "It reports a field study of kestrel sensor drift and calibration budgets.", reason: "answer", isAborted: false, durationMs: 10 } as never);

    expect(forks).toHaveLength(1);
    // The candidates were read before the fork judged them.
    expect(forks[0]).toMatch(/NOTE 1: "Kestrel Calibration Protocol"/);
    expect(forks[0]).toMatch(/Builds on \[\[Marble Queue Sharding\]\]/);

    const band = await $.ui.mount({ plugin: "commonplace", surface, component: "AbovePrompt", props: { hasSurvey: false } as never });
    expect((await band.find({ text: /vault ·/ }))?.text).toMatch(/acme\.example · extends \[\[Kestrel Calibration Protocol\]\] — adds a field drift study/);
    await band.press({ key: "cp-triage-later" } as never);
    const later = String(((await $.command.run({ command: "vault", args: "later" } as never)) as { text?: unknown }).text);
    expect(later).toMatch(/https:\/\/acme\.example\/kestrel-drift/);
    expect(later).toMatch(/extends \[\[Kestrel Calibration Protocol\]\]/);

    // The press leaves a notice, not a toast: Details opens the activity pane.
    expect((await band.find({ text: /vault ·/ }))?.text).toMatch(/saved for later/);
    await band.press({ key: "cp-notice-details" } as never);
    expect(opened).toEqual(["commonplace-activity"]);
    const pane = await $.ui.mount({ plugin: "commonplace", surface, component: "Pane", requestId: "commonplace-activity", props: {} as never });
    expect(JSON.stringify(await pane.drawn())).toMatch(/acme\.example\/kestrel-drift saved/);
  });

  test(`${surface}: a notice raised under a waiting card shows once the person types again`, { options: { linkTriage: true } }, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    on("tool.call", { tool: "WebFetch" }, async (_$, e) => ({ result: { code: 200, codeText: "OK", bytes: 10, result: "a drift study", durationMs: 1, url: (e as { url: string }).url } }) as never);
    on("model.fork", async () => ({ value: { isAnswered: true, text: '{"verdict":"new","why":"a new field study"}' } }) as never);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    await $.tool.call({ tool: "mcp__commonplace__vault_list", tool_use_id: "toolu_t0", what: "domains" } as never);
    await $.prompt.submit({ text: "What does this add? https://acme.example/kestrel-drift", origin: { kind: "composer" } } as never);
    await $.turn.start({ turnId: "turn-3", text: "What does this add? https://acme.example/kestrel-drift" } as never);
    await $.tool.call({ tool: "WebFetch", tool_use_id: "toolu_f3", url: "https://acme.example/kestrel-drift", prompt: "summarize" } as never);
    await $.turn.complete({ turnId: "turn-3", answer: "It reports a field study of kestrel sensor drift and calibration budgets.", reason: "answer", isAborted: false, durationMs: 10 } as never);
    const band = await $.ui.mount({ plugin: "commonplace", surface, component: "AbovePrompt", props: { hasSurvey: false } as never });
    expect((await band.find({ text: /vault ·/ }))?.text).toMatch(/acme\.example/);

    await $.command.run({ command: "vault", args: "reindex" } as never);
    for (let i = 0; i < 20 && !/refreshed/.test(String(((await $.command.run({ command: "vault", args: "activity" } as never)) as { text?: unknown }).text)); i++);
    // The card waiting on a press stays up; the notice is held, not dropped.
    expect((await band.find({ text: /vault ·/ }))?.text).toMatch(/acme\.example/);
    await $.prompt.submit({ text: "thanks", origin: { kind: "composer" } } as never);
    expect((await band.find({ text: /vault ·/ }))?.text).toMatch(/vault index refreshed/);
  });

  test(`${surface}: a pasted link nobody fetched is never triaged`, { options: { linkTriage: true } }, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    let forks = 0;
    on("model.fork", async () => {
      forks++;
      return { value: { isAnswered: true, text: "{}" } } as never;
    });
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    await $.prompt.submit({ text: "why does https://acme.example/status say degraded", origin: { kind: "composer" } } as never);
    await $.turn.start({ turnId: "turn-2", text: "why does https://acme.example/status say degraded" } as never);
    await $.turn.complete({ turnId: "turn-2", answer: "It reports a degraded queue.", reason: "answer", isAborted: false, durationMs: 10 } as never);
    expect(forks).toBe(0);
  });
}

for (const surface of SURFACES) {
  test(`${surface}: /vault list names the registered vault`, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    const out = String(((await $.command.run({ command: "vault", args: "list" } as never)) as { text?: unknown }).text);
    expect(out).toMatch(/● acme {2}\/fixture\/acme-vault/);
  });
}
