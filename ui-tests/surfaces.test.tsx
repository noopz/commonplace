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

  test(`${surface}: with vault revision off, /vault revise says so and runs nothing`, { options: { vaultRevision: false } }, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    const out = String(((await $.command.run({ command: "vault", args: "revise" } as never)) as { text?: unknown }).text);
    expect(out).toMatch(/Vault revision is off/);
  });

  test(`${surface}: the explainer pane pages through its diagrams`, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on);
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    // No pane is placed under the kit, so the command answers with every page as text.
    const out = String(((await $.command.run({ command: "vault", args: "explain" } as never)) as { text?: unknown }).text);
    expect(out).toMatch(/# How vault revision works/);
    expect(out).toMatch(/5\. This vault/);
    const ui = await $.ui.mount({ plugin: "commonplace", surface, component: "Pane", requestId: "commonplace-explain", props: { title: "x", isFocused: true, bodyColumns: 100, placement: "dock" } as never });
    expect((await ui.find({ text: /^1 \/ 5 · What revision does/ }))?.text).toBeTruthy();
    await ui.press({ key: "cp-explain-next" });
    expect((await ui.find({ text: /^2 \/ 5 · How a change is checked/ }))?.text).toBeTruthy();
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
    const opened: string[] = [];
    on("ui.open", async (_$, e) => {
      opened.push(String((e as { id: string }).id));
      return { value: { isPlaced: true } } as never;
    });
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
    // The notice's text is a press too: it opens what Details opens.
    opened.length = 0;
    await band.press({ key: "cp-notice-text" } as never);
    expect(opened).toEqual(["commonplace-activity"]);
  });

  const QUARANTINED = {
    "Acme Robot/README.md": "# Acme Robot\n\nA hobby arm.\n",
    "Acme Robot/docs/Wiring.md": "# Wiring\n\nServo leads.\n",
    "Marble Notes/One.md": "# One\n\nA loose thought.\n",
  };

  test(`${surface}: /vault domain lists the quarantined folders, and Details opens the activity log`, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    serveVault(on, { quarantined: QUARANTINED });
    engineFloor(on);
    const opened: string[] = [];
    on("ui.open", async (_$, e) => {
      opened.push(String((e as { id: string }).id));
      return { value: { isPlaced: true } } as never;
    });
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    await $.tool.call({ tool: "mcp__commonplace__vault_list", tool_use_id: "toolu_q0", what: "domains" } as never);
    const band = await $.ui.mount({ plugin: "commonplace", surface, component: "AbovePrompt", props: { hasSurvey: false } as never });
    expect((await band.find({ text: /quarantined/ }))?.text).toMatch(/3 notes in new folders/);
    const out = String(((await $.command.run({ command: "vault", args: "domain" } as never)) as { text?: unknown }).text);
    expect(out).toMatch(/Acme Robot · 2 notes/);
    expect(out).toMatch(/Marble Notes · 1 note/);
    opened.length = 0;
    await band.press({ key: "cp-notice-text" } as never);
    expect(opened).toEqual(["commonplace-activity"]);
  });

  test(`${surface}: /vault domain takes a quarantined folder, and the notice goes once none is left`, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    const v = serveVault(on, { quarantined: QUARANTINED });
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    await $.tool.call({ tool: "mcp__commonplace__vault_list", tool_use_id: "toolu_q1", what: "domains" } as never);
    const band = await $.ui.mount({ plugin: "commonplace", surface, component: "AbovePrompt", props: { hasSurvey: false } as never });
    expect((await band.find({ text: /quarantined/ }))?.text).toBeTruthy();
    const out = String(((await $.command.run({ command: "vault", args: "domain public Acme Robot" } as never)) as { text?: unknown }).text);
    expect(out).toMatch(/public domain "acme-robot"/);
    // One folder still waits: the notice stays.
    expect((await band.find({ text: /quarantined/ }))?.text).toBeTruthy();
    await $.command.run({ command: "vault", args: "domain private Marble Notes" } as never);
    expect(await band.find({ text: /quarantined/ })).toBeFalsy();
    expect(JSON.parse(v.file("/fixture/acme-vault/.wiki/domains.json")!).domains["marble-notes"]).toEqual({ path: "Marble Notes", scope: "private" });
  });

  test(`${surface}: accepts waiting on uncommitted notes raise a notice whose button commits them`, async ($, on) => {
    mock.store(on);
    mock.clock(on, { now: 1_000_000 });
    const calls: string[] = [];
    let committed = false;
    serveVault(on, {
      revise: (sub) => {
        calls.push(sub);
        if (sub === "ensure") return { ok: true, enabled: [], work: 0, jobs: 0 };
        if (sub === "job-next") return {};
        if (sub === "next") return { none: true };
        if (sub === "waiting") return committed ? { rels: [], proposals: 0 } : { rels: ["Research/Alpha/Marble Queue Sharding.md"], proposals: 2 };
        if (sub === "commit-waiting") {
          committed = true;
          return { status: "committed", commit: "0123456789abcdef", paths: ["Research/Alpha/Marble Queue Sharding.md"], notes: 1, proposals: 2 };
        }
        return undefined;
      },
    });
    engineFloor(on);
    await $.session.start({ cwd: "/fixture/project", surface, isInteractive: true });
    await $.prompt.submit({ text: "hello", origin: { kind: "composer" } } as never);
    await $.turn.start({ turnId: "turn-w", text: "hello" } as never);
    const band = await $.ui.mount({ plugin: "commonplace", surface, component: "AbovePrompt", props: { hasSurvey: false } as never });
    for (let i = 0; i < 50 && !(await band.find({ text: /haven't committed/ })); i++);
    expect((await band.find({ text: /haven't committed/ }))?.text).toMatch(/2 revisions wait on 1 note/);
    await band.press({ key: "cp-notice-act" } as never);
    for (let i = 0; i < 50 && !(await band.find({ text: /committed the notes/ })); i++);
    expect(calls).toContain("commit-waiting");
    expect((await band.find({ text: /committed the notes/ }))?.text).toBeTruthy();
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
