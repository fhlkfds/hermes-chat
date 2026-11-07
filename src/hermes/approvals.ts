// A chat's approval mode (GLOSSARY "Approval mode", ADR 0089): what Hermes reports, what the pill shows for it, and
// the writes a pick sends. Pure: the transport sends the writes, and only Hermes's report or answers move the badge.
import type { ApprovalMode, Approvals } from "./model";

/** What the owner can pick. Smart and Manual set the profile's mode; YOLO sets this chat's own flag. */
export type ApprovalPick = "smart" | "manual" | "yolo";

/** One `config.set` a pick sends: the chat's flag (session scope) or the profile's mode. */
export type ApprovalWrite = { key: "yolo"; value: "on" | "off" } | { key: "approvals.mode"; value: "smart" | "manual" };

/**
 * The pill's face. `yolo`: Hermes won't ask in this chat, `scope` "all" when the profile's mode is off (every chat on
 * it), else "chat". Hermes's `--yolo` launch flag reads as "chat": its report can't tell the two apart.
 */
export type ApprovalsBadge = { kind: "unknown" } | { kind: "mode"; mode: "smart" | "manual" } | { kind: "yolo"; scope: "chat" | "all" };

const MODES: readonly ApprovalMode[] = ["smart", "manual", "off"];
export const isApprovalMode = (v: unknown): v is ApprovalMode => MODES.includes(v as ApprovalMode);

/** The approvals in a `session.info` payload, or none unless it carries both fields as Hermes sends them. */
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
 * The writes for `pick`, in order. The chat's flag beats the mode, so Smart or Manual turns it off first when Hermes
 * reports YOLO. The mode is written even when Hermes already reports it, so a stale report still converges.
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
