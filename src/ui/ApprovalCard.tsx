// An Approval card: the command Hermes wants to run and the answers it offers. A broader grant asks again first.
import { useState, type MouseEvent } from "react";
import { ShieldAlert } from "lucide-react";
import type { ApprovalChoice, ApprovalItem } from "../hermes/model";
import { isBroadGrant, offeredChoices } from "../hermes/model";

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: "Approve once",
  session: "Allow for this chat…",
  always: "Always allow…",
  deny: "Deny",
};

const ANSWERED_LABEL: Record<ApprovalChoice, string> = {
  once: "Approved once",
  session: "Allowed for this chat",
  always: "Always allowed",
  deny: "Denied",
};

/** Unicode control and format characters, such as bidi overrides and zero-width spaces, except newline and tab. */
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}]/gu;

/** Text from Hermes with its hidden characters written out, so what shows is what runs. */
const visible = (text: string) => text.replace(HIDDEN, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`);

/** How long buttons ignore clicks after they appear, so a click aimed at what was there before doesn't answer. */
const ARM_MS = 400;

/**
 * Wraps a button's action so it runs only on a deliberate click: not the second click of a double click (`detail`
 * counts them; a keyboard press has none), and not within `ARM_MS` of the buttons appearing.
 */
function useDeliberate() {
  const [shownAt] = useState(() => performance.now());
  return (act: () => void) => (e: MouseEvent) => {
    if (e.detail <= 1 && e.timeStamp - shownAt >= ARM_MS) act();
  };
}

/** What a closed card says when Hermes stopped waiting without an answer from this app. */
function endedNote(reason: string): string {
  if (reason === "timeout") return "Timed out without an answer";
  if (reason === "resolved") return "Answered in another Hermes client";
  return "Hermes stopped waiting for an answer";
}

/**
 * Only the answers Hermes offers show. `onAnswer` gets `confirmed` once the owner has confirmed a broader grant. A card
 * takes no focus when it arrives, so typing elsewhere never answers it.
 */
export function ApprovalCard({
  item,
  offline,
  onAnswer,
}: {
  item: ApprovalItem;
  offline: boolean;
  onAnswer: (c: ApprovalChoice, confirmed?: boolean) => void;
}) {
  const [confirming, setConfirming] = useState<ApprovalChoice>();
  const deliberate = useDeliberate();
  const closed = item.answer ?? item.ended;
  const choices = offeredChoices(item);
  return (
    <div className={`approval ${closed ? "answered" : ""}`}>
      <div className="approval-head">
        <ShieldAlert size={15} />
        {item.answer ? ANSWERED_LABEL[item.answer] : item.ended ? endedNote(item.ended) : "Hermes wants to run a command"}
      </div>
      <pre className="approval-cmd">{visible(item.command)}</pre>
      {!closed && (
        <>
          {item.description && <div className="approval-desc">{visible(item.description)}</div>}
          {confirming ? (
            <ConfirmGrant
              item={item}
              choice={confirming}
              offline={offline}
              onConfirm={() => onAnswer(confirming, true)}
              onBack={() => setConfirming(undefined)}
            />
          ) : choices.length ? (
            <div className="approval-actions">
              {choices.map((c) => (
                <button
                  key={c}
                  className={`btn ${c === "once" ? "primary" : ""}`}
                  disabled={offline}
                  onClick={deliberate(() => (isBroadGrant(c) ? setConfirming(c) : onAnswer(c)))}
                >
                  {CHOICE_LABEL[c]}
                </button>
              ))}
            </div>
          ) : (
            <div className="approval-desc">Hermes offered no answer this app can give. It stops waiting on its own.</div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The second step of a broader grant. Its buttons are new elements, so the focus or a double click on the button that
 * opened it can't confirm, and Back takes focus, so a stray Enter goes back.
 */
export function ConfirmGrant({
  item,
  choice,
  offline,
  onConfirm,
  onBack,
}: {
  item: ApprovalItem;
  choice: ApprovalChoice;
  offline: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const deliberate = useDeliberate();
  const what = item.description ? `commands Hermes flags as “${visible(item.description)}”` : "commands like this";
  const always = choice === "always";
  return (
    <div className="approval-confirm">
      <div className="approval-desc">
        {always
          ? `Always allow ${what}? Hermes won't ask again before running them, in any chat.`
          : `Allow ${what} for the rest of this chat? Hermes won't ask again before running them here.`}
      </div>
      <div className="approval-actions">
        <button className="btn danger" disabled={offline} onClick={deliberate(onConfirm)}>
          {always ? "Yes, always allow" : "Yes, allow for this chat"}
        </button>
        <button className="btn" autoFocus onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
