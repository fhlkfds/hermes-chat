// Edit and Regenerate (ADR 0035). Neither changes the chat they're asked from: each makes a branch with Hermes's
// `session.branch` through the owner's message (ADR 0027), takes back the branch's copy of that message with
// `session.undo` on the branch only, and sends the message again in the branch: the owner's new words for Edit, the
// words as Hermes stored them for Regenerate. Probed live on 2026-11-03 against a throwaway HERMES_HOME
// (docs/research/hermes-gateway-api.md, "Edit and Regenerate").
//
// This module holds what the app works out around those calls: which message a reply answers, the words an Edit
// starts from, what can't be sent again, which turn a message is, and which chats are versions of one turn.
import type { Chat, Item } from "./model";
import type { ModelPick } from "./models";
import { branchBlocked, excerpt, imageCount, typedText, type BranchLink, type BranchPreview, type IncludedMessage } from "./branch";

export type ReplayKind = "edit" | "regenerate";

/**
 * Which message of the owner's an Edit or Regenerate under `itemId` sends again: the message itself for Edit, and for
 * Regenerate the last message of the owner's before the reply. Otherwise, why there is none.
 */
export function replayTarget(items: Item[], itemId: string, kind: ReplayKind): { userId: string; replyId?: string } | { error: string } {
  const at = items.findIndex((i) => i.id === itemId);
  const item = items[at];
  if (kind === "edit") {
    if (!item || item.kind !== "user" || item.outgoing || !item.text.trim()) return { error: "Only a message of yours that Hermes has can be edited." };
    return { userId: item.id };
  }
  if (!item || item.kind !== "assistant" || !item.text.trim()) return { error: "Only a reply with text can be regenerated." };
  for (let i = at - 1; i >= 0; i--) {
    const u = items[i];
    if (u.kind === "user" && !u.outgoing) return { userId: u.id, replyId: item.id };
  }
  return { error: "This reply doesn't answer a message of yours in this chat, so there's nothing to send again." };
}

