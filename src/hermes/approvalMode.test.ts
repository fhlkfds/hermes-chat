// The approval mode (ADR 0089): the pure tables in approvals.ts, and `setApprovals` against a fake Hermes speaking the
// deployed f0d94882 wire, stale session.info frames included.
import { describe, expect, it } from "vitest";
import { approvalsOf, badgeOf, writesFor } from "./approvals";
import { FakeHermes } from "./fakeHermes";
import type { ApprovalMode } from "./model";
import { connect } from "./transport";

describe("approvalsOf", () => {
  it.each([
    [{ approval_mode: "smart", yolo: false, model: "m" }, { mode: "smart", yolo: false }],
    [{ approval_mode: "manual", yolo: true }, { mode: "manual", yolo: true }],
    [{ approval_mode: "off", yolo: true }, { mode: "off", yolo: true }],
  ])("reads %j", (info, approvals) => expect(approvalsOf(info)).toEqual(approvals));

  it.each([
    ["no fields, as the create and resume answers", { model: "m" }],
    ["yolo alone", { yolo: true }],
    ["a mode alone", { approval_mode: "smart" }],
    ["a mode this app doesn't know", { approval_mode: "paranoid", yolo: false }],
    ["yolo as a string", { approval_mode: "smart", yolo: "true" }],
    ["nothing", undefined],
  ])("is unknown for %s", (_, info) => expect(approvalsOf(info)).toBeUndefined());
});

describe("badgeOf", () => {
  it.each([
    [undefined, { kind: "unknown" }],
    [{ mode: "smart", yolo: false }, { kind: "mode", mode: "smart" }],
    [{ mode: "manual", yolo: false }, { kind: "mode", mode: "manual" }],
    [{ mode: "smart", yolo: true }, { kind: "yolo", scope: "chat" }],
    [{ mode: "manual", yolo: true }, { kind: "yolo", scope: "chat" }],
    [{ mode: "off", yolo: true }, { kind: "yolo", scope: "all" }],
  ] as const)("shows %j as %j", (a, badge) => expect(badgeOf(a)).toEqual(badge));
});

describe("writesFor", () => {
  it.each([
    ["yolo", { mode: "smart", yolo: false }, [{ key: "yolo", value: "on" }]],
    ["yolo", { mode: "off", yolo: true }, [{ key: "yolo", value: "on" }]],
    ["smart", { mode: "manual", yolo: false }, [{ key: "approvals.mode", value: "smart" }]],
    ["smart", { mode: "smart", yolo: false }, [{ key: "approvals.mode", value: "smart" }]],
    ["manual", { mode: "smart", yolo: true }, [{ key: "yolo", value: "off" }, { key: "approvals.mode", value: "manual" }]],
    ["smart", { mode: "off", yolo: true }, [{ key: "yolo", value: "off" }, { key: "approvals.mode", value: "smart" }]],
  ] as const)("%s from %j sends %j", (pick, a, writes) => expect(writesFor(pick, a)).toEqual(writes));
});

