// The sign-in method picker and the token field, shared by the sign-in screen and Setup's sign-in step (ADR 0058).
import { useId } from "react";
import { KeyRound } from "lucide-react";
import { isPicked, methodLabel } from "../hermes/signInMethods";
import type { SignInDetails, SignInMethod } from "../hermes/tauriPipe";

/** One button per method, above the fields; shown only when the server offers more than one. */
export function MethodPicker({ list, d, onPick, disabled }: { list: SignInMethod[]; d: SignInDetails; onPick: (m: SignInMethod) => void; disabled?: boolean }) {
  const labelId = useId();
  if (list.length < 2) return null;
  return (
    <div className="field sign-in-methods">
      <span className="field-label" id={labelId}>
        Sign in with
      </span>
      <div className="segmented" role="group" aria-labelledby={labelId}>
        {list.map((m) => (
          <button key={m.method === "token" ? "token" : `password:${m.provider}`} type="button" aria-pressed={isPicked(m, d)} disabled={disabled} onClick={() => onPick(m)}>
            {methodLabel(m, list)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The dashboard's session token, masked, with no autocomplete or spellcheck. What is typed goes to Rust in the connect
 * or test command; a saved token is never shown or read back here.
 */
export function TokenField({ d, set, readOnly, autoFocus }: { d: SignInDetails; set: (patch: Partial<SignInDetails>) => void; readOnly?: boolean; autoFocus?: boolean }) {
  const id = useId();
  const hintId = useId();
  const saved = d.savedToken !== undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Dashboard session token
      </label>
      <input
        id={id}
        type="password"
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-describedby={hintId}
        placeholder={saved ? "Saved in your system keyring" : undefined}
        value={d.token ?? ""}
        readOnly={readOnly}
        onChange={(e) => set({ token: e.target.value })}
      />
      <span className="field-hint block" id={hintId}>
        <KeyRound size={12} /> The value of HERMES_DASHBOARD_SESSION_TOKEN on the server. Sent as a header, never in an address, and saved in your system
        keyring for this connection only.{saved && " Leave it empty to use the saved one."}
      </span>
    </div>
  );
}
