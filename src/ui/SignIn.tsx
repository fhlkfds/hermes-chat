// Sign-in over SSH (ADR 0003) or straight to a dashboard URL, built from the prototype's first-run screen and its
// connection form.
import { useState } from "react";
import { Globe, KeyRound, Plus, ShieldCheck, Terminal, X } from "lucide-react";
import type { ExtraHeader, SignInDetails } from "../hermes/tauriPipe";

export function SignIn({
  initial,
  error,
  onSignIn,
}: {
  /** The saved sign-in; the password is filled in when launch couldn't sign in with it. */
  initial: SignInDetails;
  error?: string;
  onSignIn: (d: SignInDetails) => Promise<void>;
}) {
  const [d, setD] = useState<SignInDetails>(initial);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<SignInDetails>) => setD({ ...d, ...patch });
  const ready = (d.mode === "ssh" ? d.sshTarget : d.url).trim() && d.username.trim() && d.password;
  const headers = d.headers ?? [];
  const setHeader = (i: number, patch: Partial<ExtraHeader>) => set({ headers: headers.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
  // Header values filled in from the keyring belong to the URL they were saved for (account.ts). Once the URL is
  // changed, they are cleared, names kept, so a gateway's secrets never go to another server.
  const [restoredFor, setRestoredFor] = useState(initial.headers?.some((h) => h.value) ? initial.url.trim() : undefined);
  const [cleared, setCleared] = useState(false);
  const setUrl = (url: string) => {
    if (restoredFor === undefined || url.trim() === restoredFor) return set({ url });
    set({ url, headers: headers.map((h) => ({ ...h, value: "" })) });
    setRestoredFor(undefined);
    setCleared(true);
  };
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
              // Rows left blank are dropped; Rust checks the rest.
              await onSignIn({ ...d, headers: headers.filter((h) => h.name.trim() || h.value.trim()) });
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="seg" role="group" aria-label="Connect through">
            <button type="button" className={d.mode === "ssh" ? "on" : ""} onClick={() => set({ mode: "ssh" })}>
              SSH
            </button>
            <button type="button" className={d.mode === "url" ? "on" : ""} onClick={() => set({ mode: "url" })}>
              URL
            </button>
          </div>
          {d.mode === "ssh" ? (
            <label className="field">
              <span className="field-label">SSH target</span>
              <input value={d.sshTarget} onChange={(e) => set({ sshTarget: e.target.value })} placeholder="liam@hermes" />
              <span className="field-hint block">
                <Terminal size={12} /> Uses your <code>~/.ssh/config</code> and ssh-agent. The key must work without a prompt.
              </span>
            </label>
          ) : (
            <label className="field">
              <span className="field-label">Dashboard URL</span>
              <input value={d.url} onChange={(e) => setUrl(e.target.value)} placeholder="http://hermes:9119" />
              <span className="field-hint block">
                <Globe size={12} /> <code>http://</code> isn't encrypted unless it stays on this computer or on Tailscale.
              </span>
            </label>
          )}
          {d.mode === "url" && (
            <fieldset className="field extra-headers">
              <legend className="field-label">Extra request headers</legend>
              {headers.map((h, i) => (
                <div className="header-row" key={i}>
                  <input
                    aria-label={`Header ${i + 1} name`}
                    placeholder="CF-Access-Client-Id"
                    spellCheck={false}
                    autoComplete="off"
                    value={h.name}
                    onChange={(e) => setHeader(i, { name: e.target.value })}
                  />
                  <input
                    aria-label={`Header ${i + 1} value`}
                    type="password"
                    placeholder="Value"
                    autoComplete="off"
                    value={h.value}
                    onChange={(e) => setHeader(i, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove header ${i + 1}`}
                    title="Remove"
                    onClick={() => set({ headers: headers.filter((_, j) => j !== i) })}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button type="button" className="btn add-header" onClick={() => set({ headers: [...headers, { name: "", value: "" }] })}>
                <Plus size={14} /> Add header
              </button>
              {cleared && headers.length > 0 && (
                <span className="field-hint block" role="status">
                  The URL changed, so the saved header values were cleared. Enter them for this URL.
                </span>
              )}
              <span className="field-hint block">
                <ShieldCheck size={12} /> For a gateway in front of the dashboard, such as Cloudflare Access. Sent with every request to this URL,
                never to another site. Saved in your system keyring.
              </span>
            </fieldset>
          )}
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
        </form>
      </div>
    </div>
  );
}
