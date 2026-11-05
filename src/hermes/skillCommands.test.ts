// Skills run from the composer: which skills are offered, what a message that names them sends to Hermes, and how the
// chat shows it. Request and answer shapes are read from Hermes's source at the deployed `f0d9488`.
import { describe, expect, it } from "vitest";
import golden from "./skillInvocationGolden.json";
import { listServerCommands } from "./commands";
import { RpcError } from "./transport";
import {
  callText,
  catalogSkills,
  dollarQuery,
  matchSkills,
  offeredSkills,
  runSkill,
  skillInvocationText,
  skillRun,
  skillSlug,
  type SkillCommands,
} from "./skillCommands";
import type { SkillsView } from "./skills";

const view = (skills: { name: string; enabled?: boolean }[], offFor: Record<string, string[]> = {}, platformsRead = true): SkillsView => ({
  profile: "default",
  skills: skills.map((s) => ({ name: s.name, description: `${s.name} skill`, enabled: s.enabled ?? true, source: "agent", scope: "profile" })),
  offFor,
  platformsRead,
  readAt: 0,
});

const skills = (...keys: string[]): SkillCommands => ({
  offered: keys.map((key) => ({ key, name: key, description: `The ${key} skill` })),
  listed: new Set([...keys, "secret"]),
});

describe("A skill's command name", () => {
  it("is its name as Hermes makes it a command", () => {
    expect(skillSlug("Code Review")).toBe("code-review");
    expect(skillSlug("git_helper")).toBe("git-helper");
    expect(skillSlug("a + b")).toBe("a-b");
    expect(skillSlug("writing/one")).toBe("writingone");
    expect(skillSlug("--x--")).toBe("x");
    expect(skillSlug("小说拆条")).toBe("小说拆条");
  });
});

describe("The skills Hermes lists", () => {
  const res = {
    pairs: [["/steer", "Steer"], ["/debugging", "Find the cause first"], ["/deploy", "exec: ./deploy.sh"], ["/writing", "Write plainly"]],
    skills: { "/debugging": { usage: 2, origin: "local" }, "/deploy": { usage: 0, origin: "local" }, "/writing": { usage: 0, origin: "bundled" } },
  };

  it("are the catalog's, less those a quick or plugin command takes", () => {
    expect([...catalogSkills(res, new Set(["/deploy"]), false)!]).toEqual([
      ["debugging", "Find the cause first"],
      ["writing", "Write plainly"],
    ]);
  });

  it("are none when Hermes lists no skills, or a discovery failed", () => {
    expect(catalogSkills({ pairs: res.pairs }, new Set(), false)).toBeUndefined();
    expect(catalogSkills(res, new Set(), true)).toBeUndefined();
  });

  it("come with the registry's server commands from one catalog read", async () => {
    const list = await listServerCommands(
      async () => ({ ...res, canon: { "/steer": "/steer" }, categories: [{ name: "User commands", pairs: [["/deploy", "exec: ./deploy.sh"]] }] }),
      "default",
    );
    expect([...list.skills!.keys()]).toEqual(["debugging", "writing"]);
    const failed = await listServerCommands(async () => ({ ...res, canon: {}, warning: "quick_commands discovery unavailable: bad yaml" }), "default");
    expect(failed.skills).toBeUndefined();
  });
});

describe("The skills offered", () => {
  const catalog = new Map([
    ["debugging", "Find the cause first"],
    ["writing", ""],
    ["release-notes", "Notes"],
    ["git-helper", "Git"],
    ["plugin:tool", "A plugin's skill"],
  ]);

  it("are the catalog's that are on for the profile and for this app's chats", () => {
    const got = offeredSkills(
      catalog,
      view([{ name: "debugging" }, { name: "writing" }, { name: "release_notes", enabled: false }, { name: "git_helper" }, { name: "git-helper" }], { "git-helper": ["tui"] }),
    )!;
    // A description Hermes gives none of falls back to Settings → Skills'. A plugin's skill isn't in that list, so isn't offered.
    expect(got.offered).toEqual([
      { key: "debugging", name: "debugging", description: "Find the cause first" },
      { key: "writing", name: "writing", description: "writing skill" },
    ]);
    // Every catalog key is known, so text that would load one that's off can be told apart.
    expect([...got.listed]).toEqual([...catalog.keys()]);
  });

  it("are none known when the per-platform lists couldn't be read", () => {
    expect(offeredSkills(catalog, view([{ name: "debugging" }], {}, false))).toBeUndefined();
  });
});

describe("The skill menu", () => {
  it("opens on a $ at the start or after a space, at the caret", () => {
    expect(dollarQuery("$")).toEqual({ query: "", start: 0 });
    expect(dollarQuery("fix the build using $Deb")).toEqual({ query: "deb", start: 20 });
    expect(dollarQuery("line one\n$wr")).toEqual({ query: "wr", start: 9 });
    expect(dollarQuery("costs US$5")).toBeUndefined();
    expect(dollarQuery("$debugging ")).toBeUndefined();
  });

  it("ranks skills as the command menu ranks commands", () => {
    const list = skills("debugging", "writing", "release-notes").offered;
    expect(matchSkills("", list).map((s) => s.key)).toEqual(["debugging", "writing", "release-notes"]);
    expect(matchSkills("re", list).map((s) => s.key)).toEqual(["release-notes"]);
    expect(matchSkills("ing", list).map((s) => s.key)).toEqual(["debugging", "writing"]);
    expect(matchSkills("the", list).map((s) => s.key)).toEqual(["debugging", "writing", "release-notes"]);
  });
});