/** The `@file:` refs a stored message starts with, as the app sends them (`file.attach` `ref_text`, then a blank line). */
const LEADING_REFS = /^(?:@file:(?:`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)[ \t]*\n?)+\s*/;

/**
 * A stored message split into the `@file:` refs it starts with and the words the transcript shows. An Edit changes the
 * words and keeps the refs, so the files go with the edited message too.
 */
export function splitRefs(stored: string): { refs: string; words: string } {
  const typed = typedText(stored);
  const m = typed.match(LEADING_REFS);
  if (!m) return { refs: "", words: typed };
  return { refs: m[0].trimEnd(), words: typed.slice(m[0].length) };
}

/** What goes to Hermes for an edited message: its refs, as stored, and the new words. */
export const withRefs = (refs: string, words: string) => (refs ? `${refs}\n\n${words.trim()}` : words.trim());

/**
 * What Regenerate sends: the message as the owner sent it, without the footer Hermes added when it stored it, which
 * Hermes adds again as the message goes.
 */
export const resendText = (stored: string) => typedText(stored).trim();

/**
 * Why a stored message can't be sent again, or nothing. An image is stored by Hermes as it saw it, and isn't a file
 * the app can attach again from the history (Hermes's own `/retry` refuses "attached media" for the same reason).
 */
export function cannotResend(stored: string, kind: ReplayKind): string | undefined {
  const images = imageCount(typedText(stored));
  if (!images) return undefined;
  const what = images === 1 ? "an image" : `${images} images`;
  return `This message was sent with ${what}, and Hermes can't send an image again from a chat's history, so it can't be ${kind === "edit" ? "edited" : "regenerated"} here. To try again, use Branch from here on the message before it, then attach the image again.`;
}

/**
 * Why no Edit or Regenerate can be made in the chat now, or nothing. A reply running may still be running tools, so the
 * branch's point isn't settled: the owner stops it, or waits for it, and Hermes says it has ended first.
 */
export function replayBlocked(chat: Chat, connected: boolean): string | undefined {
  if (connected && chat.stopping) return "Hermes is stopping the reply. Edit and Regenerate work once it says the reply has ended.";
  if (connected && chat.running)
    return "Hermes is still replying in this chat, and its tools may still be running. Stop the reply, or wait for it to end; Edit and Regenerate work once it has.";
  return branchBlocked(chat, connected);
}

/** Which turn a message at `index` of a branch spine is: the owner's shown messages before it. */
export const turnAt = (spine: { role: string; hidden: boolean }[], index: number) => spine.slice(0, index).filter((r) => r.role === "user" && !r.hidden).length;

/** Each owner's message of `items` that Hermes has, by turn, from 0: the same numbering as `turnAt`. */
export function turnsOf(items: Item[]): Map<string, number> {
  const turns = new Map<string, number>();
  let n = 0;
  for (const i of items) if (i.kind === "user" && !i.outgoing) turns.set(i.id, n++);
  return turns;
}

/**
 * The chat whose turn `turn` of `chatId` is a version of. A version of a later turn is a copy of its root up to that
 * turn, so its earlier turns are its root's; a version of this turn has its root; anything else is its own.
 */
export function variantRoot(links: Record<string, BranchLink>, chatId: string, turn: number): string {
  const seen = new Set<string>();
  let id = chatId;
  while (!seen.has(id)) {
    seen.add(id);
    const v = links[id]?.variant;
    if (!v || v.turn < turn) return id;
    if (v.turn === turn) return v.rootId;
    id = v.rootId;
  }
  return id;
}

/** One version of a turn: the chat it is in, how it came about, what its answer ran on, and when it was made. */
export type Variant = { chatId: string; kind: "original" | ReplayKind; model?: ModelPick; at: number };

/**
 * The versions of each turn of `chatId` that has more than one, in the order they were made, the original first.
 * A chat shows the versions of a turn when it is one of them. Versions whose chat isn't listed are left out.
 */
export function variantsIn(links: Record<string, BranchLink>, chatId: string, listed: (id: string) => boolean): Map<number, Variant[]> {
  const groups = new Map<string, Variant[]>();
  for (const [id, l] of Object.entries(links)) {
    const v = l.variant;
    if (!v || !listed(id)) continue;
    const key = `${v.turn}\u0000${v.rootId}`;
    groups.set(key, [...(groups.get(key) ?? []), { chatId: id, kind: v.kind, model: v.model, at: l.at }]);
  }
  const out = new Map<number, Variant[]>();
  for (const [key, versions] of groups) {
    const cut = key.indexOf("\u0000");
    const turn = Number(key.slice(0, cut));
    const rootId = key.slice(cut + 1);
    if (rootId !== chatId && !versions.some((v) => v.chatId === chatId)) continue;
    const all = [...(listed(rootId) ? [{ chatId: rootId, kind: "original" as const, at: 0 }] : []), ...versions.sort((a, b) => a.at - b.at)];
    if (all.length > 1) out.set(turn, all);
  }
  return out;
}

/** A model and its settings, as a version shows them. */
export function modelLabel(m?: ModelPick): string | undefined {
  if (!m) return undefined;
  return [m.model, m.provider, m.effort && `${m.effort} reasoning`, m.fast && "fast"].filter(Boolean).join(" · ");
}

/**
 * What an Edit or Regenerate would make, for the owner to check first. `branch`: the branch through the owner's message,
 * as Branch from here previews it. `stored`: that message as Hermes stored it, split into `refs` and `words`. `later`:
 * what the new branch leaves out, the message itself onwards, which stays in this chat. `laterTools`: tool calls among
 * them. `answer`: the reply Regenerate was asked under. `spine`: `spineKey` of the chat's whole spine as read, so a
 * change by another client before the owner confirms is caught. `turn` and `rootId`: which turn this is a version of.
 */
export type ReplayPreview = {
  kind: ReplayKind;
  branch: BranchPreview;
  stored: string;
  refs: string;
  words: string;
  later: IncludedMessage[];
  laterTools: number;
  answer?: string;
  spine: string;
  turn: number;
  rootId: string;
};

/** The messages after the owner's message, as the preview lists what the branch leaves out. */
export const laterOf = (spine: { role: "user" | "assistant"; text: string; hidden: boolean }[], index: number): IncludedMessage[] =>
  spine.slice(index).filter((r) => !r.hidden).map((r) => ({ role: r.role, excerpt: excerpt(r.text) }));
