// The Custom snooze dialog (snooze.ts, ADR 0036): snooze a chat until a date and time, or for a while.
import { useEffect, useRef, useState, type RefObject } from "react";
import { AlarmClock } from "lucide-react";
import { DURATION_UNITS, customUntil, nextWake, snoozePresets, wakeFull, type DurationUnit, type Snoozes } from "../hermes/snooze";
import { composing } from "./bits";
import { useModal } from "./modal";

/** setTimeout's longest wait; a snooze further off is checked again after it. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * The time now, for a component that shows what is snoozed: it renders again when the next snooze wakes, and when the
 * window comes back to the front (a timer may have slept with the computer). A wake further off than one timer can
 * wait sets another when the first runs out.
 */
export function useSnoozeClock(snoozes: Snoozes): number {
  const [ticks, tick] = useState(0);
  const now = Date.now();
  const wake = nextWake(snoozes, now);
  useEffect(() => {
    if (wake === undefined) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.min(Math.max(wake - Date.now(), 0) + 50, MAX_TIMEOUT));
    return () => clearTimeout(t);
  }, [wake, ticks]);
  useEffect(() => {
    const back = () => tick((n) => n + 1);
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, []);
  return now;
}

/** A `datetime-local` value for `at`, in local time. */
const localInput = (at: number) => {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Asks when the chat should wake: at a date and time, or after a while. It opens at tomorrow morning. Escape, Cancel
 * or a click outside snoozes nothing. Focus goes back to the chat's row.
 */
export function SnoozeDialog({
  title,
  returnTo,
  onSnooze,
  onClose,
}: {
  title: string;
  returnTo?: RefObject<HTMLElement | null>;
  onSnooze: (until: number) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const [mode, setMode] = useState<"at" | "for">("at");
  const [at, setAt] = useState(() => localInput(snoozePresets(Date.now())[2].until));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<DurationUnit>("hours");
  const [error, setError] = useState<string>();
  const now = Date.now();
  const preview = customUntil(mode === "at" ? { at } : { amount, unit }, now);

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="leave-dialog snooze-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snooze-title"
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e)) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id="snooze-title" className="leave-title">
          <AlarmClock size={14} aria-hidden /> Snooze “{title}”
        </h2>
        <p className="muted small">It leaves the top of the list until then, and comes back on its own. Kept on this computer only.</p>
        <div className="segmented" role="group" aria-label="Snooze by">
          <button type="button" aria-pressed={mode === "at"} onClick={() => setMode("at")}>
            Date and time
          </button>
          <button type="button" aria-pressed={mode === "for"} onClick={() => setMode("for")}>
            Duration
          </button>
        </div>
        <form
          className="snooze-form"
          // The dialog says what's wrong in its own words, rather than the browser's.
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const until = customUntil(mode === "at" ? { at } : { amount, unit }, Date.now());
            if (typeof until === "string") setError(until);
            else onSnooze(until);
          }}
        >
          {mode === "at" ? (
            <label className="snooze-field">
              <span>Wake at</span>
              <input
                type="datetime-local"
                autoFocus
                value={at}
                min={localInput(now)}
                onChange={(e) => {
                  setAt(e.target.value);
                  setError(undefined);
                }}
              />
            </label>
          ) : (
            <div className="snooze-field">
              <label htmlFor="snooze-amount">Snooze for</label>
              <input
                id="snooze-amount"
                type="number"
                min="1"
                step="any"
                inputMode="decimal"
                autoFocus
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError(undefined);
                }}
              />
              <select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as DurationUnit)}>
                {(Object.keys(DURATION_UNITS) as DurationUnit[]).map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="muted small snooze-when" aria-live="polite">
            {typeof preview === "number" ? `Wakes ${wakeFull(preview)}` : " "}
          </p>
          {error && (
            <p className="palette-panel-error" role="alert">
              {error}
            </p>
          )}
          <div className="confirm-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Snooze
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
