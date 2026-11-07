import type { ApprovalMode, Approvals } from "./model";

export type ApprovalPick = "smart" | "manual" | "yolo";

/** One `config.set` a pick sends: the chat's flag (session scope) or the profile's mode. */
export type ApprovalWrite = { key: "yolo"; value: "on" | "off" } | { key: "approvals.mode"; value: "smart" | "manual" };

/** Hermes's `--yolo` launch flag reads as `scope` "chat": `session.info` can't tell it from the chat's own flag. */
export type ApprovalsBadge = { kind: "unknown" } | { kind: "mode"; mode: "smart" | "manual" } | { kind: "yolo"; scope: "chat" | "all" };

const MODES: readonly ApprovalMode[] = ["smart", "manual", "off"];
export const isApprovalMode = (v: unknown): v is ApprovalMode => MODES.includes(v as ApprovalMode);

export function approvalsOf(info: unknown): Approvals | undefined {
  if (!info || typeof info !== "object") return undefined;
  const { approval_mode: mode, yolo } = info as Record<string, unknown>;
  return isApprovalMode(mode) && typeof yolo === "boolean" ? { mode, yolo } : undefined;
}

export function badgeOf(a: Approvals | undefined): ApprovalsBadge {
  if (!a) return { kind: "unknown" };
  if (a.mode === "off") return { kind: "yolo", scope: "all" };
  if (a.yolo) return { kind: "yolo", scope: "chat" };
  return { kind: "mode", mode: a.mode };
}

/**
 * The chat's flag beats the mode, so Smart or Manual turns it off first when Hermes reports YOLO. The mode is written
 * even when Hermes already reports it, so a stale report still converges.
 */
export function writesFor(pick: ApprovalPick, a: Approvals): ApprovalWrite[] {
  if (pick === "yolo") return [{ key: "yolo", value: "on" }];
  return [...(a.yolo ? [{ key: "yolo", value: "off" } as const] : []), { key: "approvals.mode", value: pick }];
}

export const PICK_COPY: Record<ApprovalPick, { name: string; tag: "Profile default" | "This chat"; what: string }> = {
  smart: { name: "Smart", tag: "Profile default", what: "Hermes's checker lets safe-looking commands run and asks you about the rest." },
  manual: { name: "Manual", tag: "Profile default", what: "Hermes asks you before every command it flags as dangerous." },
  yolo: { name: "YOLO", tag: "This chat", what: "Hermes runs every command in this chat without asking." },
};
