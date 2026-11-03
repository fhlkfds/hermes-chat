// Setup: connecting Hermes Chat to a Hermes server, step by step (ADR 0009). It opens by itself on a computer with no
// connection set up, from the sign-in screen to set up a different server, and from Settings to change the connection
// or give Hermes a model provider's key. Nothing is kept until a tested connection is saved.
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, CircleAlert, Globe, KeyRound, Minus, Plus, ShieldAlert, ShieldCheck, Terminal, X } from "lucide-react";
import type { ExtraHeader, SignInDetails } from "../hermes/tauriPipe";
import type { Kept } from "../hermes/account";
import type { Hermes } from "../hermes/transport";
import { STAGES, missing, stageLabel, testConnection, type Probe, type ProviderKey, type ProviderSetup, type TestOutcome } from "../hermes/setup";
import { routeLabel } from "./bits";
import { NAME_MAX, defaultName } from "../hermes/connections";

/**
 * `first-run`: nothing is set up on this computer, so there is nowhere to cancel to; Cancel starts over.
 * `sign-in`: opened from the sign-in screen, to add a connection. `reconfigure`: opened from Settings while signed in,
 * to change the connection in use or add a provider key; the connection in use carries on until the change is tested
 * and saved. `add`: adds another saved connection. `edit`: changes a saved connection (ADR 0025). Both start at the
 * Server step.
 */
export type SetupMode = "first-run" | "sign-in" | "reconfigure" | "add" | "edit";

type Step = "welcome" | "server" | "account" | "providers";
const NUMBERED: Step[] = ["server", "account", "providers"];
const STEP_LABEL: Record<Step, string> = { welcome: "Welcome", server: "Server", account: "Sign in", providers: "Model providers" };

