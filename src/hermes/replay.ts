// Edit and Regenerate (issue #63, ADR 0032): both make a new branch and leave the chat they came from as it was. Hermes
// does the copy and the cut. Legacy `session.branch {count}` (ADR 0027) forks the chat through the owner's message,
// then `prompt.submit {truncate_before_row_id, confirm_truncate}` in that fresh branch replaces the branch's copy of the
// message with the edited words (Edit), or with the same words (Regenerate), and the agent answers again. The original
// chat's stored rows are never written. Probed live on 2026-11-03 against the deployed Hermes (research doc, "Edit and
// Regenerate").
//
// This module holds what the app works out around those calls: which message a reply answers, what the new branch
// will hold and leave out, the words that go to Hermes, whether the chat changed since the owner looked, and which
// branches are the other answers to a message.
import { branchBlocked, excerpt, fileRefs, imageCount, spineKey, spineOf, type BranchLink, type BranchPreview, type IncludedMessage, type SpineRow, type StoredBranchRow } from "./branch";
import type { Chat, Item } from "./model";
import type { ModelPick } from "./models";

export type ReplayKind = "edit" | "regenerate";

/**
 * What a branch made by Edit or Regenerate replays, kept with its link on this computer. `sourceRowId`: the owner's
 * message in the parent, by its stored row. `excerpt`: that message's first words. `edited`: the first words of the
 * message that replaced it (Edit). `count`: the spine rows the branch was made with, the replayed message the last of
 * them. `branchRowId`: the replayed message's stored row in the branch, once Hermes said.
 * `model`: what the branch ran on when the message went, as Hermes reported it.
 */
export type ReplayInfo = { kind: ReplayKind; sourceRowId: number; count: number; excerpt: string; edited?: string; branchRowId?: number; model?: ModelPick };

/** A spine row that is a message someone sees: not hidden, and not a timeline marker such as a model switch. */
const isMessage = (r: SpineRow) => !r.hidden && !r.marker;

/** A message of the owner's that Edit can open: one Hermes has, with words. */
const ownerMessage = (i: Item): i is Extract<Item, { kind: "user" }> => i.kind === "user" && !i.outgoing && !!i.text.trim();

/**
 * The owner's message that Edit or Regenerate of `itemId` replays: the message itself for Edit; for Regenerate, the
 * owner's message the reply answers, the nearest one before it. Otherwise why there is none.
 */
export function replaySource(items: Item[], itemId: string, kind: ReplayKind): { sourceId: string } | { error: string } {
  const at = items.findIndex((i) => i.id === itemId);
  const item = items[at];
  if (kind === "edit") {
    if (!item || !ownerMessage(item)) return { error: "Only a message of yours that Hermes has can be edited." };
    return { sourceId: item.id };
  }
  if (!item || item.kind !== "assistant" || !item.text.trim()) return { error: "Only a reply with text can be regenerated." };
  for (let i = at - 1; i >= 0; i--) {
    const before = items[i];
    if (before.kind !== "user") continue;
    if (ownerMessage(before)) return { sourceId: before.id };
    break;
  }
  return { error: "This reply doesn't follow a message of yours that Hermes has, so there's nothing to send again." };
}

/**
 * Why no Edit or Regenerate can be made in the chat now, or nothing: Branch from here's reasons (a reply running or
 * being stopped, an Approval waiting, a message unconfirmed, the chat loading, offline), and a Hermes that can't branch.
 */
export function replayBlocked(chat: Chat, connected: boolean, cannotBranch?: boolean): string | undefined {
  if (connected && cannotBranch)
    return "This Hermes server can't branch chats, so Hermes Chat can't keep this chat as it is while it sends a message again. Updating Hermes may add it.";
  return branchBlocked(chat, connected);
}

/**
 * What Edit or Regenerate of one owner's message would do, for the owner to check first. `count`: the spine rows the
 * branch copies, through the owner's message, whose copy the replayed message then replaces. `original`: the owner's
 * words, which Edit opens: as the chat shows them, or for a message sent with files, as stored after their refs. `stored`: as Hermes keeps it, files' `@file:` refs first; Regenerate sends this
 * again. `refsPrefix`: what Edit puts before the new words, so the files go again. `later`: what the branch leaves out:
 * the messages after the owner's, and the tool calls made after it. `whole`: a fingerprint of the chat's whole stored
 * history, to tell whether another client changed or added to it before the branch is made.
 */
