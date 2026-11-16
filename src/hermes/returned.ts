// A Returned result (ADR 0175): the stored user row that begins the turn Hermes runs when handed-off work comes back.
// Hermes marks it with a display kind and a one-line title (`display_metadata.display_text`), and its text is the
// model-facing notice (`tools/process_registry_notifications.py` at `bf0203a`). The owner is shown the title and the
// result only, as the official desktop app's `asyncResultBody` strips it (`apps/desktop/src/lib/chat-messages/hydration.ts`).

export type Returned = { title?: string; body: string; process: boolean };

const KINDS: Record<string, boolean> = { async_delegation_complete: false, process_complete: true };

/** `display_metadata` as an object: Hermes sends it as one, or as its JSON text from the stored row. */
export function displayMetadata(raw: unknown): Record<string, unknown> | undefined {
  let parsed = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

// `--- ✓ TASK 1/2: goal  (status=completed, 12s) ---`: the goal can span lines.
const TASK_HEADER = /^--- ([✓✗⚠]) TASK (\d+\/\d+)(?:: ([\s\S]*?))? {2}\(status=[^\n]*\) ---\r?\n/gm;

/** The result in a notice, without the envelope around it, or undefined when nothing is left. */
export function resultBody(content: string): string | undefined {
  let bodies = [content];
  if (content.startsWith("[IMPORTANT: ")) {
    bodies = content
      .split(/\n\n(?=\[IMPORTANT: )/)
      .map((block) => block.replace(/^\[IMPORTANT:\s*/, "").replace(/\]$/, ""))
      .filter((block) => !/^\d+ background processes completed\./.test(block));
  } else if (content.startsWith("[ASYNC DELEGATION BATCH COMPLETE")) {
    // Split keeps each header's captures: [preamble, icon, n/m, goal, body, icon, n/m, goal, body, …]. The desktop drops
    // the headers; here each task keeps its number and goal, so the owner can tell which result is which.
    const parts = content.split(TASK_HEADER);
    bodies = [];
    for (let n = 1; n + 3 < parts.length; n += 4) {
      const goal = parts[n + 2]?.replace(/\s+/g, " ").trim();
      bodies.push(`**${parts[n]} Task ${parts[n + 1]}${goal ? `: ${goal}` : ""}**\n\n${parts[n + 3]}`);
    }
  } else if (content.startsWith("[ASYNC DELEGATION")) {
    const result = content.match(/^--- (?:RESULT|ERROR) ---\r?\n/m);
    bodies = result ? [content.slice(result.index! + result[0].length)] : [];
  }
  return bodies.map(cleaned).filter(Boolean).join("\n\n") || undefined;
}

/** A body without a cron job's preamble or the trailing pointer to the subagent's transcript. */
function cleaned(body: string): string {
  const output = body.startsWith("Cron job ") ? body.match(/^--- JOB OUTPUT ---\r?\n/m) : null;
  const result = output ? body.slice(output.index! + output[0].length) : body;
  return result.replace(/\nFull live transcript \(complete tool\/assistant trace\): [^\n]*\n*$/, "").trim();
}

/**
 * The Returned result a stored user row is, or undefined for any other row. If nothing is left once the envelope goes,
 * the body is the whole text, so a result is never lost.
 */
export function returnedItem(text: string, displayKind: unknown, metadata: unknown): Returned | undefined {
  if (typeof displayKind !== "string" || !Object.hasOwn(KINDS, displayKind)) return undefined;
  const shown = displayMetadata(metadata)?.display_text;
  const title = typeof shown === "string" && shown.trim() ? shown.trim() : undefined;
  return { ...(title && { title }), body: resultBody(text) ?? text.trim(), process: KINDS[displayKind] };
}