type Test = { state: "idle" } | { state: "testing" } | { state: "done"; outcome: TestOutcome };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Onboarding({
  mode,
  initial,
  initialName = "",
  probe,
  hermes,
  onConnect,
  onCancel,
  onDone,
}: {
  mode: SetupMode;
  /** The sign-in to start from: the one saved, without its password. */
  initial: SignInDetails;
  /** The connection's name, when it has one already. Left empty, it is named after its host. */
  initialName?: string;
  probe: Probe;
  /** The connection in use, once there is one: Settings' own, or the one setup just saved. */
  hermes?: Hermes;
  /**
   * Saves the tested sign-in and connects with it, in place of any connection in use. Rejects with why it couldn't.
   * `notSaved`: why the keyring couldn't keep the password or the extra request headers, when it couldn't, and `kept`
   * which of them it did keep.
   */
  onConnect: (d: SignInDetails, name: string) => Promise<{ notSaved?: string; kept?: Kept }>;
  /** Leaves setup with nothing changed. Absent on first run. */
  onCancel?: () => void;
  /** Leaves setup once a connection is saved. */
  onDone: () => void;
}) {
  const firstStep: Step = mode === "add" || mode === "edit" ? "server" : "welcome";
  const [step, setStep] = useState<Step>(firstStep);
  const [d, setD] = useState<SignInDetails>(initial);
  const [name, setName] = useState(initialName);
  const [test, setTest] = useState<Test>({ state: "idle" });
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string>();
  // The connection setup saved, which the providers step uses; Settings' own one when only adding a key.
  const [saved, setSaved] = useState(false);
  const [notSaved, setNotSaved] = useState<string>();
  // Each test gets the next number, and only the latest one's result counts; stopping one moves the number on, so a
  // late answer from a stopped test can't be taken for the next one's. `testing`: a test is under way in Rust.
  const run = useRef(0);
  const testing = useRef(false);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);

  // A test still running when setup closes is stopped, so its SSH tunnel goes too. Focus goes back to whatever opened
  // setup, such as Settings' Run setup again, if it is still there.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      run.current++;
      if (testing.current) probe.cancel();
      if (opener?.isConnected) opener.focus();
    };
  }, [probe]);
  // Each step announces itself by moving focus to its heading.
  useEffect(() => heading.current?.focus(), [step]);

  const stopTest = () => {
    run.current++;
    if (testing.current) probe.cancel();
    testing.current = false;
    setTest({ state: "idle" });
  };

  const set = (patch: Partial<SignInDetails>) => {
    setD((was) => ({ ...was, ...patch }));
    // A result is for the details it tested, and so is a test under way.
    if (test.state === "testing") stopTest();
    else if (test.state === "done") setTest({ state: "idle" });
    setConnectError(undefined);
  };

  const startTest = async () => {
    if (missing(d).length || test.state === "testing") return;
    const mine = ++run.current;
    testing.current = true;
    setTest({ state: "testing" });
    setConnectError(undefined);
    const outcome = await testConnection(probe, withHeaders(d));
    if (mine !== run.current) return;
    testing.current = false;
    setTest(outcome.ok || outcome.stage !== "cancelled" ? { state: "done", outcome } : { state: "idle" });
  };

  const connect = async () => {
    setConnecting(true);
    setConnectError(undefined);
    try {
      const { notSaved, kept } = await onConnect(withHeaders(d), name);
      setNotSaved(notSaved && `${notSaved.replace(/\.?$/, ".")} ${retypeLater(kept)}`);
      setSaved(true);
      setD((was) => ({ ...was, password: "" }));
      setStep("providers");
    } catch (e) {
      setConnectError(messageOf(e));
    } finally {
      setConnecting(false);
    }
  };

  /** Cancel: leave without changes, or on first run start over, forgetting the password typed. */
  const cancel = () => {
    if (test.state === "testing") stopTest();
    if (onCancel) return onCancel();
    setD({ ...initial, password: "" });
    setName(initialName);
    setTest({ state: "idle" });
    setConnectError(undefined);
    setStep(firstStep);
  };
  // Once a connection is saved there is nothing to cancel: leaving finishes setup.
  const canCancel = !connecting && !saved && (!!onCancel || step !== "welcome");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !canCancel) return;
      e.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const n = NUMBERED.indexOf(step);
  return (
    <div className="setup" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="setup-card">
        <div className="setup-top">
          <div className="rail-brand">H</div>
          {n >= 0 && (
            <ol className="setup-steps" aria-label="Setup steps">
              {NUMBERED.map((s, i) => (
                <li key={s} className={i < n ? "done" : i === n ? "on" : ""} aria-current={i === n ? "step" : undefined}>
                  {STEP_LABEL[s]}
                </li>
              ))}
            </ol>
          )}
          {canCancel && (
            <button className="icon-btn setup-close" aria-label={onCancel ? "Cancel setup" : "Cancel and start over"} title="Cancel" onClick={cancel}>
              <X size={16} />
            </button>
          )}
        </div>

        {step === "welcome" && (
          <Welcome
            titleId={titleId}
            heading={heading}
            mode={mode}
            canAddKey={!!hermes}
            onStart={() => setStep("server")}
            onAddKey={() => setStep("providers")}
            onCancel={onCancel}
          />
        )}

        {step === "server" && (
          <form
            className="setup-body conn-form"
            onSubmit={(e) => {
              e.preventDefault();
              if ((d.mode === "ssh" ? d.sshTarget : d.url).trim()) setStep("account");
            }}
          >
            <h1 id={titleId} ref={heading} tabIndex={-1}>
              {mode === "edit" ? `Edit ${initialName || "the connection"}` : mode === "add" ? "Add a connection" : "Where is your Hermes server?"}
            </h1>
            <p className="muted">
              Hermes Chat talks to the Hermes dashboard running on your server.
              {(mode === "add" || mode === "edit") && " The connection in use carries on until this one is tested and saved."}
            </p>
            <Field label="Name" hint="Shown in the connection list. Two connections can share a name; their addresses tell them apart.">
              {(a) => (
                <input {...a} value={name} maxLength={NAME_MAX} placeholder={defaultName(d)} spellCheck={false} onChange={(e) => setName(e.target.value)} />
              )}
            </Field>
            <ServerFields d={d} set={set} />
            <div className="setup-actions">
              <button type="button" className="btn" onClick={() => (firstStep === "server" ? cancel() : setStep("welcome"))}>
                {firstStep === "server" ? "Cancel" : "Back"}
              </button>
              <button type="submit" className="btn primary" disabled={!(d.mode === "ssh" ? d.sshTarget : d.url).trim()}>
                Next
              </button>
            </div>
          </form>
        )}

        {step === "account" && (
          <form
            className="setup-body conn-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (test.state === "done" && test.outcome.ok) void connect();
              else void startTest();
            }}
          >
            <h1 id={titleId} ref={heading} tabIndex={-1}>
              Sign in to the dashboard
            </h1>
            <p className="muted">
              {d.mode === "ssh" ? (
                <>
                  Through <span className="mono">ssh://{d.sshTarget.trim()}</span>.
                </>
              ) : (
                <>
                  At <span className="mono">{d.url.trim()}</span>.
                </>
              )}{" "}
              This is the Hermes dashboard's own login, not your SSH or computer password.
            </p>
            <Field label="Dashboard username">
              {(a) => (
                <input
                  {...a}
                  value={d.username}
                  autoComplete="username"
                  spellCheck={false}
                  readOnly={test.state === "testing" || connecting}
                  onChange={(e) => set({ username: e.target.value })}
                />
              )}
            </Field>
            <Field
              label="Dashboard password"
              hint={
                <>
                  <KeyRound size={12} /> Saved in your system keyring once the connection works.
                </>
              }
            >
              {(a) => (
                <input
                  {...a}
                  type="password"
                  autoComplete="current-password"
                  value={d.password}
                  readOnly={test.state === "testing" || connecting}
                  onChange={(e) => set({ password: e.target.value })}
                />
              )}
            </Field>

            <div aria-live="polite">
              {test.state === "testing" && (
                <div className="setup-testing">
                  <span className="spinner" aria-hidden /> Testing the connection…
                </div>
              )}
              {test.state === "done" && <TestResult outcome={test.outcome} mode={d.mode} />}
              {connectError && (
                <div className="sign-in-error" role="alert">
                  The test passed, but connecting failed: {connectError}
                </div>
              )}
            </div>

            <div className="setup-actions">
              <button type="button" className="btn" disabled={connecting} onClick={() => (test.state === "testing" ? stopTest() : setStep("server"))}>
                {test.state === "testing" ? "Stop test" : "Back"}
              </button>
              {test.state === "done" && test.outcome.ok ? (
                <>
                  <button type="button" className="btn" disabled={connecting} onClick={() => void startTest()}>
                    Test again
                  </button>
                  <button type="submit" className="btn primary" disabled={connecting}>
                    {connecting ? "Connecting…" : connectError ? "Try again" : "Save and connect"}
                  </button>
                </>
              ) : (
                <button type="submit" className="btn primary" disabled={!!missing(d).length || test.state === "testing"}>
                  {test.state === "done" ? "Try again" : "Test connection"}
                </button>
              )}
            </div>
          </form>
        )}

        {step === "providers" && hermes && (
          <ProviderKeys
            titleId={titleId}
            heading={heading}
            hermes={hermes}
            notSaved={notSaved}
            onDone={saved ? onDone : (onCancel ?? onDone)}
            doneLabel={saved ? "Finish" : "Done"}
          />
        )}
      </div>
    </div>
  );
}

