// Asking before an unsaved edit in Settings → Memory is dropped: by leaving Settings, opening a chat, switching
// profile, signing out, or closing the window (MemorySettings.tsx). The edit lives only on screen, so it would be lost.
import { useEffect, useId } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle } from "lucide-react";

/** The question, over the whole window. Keep editing has focus, so a stray Enter keeps the edit; Escape keeps it too. */
export function LeaveMemoryEdit({ profile, onStay, onDiscard }: { profile: string; onStay: () => void; onDiscard: () => void }) {
  const noteId = useId();
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onStay()}>
      <div
        className="leave-dialog confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label="Discard your memory edit?"
        aria-describedby={noteId}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onStay();
          }
        }}
      >
        <span className="confirm-msg">
          <AlertTriangle size={13} /> Discard your memory edit?
        </span>
        <span id={noteId}>
          You have an edit to the <span className="mono">{profile}</span> profile's memory that isn't saved to Hermes. Leaving now drops it.
        </span>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onStay}>
            Keep editing
          </button>
          <button className="btn danger" onClick={onDiscard}>
            Discard edit
          </button>
        </div>
      </div>
    </div>
  );
}

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * While `unsaved`, closing the window asks first (`ask` runs with what closes it), and so does reloading the page in a
 * browser. Listening only then leaves an ordinary close to Tauri itself.
 */
export function useCloseGuard(unsaved: boolean, ask: (close: () => void) => void) {
  useEffect(() => {
    if (!unsaved) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    let unlisten: (() => void) | undefined;
    let gone = false;
    if (inTauri()) {
      const win = getCurrentWindow();
      void win
        .onCloseRequested((e) => {
          e.preventDefault();
          ask(() => void win.destroy());
        })
        .then((stop) => (gone ? stop() : (unlisten = stop)));
    }
    return () => {
      gone = true;
      window.removeEventListener("beforeunload", onUnload);
      unlisten?.();
    };
  }, [unsaved]);
}