describe("A message that runs skills", () => {
  const s = skills("debugging", "writing", "rename", "a", "b", "c", "d", "e");

  it("starts with a skill's /name, the rest its words", () => {
    expect(skillRun("/debugging fix the build\nnow", s)).toEqual({
      keys: ["debugging"],
      instruction: "fix the build\nnow",
      call: { name: "debugging", arg: "fix the build\nnow" },
    });
    expect(skillRun("/Debugging", s)?.call).toEqual({ name: "debugging", arg: "" });
  });

  it("names skills with $ anywhere, each once, after any leading one", () => {
    expect(skillRun("fix the build using $debugging.", s)).toEqual({
      keys: ["debugging"],
      instruction: "fix the build using $debugging.",
      call: { name: "debugging", arg: "fix the build using $debugging." },
    });
    expect(skillRun("$writing and $debugging, then $writing", s)?.call).toEqual({ name: "writing", arg: "/debugging $writing and $debugging, then $writing" });
    expect(skillRun("/debugging write it up with $writing", s)?.call).toEqual({ name: "debugging", arg: "/writing write it up with $writing" });
  });

  it("stacks leading /names as Hermes does", () => {
    expect(skillRun("/debugging /writing /debugging fix it", s)).toMatchObject({ keys: ["debugging", "writing"], instruction: "fix it" });
    expect(skillRun("/debugging /usr/bin is full", s)).toMatchObject({ keys: ["debugging"], instruction: "/usr/bin is full" });
  });

  it("is an ordinary message without an offered skill", () => {
    expect(skillRun("costs $5 and $HOME is set", s)).toBeUndefined();
    expect(skillRun("$Debugging", s)).toBeUndefined();
    expect(skillRun("use$debugging", s)).toBeUndefined();
    expect(skillRun("/deploy now", s)).toBeUndefined();
    expect(skillRun("$secret please", s)).toBeUndefined();
    // In code, a $ word is code.
    expect(skillRun("run `echo $debugging` and\n```\n$writing\n```", s)).toBeUndefined();
  });

  it("leaves a /name this app has as a command to the command", () => {
    expect(skillRun("/rename Backups", s)).toBeUndefined();
    expect(skillRun("$rename the files", s)?.call).toEqual({ name: "rename", arg: "$rename the files" });
  });

  it("says why it can't go when Hermes would load a skill that's off here, or too many", () => {
    expect(skillRun("/debugging /secret now", s)?.problem).toMatch(/secret skill.*off for this app's chats/);
    expect(skillRun("/secret with $debugging", s)?.problem).toMatch(/load the secret skill too/);
    expect(skillRun("$a $b $c $d $e $debugging", s)?.problem).toMatch(/at most 5 skills.*names 6/);
    expect(skillRun("$a $b $c $d $e", s)?.problem).toBeUndefined();
  });

  it("shows as Hermes will show it until Hermes says", () => {
    expect(callText({ name: "debugging", arg: "/writing fix  the\nbuild" })).toBe("/debugging /writing fix the build");
  });
});

describe("What the chat shows for a stored skill message", () => {
  it("is what Hermes's describe_skill_invocation makes of it", () => {
    for (const { content, shown } of golden) expect(skillInvocationText(content)).toBe(shown ?? undefined);
  });
});

describe("Running a skill", () => {
  it("asks command.dispatch for the session, and keeps the skill text apart from what the chat shows", async () => {
    const calls: unknown[] = [];
    const ran = await runSkill(
      async (method, params) => {
        calls.push({ method, params });
        return { type: "skill", message: golden[0].content, name: "debugging", display: "/debugging fix the build using $debugging" };
      },
      "rt1",
      { name: "debugging", arg: "fix the build using $debugging" },
    );
    expect(calls).toEqual([{ method: "command.dispatch", params: { name: "debugging", arg: "fix the build using $debugging", session_id: "rt1" } }]);
    expect(ran).toEqual({ message: golden[0].content, display: "/debugging fix the build using $debugging" });
    // An older answer without `display`: read from the message, as Hermes's history would.
    const older = await runSkill(async () => ({ type: "skill", message: golden[0].content, name: "debugging" }), "rt1", { name: "debugging", arg: "x" });
    expect(older.display).toBe("/debugging fix the build using $debugging");
  });

  it("sends nothing when Hermes answers anything but a skill", async () => {
    await expect(runSkill(async () => ({ type: "send", message: "bundle", notice: "Loading bundle" }), "rt1", { name: "x", arg: "" })).rejects.toThrow(/nothing was sent/);
    await expect(runSkill(async () => ({ type: "exec", output: "ran" }), "rt1", { name: "x", arg: "" })).rejects.toThrow(/nothing was sent/);
    await expect(runSkill(() => Promise.reject(new RpcError(4018, "not a quick/plugin/bundle/skill command: x")), "rt1", { name: "x", arg: "" })).rejects.toThrow(
      /no x skill to run.*turned off or removed/,
    );
  });
});
