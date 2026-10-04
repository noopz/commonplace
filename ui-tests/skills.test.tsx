/**
 * Vault skills live in the vault's own `.claude/skills/`. A session started
 * elsewhere is asked, in the AskUserQuestion dialog, whether to trust a skill
 * it discovers; the answer is pinned to that exact content.
 */
import { test, expect, mock } from "claude-code/testing";
import { serveVault, engineFloor } from "./fixture.tsx";

const SKILL = "---\nname: acme-intake\ndescription: Turn an Acme clip into a source note\n---\nRun the intake.\n";
const SKILLS = { ".claude/skills/acme-intake/SKILL.md": SKILL };

for (const surface of ["terminal", "desktop"] as const) {
  for (const [cwd, expected] of [["/fixture/project", 1], ["/fixture/acme-vault", 0]] as const) {
    test(`${surface}: a session started in ${cwd} is asked about new skills ${expected ? "once" : "never"}`, async ($, on) => {
      mock.store(on);
      const clock = mock.clock(on, { now: 1_000_000 });
      serveVault(on, { skills: SKILLS });
      engineFloor(on, cwd);
      const asked: string[] = [];
      on("tool.call", { tool: "AskUserQuestion" }, async (_$, e) => {
        const q = (e as unknown as { questions: Array<{ question: string }> }).questions[0].question;
        asked.push(q);
        return { result: { questions: (e as unknown as { questions: unknown[] }).questions, answers: { [q]: "Trust" } } } as never;
      });
      await $.session.start({ cwd, surface, isInteractive: true });
      await clock.advance(3000);
      expect(asked).toHaveLength(expected);
    });
  }

  for (const [answer, delivered] of [["Trust", true], ["Not now", false]] as const) {
    test(`${surface}: calling an untrusted vault skill asks first ("${answer}")`, async ($, on) => {
      mock.store(on);
      mock.clock(on, { now: 1_000_000 });
      serveVault(on, { skills: SKILLS });
      engineFloor(on);
      const asked: string[] = [];
      on("tool.call", { tool: "AskUserQuestion" }, async (_$, e) => {
        const q = (e as unknown as { questions: Array<{ question: string }> }).questions[0].question;
        asked.push(q);
        return { result: { questions: (e as unknown as { questions: unknown[] }).questions, answers: { [q]: answer } } } as never;
      });
      await $.session.start({ cwd: "/fixture/project", surface, isInteractive: false });

      const call = async (id: string) =>
        String(((await $.tool.call({ tool: "mcp__commonplace__vault_skill", tool_use_id: id, name: "acme-intake" } as never)) as { result?: unknown }).result);
      const first = await call("toolu_s1");
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(/acme-intake/);
      expect(asked[0]).toMatch(/\.claude\/skills\/acme-intake\/SKILL\.md/);
      if (delivered) {
        expect(first).toMatch(/<vault-skill name="acme-intake"/);
        expect(first).toMatch(/Run the intake\./);
        // Pinned: the second call does not ask again.
        expect(await call("toolu_s2")).toMatch(/Run the intake\./);
        expect(asked).toHaveLength(1);
      } else {
        expect(first).toMatch(/not trusted/);
        expect(first).not.toMatch(/Run the intake\./);
        // "Not now" holds for the session: no second question.
        await call("toolu_s2");
        expect(asked).toHaveLength(1);
      }
    });
  }
}
