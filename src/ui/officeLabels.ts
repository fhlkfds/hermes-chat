// What the office says about each agent, the same in the building and in List (ADR 0077, ADR 0089).
import { CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleHelp, CircleStop, Clock, Coffee, Loader, ShieldAlert, X } from "lucide-react";
import type { Desk, DeskState, Room } from "../hermes/office";

export const STATE_LABEL: Record<DeskState, string> = {
  queued: "Queued",
  running: "Running",
  approval: "Waiting for your approval",
  failed: "Failed",
  uncertain: "May not have sent",
  completed: "Finished",
  unread: "New, not read yet",
  stopped: "Stopped",
  ended: "Ended, Hermes didn't say how",
  unknown: "Not known yet",
  idle: "Not running",
};

export const STATE_ICON: Record<DeskState, typeof X> = {
  queued: Clock,
  running: Loader,
  approval: ShieldAlert,
  failed: CircleAlert,
  uncertain: CircleHelp,
  completed: CircleCheck,
  unread: CircleDot,
  stopped: CircleStop,
  ended: CircleDashed,
  unknown: CircleHelp,
  idle: Coffee,
};

/** The subagent that started a subagent's desk, when it has a desk in the room too. */
export function parentOf(room: Room, d: Desk): Desk | undefined {
  const id = d.agent.kind === "subagent" ? d.agent.parent : undefined;
  return id && room.desks.find((p) => p.agent.kind === "subagent" && p.agent.id === id);
}

/** What a desk says to a screen reader, and the same in either view. */
export function deskLabel(room: Room, d: Desk, profile: string): string {
  const parent = parentOf(room, d);
  const where = `${parent ? `started by “${parent.name}”, ` : ""}in “${room.title}”${room.profile === profile ? "" : `, profile ${room.profile}`}`;
  return [`${d.name}, ${STATE_LABEL[d.state]}${d.stale ? ", as last seen" : ""}, ${where}.`, d.doing?.text, d.stale].filter(Boolean).join(" ");
}

