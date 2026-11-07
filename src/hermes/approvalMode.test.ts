// The approval mode's pure tables (approvals.ts): what a report says, the badge for it, and the writes a pick sends.
import { describe, expect, it } from "vitest";
import { approvalsOf, badgeOf, writesFor } from "./approvals";

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
