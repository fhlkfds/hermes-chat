// The slash command registry: what counts as a command, how the menu filters, and the Hermes calls behind the server
// commands, with the request shapes read from Hermes's source at the deployed `bf0203a`.
import { describe, expect, it } from "vitest";
import { COMMANDS, argProblem, completion, listServerCommands, matchCommands, menuQuery, runServerCommand, typedCommand } from "./commands";
import { RpcError } from "./transport";

const def = (name: string) => COMMANDS.find((c) => c.name === name)!;

describe("A typed command", () => {
  it("is a registry name right after a leading slash; anything else is an ordinary message", () => {
    expect(typedCommand("/rename  Backups  ")).toEqual({ def: def("rename"), arg: "Backups" });
    expect(typedCommand("/NEW")).toEqual({ def: def("new"), arg: "" });
    expect(typedCommand("/deploy now")).toBeUndefined();
    expect(typedCommand(" /new")).toBeUndefined();
    expect(typedCommand("/usr/local/bin is full")).toBeUndefined();
    expect(typedCommand("please /new")).toBeUndefined();
    // Words after a command that takes none: the owner is writing a message.
    expect(typedCommand("/help me read this log")).toBeUndefined();
  });

  it("keeps a multiline argument as typed, inside included", () => {
    expect(typedCommand("/steer stop after the tests\n\n  then  report")?.arg).toBe("stop after the tests\n\n  then  report");
  });

  it("says when a required argument is missing", () => {
    expect(argProblem(def("rename"), "")).toBe("/rename needs <title>.");
    expect(argProblem(def("rename"), "x")).toBeUndefined();
    expect(argProblem(def("context"), "")).toBeUndefined();
  });
});

describe("The menu", () => {
  it("opens only while the command's name is typed", () => {
    expect(menuQuery("/")).toBe("");
    expect(menuQuery("/Re")).toBe("re");
    expect(menuQuery("/rename ")).toBeUndefined();
    expect(menuQuery("/rename\n")).toBeUndefined();
    expect(menuQuery("hi /re")).toBeUndefined();
  });

  it("lists names starting with the query first, then names or descriptions containing it", () => {
    expect(matchCommands("").map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
    expect(matchCommands("de").map((c) => c.name)).toEqual(["delete"]);
    expect(matchCommands("context").map((c) => c.name)).toEqual(["context"]);
    expect(matchCommands("chat").map((c) => c.name)).toEqual(["new", "rename", "delete", "btw", "context"]);
    expect(matchCommands("zzz")).toEqual([]);
  });

  it("fills in the name, with a space when an argument follows", () => {
    expect(completion(def("rename"))).toBe("/rename ");
    expect(completion(def("new"))).toBe("/new");
  });
});

describe("Server commands", () => {
  it("are the registry's that Hermes lists in commands.catalog for the profile", async () => {
    const calls: unknown[] = [];
    const names = await listServerCommands(async (method, params) => {
      calls.push({ method, params });
      return { canon: { "/steer": "/steer", "/s": "/steer", "/compress": "/compress" } };
    }, "work");
    expect(calls).toEqual([{ method: "commands.catalog", params: { profile: "work" } }]);
    expect([...names.listed]).toEqual(["steer"]);
    expect([...names.replaced]).toEqual([]);
  });

  it("leave out a /steer a quick or plugin command would replace, or might", async () => {
    const canon = { "/steer": "/steer", "/context": "/context" };
    const list = (res: Record<string, unknown>) =>
      listServerCommands(async () => ({ canon, ...res }), "default").then((l) => ({ listed: [...l.listed], replaced: [...l.replaced], unsure: [...l.unsure] }));
    // A quick command can run any shell command (`_dispatch_quick`), ahead of Hermes's own /steer.
    expect(await list({ categories: [{ name: "Session", pairs: [["/steer", "x"]] }, { name: "User commands", pairs: [["/steer", "exec: ./deploy.sh"]] }] })).toEqual({
      listed: ["context"], replaced: ["steer"], unsure: [],
    });
    // A plugin of a registry name is kept out of `pairs` but named in `plugin_commands`.
    expect(await list({ plugin_commands: { Steer: "Plugin command" } })).toEqual({ listed: ["context"], replaced: ["steer"], unsure: [] });
    // /context is answered from the live session before any of those, so nothing replaces it.
    expect(await list({ plugin_commands: { context: "Plugin command" }, categories: [{ name: "User commands", pairs: [["/context", "x"]] }] })).toEqual({
      listed: ["steer", "context"], replaced: [], unsure: [],
    });
    // Discovery that failed can't rule a replacement out. A failed skill discovery overwrites a quick command warning.
    for (const failed of [{ plugin_discovery_error: "boom" }, { warning: "quick_commands discovery unavailable: bad yaml" }, { warning: "skill discovery unavailable: boom" }])
      expect(await list(failed)).toEqual({ listed: ["context"], replaced: [], unsure: ["steer"] });
  });

  it("say Hermes needs updating when it has no catalog", async () => {
    await expect(listServerCommands(() => Promise.reject(new RpcError(-32601, "unknown method")), "default")).rejects.toThrow(/doesn't list its commands/);
    await expect(listServerCommands(() => Promise.reject(new RpcError(5020, "boom")), "default")).rejects.toThrow("boom");
  });

  it("go to Hermes with their argument as its own field, or as Hermes's own slash line", async () => {
    const calls: unknown[] = [];
    const rpc = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return method === "command.dispatch" ? { type: "send", message: "a\nb", notice: "No agent running" } : { output: "12k tokens" };
    };
    expect(await runServerCommand(rpc, "rt1", def("steer"), "a\nb")).toEqual({ kind: "send", message: "a\nb", notice: "No agent running" });
    expect(await runServerCommand(rpc, "rt1", def("context"), "")).toEqual({ kind: "output", text: "12k tokens" });
    expect(calls).toEqual([
      { method: "command.dispatch", params: { name: "steer", arg: "a\nb", session_id: "rt1" } },
      { method: "slash.exec", params: { command: "/context", session_id: "rt1" } },
    ]);
  });

  it("refuse an answer they don't know how to show", async () => {
    await expect(runServerCommand(async () => ({ type: "prefill", message: "x" }), "rt1", def("steer"), "x")).rejects.toThrow(/doesn't handle/);
  });
});