function Welcome({
  titleId,
  heading,
  mode,
  canAddKey,
  onStart,
  onAddKey,
  onCancel,
}: {
  titleId: string;
  heading: RefObject<HTMLHeadingElement | null>;
  mode: SetupMode;
  canAddKey: boolean;
  onStart: () => void;
  onAddKey: () => void;
  onCancel?: () => void;
}) {
  return (
    <div className="setup-body">
      <h1 id={titleId} ref={heading} tabIndex={-1}>
        {mode === "first-run" ? "Welcome to Hermes Chat" : "Set up Hermes Chat"}
      </h1>
      <p className="muted">
        Hermes Chat is a desktop app for your own Hermes Agent server. {mode === "reconfigure" ? "You can change the connection in use, or give Hermes a model provider's API key." : "Let's connect it."}
      </p>
      <div className="setup-need">
        <div className="setup-need-title">You'll need</div>
        <ul>
          <li>
            <Terminal size={13} /> An SSH login to the server that works without a prompt,
            <br />
            <Globe size={13} /> <em>or</em> the dashboard's URL, such as <span className="mono">http://hermes:9119</span>
          </li>
          <li>
            <KeyRound size={13} /> The Hermes dashboard's username and password
          </li>
        </ul>
        <p className="muted small">Hermes Chat tests the connection before it saves anything.</p>
      </div>
      <div className="setup-actions">
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        {canAddKey && mode === "reconfigure" && (
          <button className="btn" onClick={onAddKey}>
            Add a provider key
          </button>
        )}
        <button className="btn primary" onClick={onStart}>
          {mode === "reconfigure" ? "Change connection" : "Get started"}
        </button>
      </div>
    </div>
  );
}

