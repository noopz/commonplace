import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkill, visibleSkills, skillBlock, sha256Hex, type SkillFile } from "./load.ts";

const file = async (dir: string, text: string): Promise<SkillFile> => ({ dir, text, hash: await sha256Hex(text) });

test("parses a well-formed skill; refuses bad names and mismatched frontmatter names", async () => {
  const ok = parseSkill(await file("alpha-review", "---\nname: alpha-review\ndescription: Review an alpha draft\n---\nDo the review.\n"));
  assert.equal(ok?.description, "Review an alpha draft");
  assert.equal(parseSkill(await file("Bad Name", "---\ndescription: x\n---\n")), null);
  assert.equal(parseSkill(await file("alpha", "---\nname: beta\ndescription: x\n---\n")), null);
  assert.equal(parseSkill(await file("alpha", "---\nname: alpha\n---\nno description")), null);
});

test("trust is by exact content hash; an edit untrusts and flags 'changed'", async () => {
  const v1 = await file("alpha", "---\nname: alpha\ndescription: d\n---\nv1\n");
  const v2 = await file("alpha", "---\nname: alpha\ndescription: d\n---\nv2\n");
  assert.equal(visibleSkills([v1], { alpha: v1.hash }, () => true, [])[0].trusted, true);
  const edited = visibleSkills([v2], { alpha: v1.hash }, () => true, [])[0];
  assert.equal(edited.trusted, false);
  assert.equal(edited.changed, true);
  assert.equal(visibleSkills([v2], {}, () => true, [])[0].changed, false);
});

test("domain-scoped skills appear only while the domain is visible; undomained ones naming a sealed title are hidden", async () => {
  const scoped = await file("gamma-notes", "---\nname: gamma-notes\ndescription: d\ndomain: gamma\n---\nbody\n");
  const leaky = await file("leaky", "---\nname: leaky\ndescription: d\n---\nAlways cite [[Gamma Secret Term]].\n");
  assert.deepEqual(visibleSkills([scoped, leaky], {}, (d) => d !== "gamma", ["Gamma Secret Term"]).map((s) => s.name), []);
  assert.deepEqual(visibleSkills([scoped, leaky], {}, () => true, []).map((s) => s.name), ["gamma-notes", "leaky"]);
});

test("skill block wraps the body with provenance", async () => {
  const f = await file("alpha", "---\nname: alpha\ndescription: d\n---\nStep one.\n");
  const [s] = visibleSkills([f], { alpha: f.hash }, () => true, []);
  const block = skillBlock(s, "alpha-vault", "the draft");
  assert.match(block, /^<vault-skill name="alpha" vault="alpha-vault" trusted="true">/);
  assert.match(block, /Arguments: the draft/);
  assert.match(block, /Step one\./);
});
