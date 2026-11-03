// Sign-in over SSH (ADR 0003) or straight to a dashboard URL, built from the prototype's first-run screen and its
// connection form. With more than one saved connection (ADR 0025) the recent-connection picker beside the form picks
// which one the form is for; nothing is picked on its own, so with none picked the form waits for the owner.
import { useState } from "react";
import { CircleAlert, KeyRound, Trash2 } from "lucide-react";
import type { SignInDetails } from "../hermes/tauriPipe";
import { type SavedConnection, addressLabel } from "../hermes/connections";
import { explainSignIn } from "../hermes/setup";
import { ServerFields, withHeaders } from "./Onboarding";
import { ConnectionPicker } from "./Connections";

export function SignIn({
  initial,
  error,
  connection,
  connections = [],
  onSignIn,
  onSetUp,
  onPick,
  onRemove,
}: {
  /** The saved sign-in; the password is filled in when launch couldn't sign in with it. */
  initial: SignInDetails;
  error?: string;
  /** The saved connection the form is for; none when the owner hasn't picked one. */
  connection?: SavedConnection;
  /** Every saved connection, most recently used first, for the picker. */
  connections?: SavedConnection[];
  onSignIn: (d: SignInDetails) => Promise<void>;
  /** Opens setup, to test and save a new connection step by step. */
  onSetUp?: () => void;
  /** The owner picked another saved connection in the picker. */
  onPick?: (c: SavedConnection) => void;
  /** Asks to remove the connection the form is for. */
  onRemove?: (c: SavedConnection) => void;
}) {
  const [d, setD] = useState<SignInDetails>(initial);
  const [busy, setBusy] = useState(false);
  // A password filled in from the keyring is for the address it was saved with. Once the address changes it is
  // cleared, as the header values are (ServerFields), so it never goes to another server.
  const [restored, setRestored] = useState(!!initial.password);
  const [cleared, setCleared] = useState(false);
  const set = (patch: Partial<SignInDetails>) => {
    const next = { ...d, ...patch };
    const moved = next.mode !== initial.mode || next.sshTarget.trim() !== initial.sshTarget.trim() || next.url.trim() !== initial.url.trim() || next.username.trim() !== initial.username.trim();
    if (restored && moved && patch.password === undefined) {
      next.password = "";
      setRestored(false);
      setCleared(true);
    }
    setD(next);
  };
  const ready = (d.mode === "ssh" ? d.sshTarget : d.url).trim() && d.username.trim() && d.password;
  const why = error ? explainSignIn(error, d) : undefined;
  const picker = connections.length > 1 || (!connection && connections.length > 0);
  return (
    <div className="first-run">
      <div className={`first-run-card ${picker ? "with-picker" : ""}`}>
        <div className="rail-brand big">H</div>
        <h1>{connection ? `Connect to ${connection.name}` : "Connect to Hermes"}</h1>
        <p className="muted">
          {connection ? (
            <>
              Sign in to the dashboard at <span className="mono">{addressLabel(connection)}</span>.
            </>
          ) : (
            "Pick a saved connection, or set up a new one."
          )}
        </p>
        {picker && onPick && <ConnectionPicker connections={connections} selectedId={connection?.id} onPick={onPick} disabled={busy} />}
        {connection && (
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
                in your system keyring, for this connection only.
              </span>
              {cleared && (
                <span className="field-hint block" role="status">
                  The address changed, so the saved password was cleared. Type the password for this address.
                </span>
              )}
            </label>
            {why && (
              <div className="sign-in-error" role="alert">
                <div>
                  <CircleAlert size={12} /> {why.problem}
                </div>
                {error !== why.problem && <div className="small sign-in-raw">{error}</div>}
                {why.fixes.length > 0 && (
                  <ul className="sign-in-fixes">
                    {why.fixes.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <button className="btn primary" type="submit" disabled={!ready || busy}>
              {busy ? "Connecting…" : "Connect"}
            </button>
            {onRemove && (
              <button type="button" className="link setup-link" disabled={busy} onClick={() => onRemove(connection)}>
                <Trash2 size={12} /> Remove this connection…
              </button>
            )}
          </form>
        )}
        {onSetUp && (
          <button type="button" className="link setup-link" disabled={busy} onClick={onSetUp}>
            {connections.length ? "Set up a new connection…" : "Set up a different server…"}
          </button>
        )}
      </div>
    </div>
  );
}
