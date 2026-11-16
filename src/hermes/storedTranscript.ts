// A chat's history as its transcript shows it, worked out from its stored rows (`GET /api/sessions/{id}/messages`) for a
// chat Hermes takes no session for. It follows what `session.resume` does to the same rows
// (`tui_gateway/session_history.py` `_history_to_messages` at v0.23.1), so both ways of reading a chat show it alike,
// but for one thing: every tool's result is kept, where `session.resume` keeps only the edit tools'.
import { callsOf, type StoredCall } from "./flightRecorder";
import { isObj, nonEmptyText, optionalText } from "./values";

/**
 * A history row as `session.resume` projects it (research doc §5, `TranscriptMessage`). Tool rows carry the call's
 * name, args and an 80-char `context`; Hermes keeps the result (`content`) only for edit tools. `timestamp`: when the
 * row was stored, Unix seconds, sent only when positive.
 */
export type TranscriptMessage = {
  role: string;
  text?: string;
  reasoning?: string;
  content?: unknown;
  name?: string;
  context?: string;
  args?: Record<string, unknown>;
  /** A tool row's call (`tool_call_id`). */
  tool_call_id?: string;
  timestamp?: number;
  /** The stored row (`messages.id`); a live session's not-yet-stored tail has none. */
  row_id?: number;
  /** How Hermes shows the row: `steer` for a message that went into a running reply (`session_history.py`). */
  display_kind?: string;
  /** Hermes's display facts for the row, such as a Returned result's title, as an object or its JSON text. */
  display_metadata?: unknown;
};

const ROLES = new Set(["user", "assistant", "tool", "system"]);
const CONTEXT_MAX = 80;

/** The argument Hermes previews each tool by, then the ones it tries for any other tool (`agent/display.py`). */
const PRIMARY_ARG: Record<string, string> = {
  terminal: "command", web_search: "query", web_extract: "urls", read_file: "path", write_file: "path", patch: "path",
  search_files: "pattern", browser_navigate: "url", browser_click: "ref", browser_type: "text", image_generate: "prompt",
  text_to_speech: "text", vision_analyze: "question", skill_view: "name", skills_list: "category", cronjob_manage: "action",
  execute_code: "code", browser_exec: "code", delegate_task: "goal", skill_manage: "name",
};
const FALLBACK_ARGS = ["query", "text", "command", "path", "name", "prompt", "code", "goal"];

/** A tool call's main argument on one line, cut to 80 characters, as `_tool_ctx` previews it. */
function toolContext(name: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const key = Object.hasOwn(PRIMARY_ARG, name) ? PRIMARY_ARG[name] : FALLBACK_ARGS.find((k) => k in args);
  const value = key === undefined ? undefined : args[key];
  const first = Array.isArray(value) ? value[0] : value;
  const line = first === undefined || first === null ? "" : String(first).replace(/\s+/g, " ").trim();
  return line.length > CONTEXT_MAX ? `${line.slice(0, CONTEXT_MAX - 3)}...` : line || undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isObj(part)) return "";
      if (typeof part.text === "string") return part.text;
      return typeof part.type === "string" && part.type.includes("image") ? "\n[image]" : "";
    })
    .join("");
}

/**
 * Every stored row of a chat, oldest first, as the transcript's rows. All of them go in at once: a tool row is named
 * by the call an earlier assistant row made, which another page of the read may hold.
 */
export function projectStored(rows: readonly unknown[]): TranscriptMessage[] {
  const calls = new Map<string, StoredCall>();
  return rows.flatMap((row): TranscriptMessage[] => {
    if (!isObj(row) || typeof row.role !== "string" || !ROLES.has(row.role)) return [];
    const role = row.role;
    // Before a hidden row is dropped: its tool rows still show, named from its calls.
    if (role === "assistant") for (const c of callsOf(row.tool_calls)) calls.set(c.id, c);
    if (row.display_kind === "hidden") return [];
    // Hermes keeps a compaction carrier's whole text in `content` and what a person should see in `display_content`.
    const text = textOf(row.display_content ?? row.content);
    if (role === "user" && text.trimStart().startsWith("[System:")) return [];
    const shared = {
      ...(typeof row.timestamp === "number" && row.timestamp > 0 && { timestamp: row.timestamp }),
      ...(row.display_metadata != null && row.display_metadata !== "" && { display_metadata: row.display_metadata }),
    };
    if (role === "tool") {
      const tool_call_id = nonEmptyText(row.tool_call_id);
      const call = tool_call_id === undefined ? undefined : calls.get(tool_call_id);
      const name = call?.name ?? nonEmptyText(row.tool_name) ?? "tool";
      const context = toolContext(name, call?.args);
      return [
        {
          role,
          name,
          ...(context && { context }),
          ...(row.content != null && { content: row.content }),
          ...(tool_call_id && { tool_call_id }),
          ...(call?.args && { args: call.args }),
          ...shared,
        },
      ];
    }
    const reasoning = role === "assistant" ? nonEmptyText(row.reasoning) ?? nonEmptyText(row.reasoning_content) : undefined;
    if (!text.trim() && !reasoning?.trim()) return [];
    const display_kind = optionalText(row.display_kind);
    return [
      {
        role,
        text,
        ...(reasoning && { reasoning }),
        ...(typeof row.id === "number" && { row_id: row.id }),
        ...(display_kind && { display_kind }),
        ...shared,
      },
    ];
  });
}