export type ReplayPreview = {
  kind: ReplayKind;
  chatId: string;
  /** The owner's message replayed, and for Regenerate the reply the button was under. */
  sourceItemId: string;
  replyItemId?: string;
  parentTitle: string;
  count: number;
  /** The owner's message, by its stored row in the parent. */
  sourceRowId: number;
  original: string;
  stored: string;
  refsPrefix: string;
  /** The messages before it that the branch starts with, as the chat shows them; hidden rows are counted apart. */
  before: number;
  hidden: number;
  later: { messages: IncludedMessage[]; yours: number; replies: number; toolCalls: number };
  files: { path: string; state: "there" | "missing" | "unknown" }[];
  model?: ModelPick;
  /** `spineKey` of the rows copied, through the owner's message. */
  fingerprint: string;
  /**
   * `spineKey` of the same rows less model-switch markers: what the branch must still hold once ADR 0027 switches its
   * model, since Hermes then deactivates every earlier marker in it and adds its own (`_append_model_switch_marker`).
   */
  copyKey: string;
  whole: string;
};

/** A fingerprint of every stored row's identity and the spine's words: changes when anything is added, removed or edited. */
export function wholeKey(rows: StoredBranchRow[], spine: SpineRow[]): string {
  return `${rows.length}:${rows.at(-1)?.id ?? 0}:${spineKey(spine)}`;
}

