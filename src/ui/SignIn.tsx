// Sign-in over SSH (ADR 0003) or straight to a dashboard URL, built from the prototype's first-run screen and its
// connection form.
import { useState } from "react";
import { KeyRound } from "lucide-react";
import type { SignInDetails } from "../hermes/tauriPipe";
import { ServerFields, withHeaders } from "./Onboarding";

export function SignIn({
  initial,
  error,
  onSignIn,
  onSetUp,
}: {
  /** The saved sign-in; the password is filled in when launch couldn't sign in with it. */
  initial: SignInDetails;
  error?: string;
  onSignIn: (d: SignInDetails) => Promise<void>;
  /** Opens setup, to test and save a different connection step by step. */
  onSetUp?: () => void;
}) {
  const [d, setD] = useState<SignInDetails>(initial);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<SignInDetails>) => setD({ ...d, ...patch });
  const ready = (d.mode === "ssh" ? d.sshTarget : d.url).trim() && d.username.trim() && d.password;
  return (
    <div className="first-run">
      <div className="first-run-card">
        <div className="rail-brand big">H</div>
        <h1>Connect to Hermes</h1>
        <p className="muted">Sign in to your Hermes server's dashboard.</p>
        <form
          className="conn-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!ready || busy) return;
            setBusy(true);
            try {
              await onSignIn(withHeaders(d));
            } finally {
              setBusy(false);
            }
          }}
        >
          <ServerFields d={d} set={set} />
          <label className="field">
            <span className="field-label">Dashboard username</span>
            <input value={d.username} onChange={(e) => set({ username: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Dashboard password</span>
            <input type="password" autoFocus value={d.password} onChange={(e) => set({ password: e.target.value })} />
            <span className="field-hint">
              <KeyRound size={12} /> {d.mode === "ssh" ? "Sent to the server through the SSH tunnel." : "Sent to the dashboard at this URL."} Saved
              in your system keyring.
            </span>
          </label>
          {error && <div className="sign-in-error" role="alert">{error}</div>}
          <button className="btn primary" type="submit" disabled={!ready || busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
          {onSetUp && (
            <button type="button" className="link setup-link" disabled={busy} onClick={onSetUp}>
              Set up a different server…
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