/** The SSH or URL choice and its field, shared with the sign-in screen. */
/** What the owner types again because the keyring couldn't keep it. */
function retypeLater(kept: Kept = { password: false, headers: true }): string {
  if (!kept.password && !kept.headers) return "You'll type the password and the extra request headers again at the next launch.";
  if (!kept.headers) return "You'll type the extra request headers again at the next sign-in.";
  return "You'll type the password again at the next launch.";
}

/** The owner's extra request headers without the rows left blank; Rust checks the rest (ADR 0006). */
export const withHeaders = (d: SignInDetails): SignInDetails =>
  d.mode === "url" ? { ...d, headers: (d.headers ?? []).filter((h) => h.name.trim() || h.value.trim()) } : d;

/** Where the dashboard is: an SSH target, or a URL with any extra request headers. Shared with the sign-in screen. */
export function ServerFields({ d, set }: { d: SignInDetails; set: (patch: Partial<SignInDetails>) => void }) {
  const headers = d.headers ?? [];
  const setHeader = (i: number, patch: Partial<ExtraHeader>) => set({ headers: headers.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
  // Header values filled in from the keyring belong to the URL they were saved for (account.ts). Once the URL is
  // changed, they are cleared, names kept, so a gateway's secrets never go to another server.
  const [restoredFor, setRestoredFor] = useState(() => (d.headers?.some((h) => h.value) ? d.url.trim() : undefined));
  const [cleared, setCleared] = useState(false);
  const setUrl = (url: string) => {
    if (restoredFor === undefined || url.trim() === restoredFor) return set({ url });
    set({ url, headers: headers.map((h) => ({ ...h, value: "" })) });
    setRestoredFor(undefined);
    setCleared(true);
  };
  return (
    <>
      <div className="seg" role="group" aria-label="Connect through">
        <button type="button" className={d.mode === "ssh" ? "on" : ""} aria-pressed={d.mode === "ssh"} onClick={() => set({ mode: "ssh" })}>
          SSH
        </button>
        <button type="button" className={d.mode === "url" ? "on" : ""} aria-pressed={d.mode === "url"} onClick={() => set({ mode: "url" })}>
          URL
        </button>
      </div>
      {d.mode === "ssh" ? (
        <Field
          key="ssh"
          label="SSH target"
          block
          hint={
            <>
              <Terminal size={12} /> A user and host, or an alias from <code>~/.ssh/config</code>. Uses your ssh-agent; the key must work without
              a prompt. Hermes Chat reaches the dashboard on the server's port 9119.
            </>
          }
        >
          {(a) => <input {...a} value={d.sshTarget} onChange={(e) => set({ sshTarget: e.target.value })} placeholder="liam@hermes" spellCheck={false} />}
        </Field>
      ) : (
        <>
          <Field
            key="url"
            label="Dashboard URL"
            block
            hint={
              <>
                <Globe size={12} /> <code>http://</code> isn't encrypted unless it stays on this computer or on Tailscale.
              </>
            }
          >
            {(a) => <input {...a} value={d.url} onChange={(e) => setUrl(e.target.value)} placeholder="http://hermes:9119" spellCheck={false} />}
          </Field>
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
              <ShieldCheck size={12} /> For a gateway in front of the dashboard, such as Cloudflare Access. Sent with every request to this URL, never
              to another site. Saved in your system keyring.
            </span>
          </fieldset>
        </>
      )}
    </>
  );
}

/** A labelled control with its hint. The hint describes the control rather than naming it. */
function Field({
  label,
  hint,
  block = false,
  children,
}: {
  label: string;
  hint?: ReactNode;
  block?: boolean;
  children: (a: { id: string; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children({ id, "aria-describedby": hint ? `${id}-hint` : undefined })}
      {hint && (
        <span id={`${id}-hint`} className={`field-hint${block ? " block" : ""}`}>
          {hint}
        </span>
      )}
    </div>
  );
}

function TestResult({ outcome, mode }: { outcome: TestOutcome; mode: SignInDetails["mode"] }) {
  const failedAt = outcome.ok ? STAGES.length : STAGES.indexOf(outcome.stage as (typeof STAGES)[number]);
  return (
    <div className={`setup-result ${outcome.ok ? "ok" : "bad"}`} role={outcome.ok ? "status" : "alert"}>
      <ul className="setup-checks">
        {STAGES.map((s, i) => {
          const state = i < failedAt ? "ok" : i === failedAt ? "bad" : "skip";
          return (
            <li key={s} className={state}>
              {state === "ok" ? <Check size={13} aria-label="Passed" /> : state === "bad" ? <X size={13} aria-label="Failed" /> : <Minus size={13} aria-label="Not tried" />}
              {stageLabel(s, mode)}
            </li>
          );
        })}
      </ul>
      {outcome.ok ? (
        <>
          <p className="setup-verdict">
            <Check size={14} /> Connected to Hermes{outcome.version ? ` ${outcome.version}` : ""} at <span className="mono">{routeLabel(outcome.route)}</span>.
          </p>
          {outcome.unsecure && (
            <p className="setup-warn">
              <ShieldAlert size={14} /> <span className="badge warn">Unsecure</span> Traffic to this server isn't encrypted, so the password and your
              chats can be read on the way. Connect over SSH, Tailscale or <code>https://</code> to fix that.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="setup-verdict">
            <CircleAlert size={14} /> {outcome.problem}
          </p>
          {outcome.fixes.length > 0 && (
            <ul className="setup-fixes">
              {outcome.fixes.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {outcome.detail && <p className="setup-detail mono">{outcome.detail}</p>}
        </>
      )}
    </div>
  );
}

/** The providers step: which providers Hermes can use now, and a key for another, saved on the server. */
function ProviderKeys({
  titleId,
  heading,
  hermes,
  notSaved,
  onDone,
  doneLabel,
}: {
  titleId: string;
  heading: RefObject<HTMLHeadingElement | null>;
  hermes: Hermes;
  /** Why the keyring couldn't keep what setup just saved, and what to type again because of it. */
  notSaved?: string;
  onDone: () => void;
  doneLabel: string;
}) {
  const [setup, setSetup] = useState<ProviderSetup>();
  const [loadError, setLoadError] = useState<string>();
  const [chosen, setChosen] = useState<string>();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  const load = () =>
    hermes.providerSetup().then(
      (s) => {
        setSetup(s);
        setLoadError(undefined);
        setChosen((c) => c ?? (s.keys.find((k) => !k.isSet) ?? s.keys[0])?.provider);
      },
      (e) => setLoadError(messageOf(e)),
    );
  useEffect(() => void load(), [hermes]);

  const pick: ProviderKey | undefined = setup?.keys.find((k) => k.provider === chosen);
  const save = async () => {
    if (!pick || !key.trim() || saving) return;
    setSaving(true);
    setResult(undefined);
    try {
      const r = await hermes.saveProviderKey(pick.envVar, key);
      setKey("");
      setResult({
        ok: true,
        text: r.verified
          ? `Saved. ${pick.label} accepted the key.`
          : `Saved, but Hermes couldn't check the key with ${pick.label}. If it's wrong, ${pick.label} will turn down Hermes's first request.`,
      });
    } catch (e) {
      setResult({ ok: false, text: `Not saved: ${messageOf(e)}` });
      return;
    } finally {
      setSaving(false);
    }
    // Read again to show the key as saved; Finish doesn't wait for it.
    void load();
  };

  let body: ReactNode;
  if (loadError)
    body = (
      <div className="sign-in-error" role="alert">
        Couldn't read the providers from Hermes: {loadError}{" "}
        <button type="button" className="link" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  else if (!setup)
    body = (
      <div className="setup-testing">
        <span className="spinner" aria-hidden /> Asking Hermes…
      </div>
    );
  else
    body = (
      <>
        <p className={setup.ready.length ? "setup-ok" : "setup-warn"}>
          {setup.ready.length ? <Check size={14} /> : <CircleAlert size={14} />}{" "}
          {setup.ready.length
            ? `Hermes can already use ${setup.ready.join(", ")}. You're ready to chat; a key for another provider is optional.`
            : "Hermes doesn't list a model provider it can use yet. Add a key to start chatting."}
        </p>
        {setup.unsupported || !setup.keys.length ? (
          <p className="muted small">
            This Hermes server doesn't let Hermes Chat set provider keys{setup.unsupported ? ` (${setup.unsupported})` : ""}. Set them on the server
            instead, for example on the dashboard's Keys page.
          </p>
        ) : (
          <>
            <Field label="Provider">
              {(a) => (
                <select
                  {...a}
                  value={chosen ?? ""}
                  onChange={(e) => {
                    setChosen(e.target.value);
                    setResult(undefined);
                  }}
                >
                  {setup.keys.map((k) => (
                    <option key={k.provider} value={k.provider}>
                      {k.label}
                      {k.isSet ? " (key saved)" : ""}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              label="API key"
              block
              hint={
                <>
                  <KeyRound size={12} /> Checked with the provider, then saved by Hermes in the <span className="mono">{hermes.profile}</span> profile's{" "}
                  <code>.env</code> on the server. Hermes Chat doesn't keep it.
                  {pick?.isSet && pick.preview ? (
                    <>
                      {" "}
                      Saved now: <code>{pick.preview}</code>.
                    </>
                  ) : null}
                  {pick?.url ? (
                    <>
                      {" "}
                      Get a key at <span className="mono">{pick.url}</span>.
                    </>
                  ) : null}
                </>
              }
            >
              {(a) => (
                <input
                  {...a}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setResult(undefined);
                  }}
                  placeholder={pick?.isSet ? "Paste a new key to replace the saved one" : "Paste the key"}
                />
              )}
            </Field>
            {result && (
              <div className={result.ok ? "setup-ok" : "sign-in-error"} role={result.ok ? "status" : "alert"}>
                {result.text}
              </div>
            )}
            <p className="muted small">Providers you sign in to with an account, such as Nous Portal, are set up on the server.</p>
          </>
        )}
      </>
    );

  return (
    <form
      className="setup-body conn-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h1 id={titleId} ref={heading} tabIndex={-1}>
        Model providers
      </h1>
      <p className="muted">Hermes needs an API key for at least one model provider to answer.</p>
      {notSaved && (
        <p className="setup-warn" role="status">
          <CircleAlert size={14} /> Connected. {notSaved}
        </p>
      )}
      {body}
      <div className="setup-actions">
        {setup && !setup.unsupported && setup.keys.length > 0 && (
          <button type="submit" className="btn" disabled={!pick || !key.trim() || saving}>
            {saving ? "Checking…" : "Check and save key"}
          </button>
        )}
        <button type="button" className="btn primary" disabled={saving} onClick={onDone}>
          {doneLabel}
        </button>
      </div>
    </form>
  );
}