/** The `@file:` refs a stored message starts with, as Hermes Chat sends them (`file.attach` `ref_text`, then the words). */
const LEADING_REFS = /^(?:\s*@file:(?:`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+))+\s*/;

/** A stored message split into the `@file:` refs it starts with, which Edit sends again, and the owner's words after them. */
export function splitRefs(stored: string): { refs: string; words: string } {
  const refs = LEADING_REFS.exec(stored)?.[0] ?? "";
  return { refs, words: stored.slice(refs.length) };
}

/**
 * The preview of Edit or Regenerate of the owner's message at `spine[index]`. Rejects with why when Hermes Chat can't
 * send that message again as it was: one sent with images, which Hermes keeps apart from its words.
 */
export function replayPreviewOf(
  kind: ReplayKind,
  chat: Pick<Chat, "id" | "title" | "model">,
  source: Extract<Item, { kind: "user" }>,
  replyItemId: string | undefined,
  rows: StoredBranchRow[],
  spine: SpineRow[],
  index: number,
): Omit<ReplayPreview, "files"> & { refs: string[] } {
  const row = spine[index];
  if (row.role !== "user") throw new Error("Hermes keeps this as one of its replies, not a message of yours, so it can't be sent again.");
  if (imageCount(row.text))
    throw new Error(
      "This message was sent with an image. Hermes keeps the image apart from the words, and Hermes Chat can't send it again, so it can't edit or regenerate from here. Branch from here keeps the image, or send it again in a new message.",
    );
  const { refs: refsPrefix, words } = splitRefs(row.text);
  const kept = spine.slice(0, index);
  let after = spine.slice(index + 1).filter(isMessage);
  // Regenerate replaces the reply itself, which stays in the original: only what came after that turn is left out.
  if (kind === "regenerate") {
    const next = after.findIndex((r) => r.role === "user");
    after = next < 0 ? [] : after.slice(next);
  }
  return {
    kind,
    chatId: chat.id,
    sourceItemId: source.id,
    ...(replyItemId && { replyItemId }),
    parentTitle: chat.title,
    count: index + 1,
    sourceRowId: row.id,
    original: refsPrefix ? words : source.text,
    stored: row.text,
    refsPrefix,
    before: kept.filter(isMessage).length,
    hidden: kept.filter((r) => r.hidden).length,
    later: {
      messages: after.map((r) => ({ role: r.role, excerpt: excerpt(r.text) })),
      yours: after.filter((r) => r.role === "user").length,
      replies: after.filter((r) => r.role === "assistant").length,
      toolCalls: rows.filter((r) => r.role === "tool" && r.id > row.id).length,
    },
    refs: [...new Set(fileRefs(row.text))],
    ...(chat.model && { model: chat.model }),
    fingerprint: spineKey(spine.slice(0, index + 1)),
    copyKey: spineKey(spine.slice(0, index + 1).filter((r) => !r.marker)),
    whole: wholeKey(rows, spine),
  };
}

/** The words Hermes gets: Edit's new words after the original's file refs, or Regenerate's message as stored. */
export function replayPrompt(p: Pick<ReplayPreview, "kind" | "stored" | "refsPrefix">, text: string): string {
  if (p.kind === "regenerate") return p.stored;
  // A message that was only files has no space after its last ref: the words mustn't run into its path.
  const gap = p.refsPrefix && !/\s$/.test(p.refsPrefix) ? "\n\n" : "";
  return `${p.refsPrefix}${gap}${text.trim()}`;
}

/**
 * The branch's copy of the owner's message, read back from its stored rows: its last message, when its messages are
 * the ones the preview showed (`copyKey`). Model-switch markers don't count: ADR 0027's switch to the original's model
 * makes Hermes deactivate every marker the branch copied and add one after the copy (`_append_model_switch_marker`),
 * which the cut archives with it. `empty`: nothing but markers comes before the copy, so the cut needs
 * `confirm_empty_truncate`. Undefined when anything else changed.
 */
export function replayedCopy(rows: StoredBranchRow[], copyKey: string): { copy: SpineRow; empty: boolean } | undefined {
  const spine = spineOf(rows).filter((r) => !r.marker);
  const copy = spine.at(-1);
  if (!copy || copy.role !== "user" || spineKey(spine) !== copyKey) return undefined;
  if (!rows.every((r) => r.id <= copy.id || r.display_kind === "model_switch")) return undefined;
  return { copy, empty: !rows.some((r) => r.id < copy.id && r.display_kind !== "model_switch") };
}

/**
 * Why a replayed message Hermes didn't take can't be sent again in place of the copy (stored row `rowId`) now, or
 * nothing: the copy must still be in the branch, with nothing after it but a model-switch marker. A Retry after the
 * owner, or another client, added to the branch would otherwise archive those messages too.
 */
export function cutStale(rows: StoredBranchRow[], rowId: number): string | undefined {
  const at = rows.findIndex((r) => r.id === rowId);
  if (at < 0)
    return "Your original message isn't in this branch any more, so there's nothing for this one to replace. Edit takes these words back into the composer, to send as a new message.";
  if (rows.slice(at + 1).some((r) => r.display_kind !== "model_switch"))
    return "Messages were added to this branch after your original message. Sending this in its place would take them out of the branch, so it wasn't sent again. Edit takes these words back into the composer, to send as a new message.";
  return undefined;
}

/** The Branch from here preview the branch is made with: through the owner's message. */
export const branchPreviewOf = (p: ReplayPreview): BranchPreview => ({
  chatId: p.chatId,
  itemId: p.sourceItemId,
  parentTitle: p.parentTitle,
  count: p.count,
  point: { role: "user", excerpt: excerpt(p.stored, 120), rowId: p.sourceRowId },
  messages: [],
  hidden: p.hidden,
  toolCalls: 0,
  files: p.files,
  images: 0,
  ...(p.model && { model: p.model }),
  fingerprint: p.fingerprint,
});

/** A branch made by Edit or Regenerate of one owner's message in `parentId`, oldest first. */
export type ReplayBranch = { chatId: string; link: BranchLink & { replay: ReplayInfo } };

/** The branches made here by `kind` from the owner's message with stored row `sourceRowId` in `parentId`, oldest first. */
export function replaysOf(links: Record<string, BranchLink>, parentId: string, sourceRowId: number, kind: ReplayKind): ReplayBranch[] {
  return Object.entries(links)
    .filter((e): e is [string, BranchLink & { replay: ReplayInfo }] => {
      const l = e[1];
      return l.parentId === parentId && l.replay?.kind === kind && l.replay.sourceRowId === sourceRowId;
    })
    .map(([chatId, link]) => ({ chatId, link }))
    .sort((a, b) => a.link.at - b.link.at);
}

/**
 * A reply in a branch's stored rows: the text of the replies after the replayed message, up to the owner's next one.
 * `rowId`: the replayed message's row in the branch; without it, the branch's first message of the owner's after the
 * copied rows (`count`). Undefined when it isn't there.
 */
export function replyAfter(spine: SpineRow[], rowId: number | undefined, count: number): string | undefined {
  const at = rowId !== undefined ? spine.findIndex((r) => r.id === rowId) : spine.findIndex((r, i) => i >= count - 1 && r.role === "user" && isMessage(r));
  if (at < 0) return undefined;
  const parts: string[] = [];
  for (const r of spine.slice(at + 1)) {
    if (r.role === "user" && isMessage(r)) break;
    if (r.role === "assistant") parts.push(r.text.trim());
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

/** A model as the owner reads it: its name, then effort and fast mode when Hermes said. */
export const modelLabel = (m?: ModelPick) => (m ? `${m.model}${m.effort ? `, ${m.effort} reasoning` : ""}${m.fast ? ", fast" : ""}` : undefined);
