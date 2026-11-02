// A chat as a Markdown file, saved where the owner picks in the native Save dialog (`chat_export` in
// src-tauri/src/lib.rs). Only what the chat shows goes in: no session ids, connection details or attachment contents.
import { invoke } from "@tauri-apps/api/core";
import type { ApprovalChoice, Chat, Item } from "./model";
import { asError } from "./tauriPipe";
import { LOAD_ERROR_ID } from "./transport";

/** Shows the Save dialog and writes `markdown` where the owner picks. The path saved to, or `null` if cancelled. */
export type SaveFile = (markdown: string, fileName: string) => Promise<string | null>;

const saveWithDialog: SaveFile = (markdown, fileName) => invoke<string | null>("chat_export", { markdown, fileName }).catch(asError);

/** Exports the chat. The notice to show, or nothing when the owner cancelled the Save dialog. */
export async function exportChat(chat: Chat, save = saveWithDialog, now = new Date()): Promise<string | undefined> {
  try {
    const path = await save(chatMarkdown(chat, now), exportFileName(chat.title));
    return path ? `Exported to ${path}. It may contain sensitive information from the chat.` : undefined;
  } catch (e) {
    return `Couldn't export: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export const exportFileName = (title: string) =>
  `${
    title
      .replace(/[/\\:*?"<>|\x00-\x1f\s]+/g, " ")
      .trim()
      .replace(/^\.+\s*/, "")
      .slice(0, 100)
      .trim() || "Chat"
  }.md`;

export function chatMarkdown(chat: Chat, exportedAt: Date): string {
  const iso = exportedAt.toISOString();
  const missing =
    chat.loading ? "was still loading" : chat.items.some((i) => i.id === LOAD_ERROR_ID) ? "couldn't be loaded" : !chat.runtimeId ? "wasn't loaded" : undefined;
  const notes = [
    `Exported from Hermes Chat on ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC.`,
    `Only the history loaded in Hermes Chat is included: what Hermes sent when the chat was opened, and what came after.`,
    missing && `This chat's stored history ${missing}, so earlier messages may be missing.`,
    chat.running && "A reply was still being written; it is here as far as it had got.",
    chat.items.some((i) => i.kind === "tool" && i.result === undefined && i.status === "done") &&
      "Hermes keeps the output of most tool calls only while the reply is running, so earlier tool calls have none.",
    chat.items.some((i) => i.kind === "error") && "Hermes Chat's own error notices are left out.",
    "",
    "**This file may contain sensitive information.** It has the chat as written, including anything private pasted " +
      "or printed in it, such as passwords, keys or personal details. Hermes Chat doesn't look for or remove them.",
  ].filter((n) => n !== false && n !== undefined);
  const title = chat.title.replace(/\s+/g, " ").trim() || "Untitled chat";
  return [`# ${title}`, notes.map((n) => (n ? `> ${n}` : ">")).join("\n"), ...chat.items.flatMap(block)].join("\n\n") + "\n";
}

const ANSWER: Record<ApprovalChoice, string> = { once: "Approved once", session: "Approved for this chat", always: "Always approved", deny: "Denied" };

function block(i: Item): string[] {
  switch (i.kind) {
    case "user": {
      const files = i.attachments?.length ? [`_Attached, not included in this file:_ ${i.attachments.map(code).join(", ")}`] : [];
      return [["**You:**", message(i.text), ...files].filter(Boolean).join("\n\n")];
    }
    case "assistant":
      return [[`**Hermes:**${i.interrupted ? " _(stopped before it finished)_" : ""}`, message(i.text)].filter(Boolean).join("\n\n")];
    case "thinking":
      return [`**Hermes, thinking:**\n\n${fenced(i.text)}`];
    case "tool": {
      const head = [`**Tool:** ${code(i.name)}`, i.preview && code(i.preview), i.summary, i.durationS != null && `(${i.durationS}s)`];
      const output =
        i.result !== undefined
          ? `Output:\n\n${fenced(i.result)}`
          : i.status === "running"
            ? "_Still running when this file was saved; no output yet._"
            : i.status === "stopped"
              ? "_Stopped before it finished; no output._"
              : "_No output: Hermes didn't keep it._";
      const args = i.args && `Arguments:\n\n${fenced(JSON.stringify(i.args, null, 2), "json")}`;
      return [[head.filter(Boolean).join(" "), args, output].filter(Boolean).join("\n\n")];
    }
    case "approval": {
      const outcome = i.answer ? ANSWER[i.answer] : i.ended ? `No answer from here (${i.ended})` : "Waiting for an answer";
      return [`**Approval asked:** ${i.description}\n\n${fenced(i.command)}\n\n_${outcome}_`];
    }
    case "error":
      // The app's own notices, not the conversation; they can name the connection.
      return [];
  }
}

const longestRun = (text: string, char: string) => Math.max(0, ...(text.match(new RegExp(`${char}+`, "g")) ?? []).map((r) => r.length));

/** Verbatim text in a fence longer than any run of backticks in it, so nothing inside can close it. */
function fenced(text: string, lang = ""): string {
  const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Verbatim text as inline code. */
function code(text: string): string {
  const ticks = "`".repeat(longestRun(text, "`") + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/**
 * A message's Markdown as written, with a code fence it leaves open closed, so it can't swallow the rest of the file.
 * ponytail: only sees fences at the start of a line; one opened inside a block quote or list item still runs on.
 */
function message(text: string): string {
  const md = text.replace(/^\s*\n/, "").trimEnd();
  let open: string | undefined;
  for (const line of md.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (!open) {
      if (!(m[1][0] === "`" && m[2].includes("`"))) open = m[1];
    } else if (m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = undefined;
  }
  return open ? `${md}\n${open}` : md;
}