/** A new chat on a fake Hermes that reports approvals, its profile's mode `mode`, before its agent reports them. */
async function chatOn(mode: ApprovalMode = "smart", tweak: (s: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.approvalModes = { default: mode };
  tweak(server);
  const hermes = await connect(server.openPipe);
  const id = await hermes.newChat();
  const runtime = server.runtimeIdOf(id)!;
  const approvals = () => hermes.getSnapshot().chats.find((c) => c.id === id)!.live?.approvals;
  const writes = () => server.requests.filter((r) => r.method === "config.set").map((r) => [r.params.key, r.params.value]);
  return { server, hermes, id, runtime, approvals, writes };
}

describe("setApprovals", () => {
  it("knows nothing until Hermes reports, then follows each session.info", async () => {
    const { server, hermes, id, runtime, approvals } = await chatOn("manual");
    expect(approvals()).toBeUndefined();
    await expect(hermes.setApprovals(id, "smart")).rejects.toThrow("Hermes hasn't reported approvals for this chat yet.");
    expect(server.last("config.set")).toBeUndefined();

    server.reportApprovals(runtime);
    await hermes.idle();
    expect(approvals()).toEqual({ mode: "manual", yolo: false });
    server.event(runtime, "session.info", { approval_mode: "off", yolo: true });
    await hermes.idle();
    expect(approvals()).toEqual({ mode: "off", yolo: true });
  });

  it("turns the chat's flag off before writing the profile's mode, with the profile and session", async () => {
    const { server, hermes, id, runtime, approvals, writes } = await chatOn("manual");
    server.reportApprovals(runtime);
    await hermes.setApprovals(id, "yolo");
    expect(approvals()).toEqual({ mode: "manual", yolo: true });

    await hermes.setApprovals(id, "smart");
    expect(writes()).toEqual([["yolo", "on"], ["yolo", "off"], ["approvals.mode", "smart"]]);
    expect(server.last("config.set")!.params).toEqual({ session_id: runtime, profile: "default", key: "approvals.mode", value: "smart" });
    expect(approvals()).toEqual({ mode: "smart", yolo: false });
  });

  describe("when Hermes sends a stale session.info around a write, as the deployed f0d94882 does", () => {
    it("settles YOLO on from Hermes's answer", async () => {
      const { server, hermes, id, runtime, approvals } = await chatOn("smart", (s) => (s.staleInfoOnWrite = true));
      server.reportApprovals(runtime);
      await hermes.setApprovals(id, "yolo");
      expect(approvals()).toEqual({ mode: "smart", yolo: true });
    });

    it("settles a mode from Hermes's answer", async () => {
      const { server, hermes, id, runtime, approvals } = await chatOn("smart", (s) => (s.staleInfoOnWrite = true));
      server.reportApprovals(runtime);
      await hermes.setApprovals(id, "manual");
      expect(approvals()).toEqual({ mode: "manual", yolo: false });
    });

    it("settles YOLO off and the new mode together", async () => {
      const { server, hermes, id, runtime, approvals } = await chatOn("manual", (s) => (s.staleInfoOnWrite = true));
      server.reportApprovals(runtime);
      await hermes.setApprovals(id, "yolo");
      await hermes.setApprovals(id, "smart");
      expect(approvals()).toEqual({ mode: "smart", yolo: false });
    });

    it("follows session.info again once the pick is done", async () => {
      const { server, hermes, id, runtime, approvals } = await chatOn("smart", (s) => (s.staleInfoOnWrite = true));
      server.reportApprovals(runtime);
      await hermes.setApprovals(id, "manual");
      server.event(runtime, "session.info", { approval_mode: "smart", yolo: false });
      await hermes.idle();
      expect(approvals()).toEqual({ mode: "smart", yolo: false });
    });
  });

  it("rejects with Hermes's refusal and keeps what the writes it answered say", async () => {
    const { server, hermes, id, runtime, approvals } = await chatOn("manual", (s) => s.managedKeys.add("approvals.mode"));
    server.reportApprovals(runtime);
    await hermes.setApprovals(id, "yolo");

    await expect(hermes.setApprovals(id, "smart")).rejects.toThrow("approvals.mode is managed by your administrator");
    // The flag went off before the mode was refused, so the profile's Manual governs the chat now.
    expect(approvals()).toEqual({ mode: "manual", yolo: false });
  });

  it("leaves the report alone when Hermes refuses the only write", async () => {
    const { server, hermes, id, runtime, approvals } = await chatOn("smart", (s) => s.managedKeys.add("yolo"));
    server.reportApprovals(runtime);
    await expect(hermes.setApprovals(id, "yolo")).rejects.toThrow("yolo is managed by your administrator");
    expect(approvals()).toEqual({ mode: "smart", yolo: false });
  });

  it("rejects for a chat not open on Hermes", async () => {
    const server = new FakeHermes();
    server.approvalModes = {};
    const hermes = await connect(server.openPipe);
    await expect(hermes.setApprovals("nope", "smart")).rejects.toThrow("This chat isn't open on Hermes.");
  });
});
