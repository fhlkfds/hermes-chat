// Settings → Toolsets: which toolsets Hermes offers the model, for the profile shown, as Hermes has them on the server.
// A switch changes one toolset for the whole profile; it is checked against a fresh read first and shown as saved only
// once Hermes reads it back that way. Reads and writes: toolsets.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { UnsupportedServerError, changeableName, type Toolset, type ToolsetChange, type ToolsetList, type ToolsetsApi, type WriteSupport } from "../hermes/toolsets";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const onOff = (on: boolean) => (on ? "on" : "off");
const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** What happened to the latest change of one toolset, under its row. `unsettled`: a later read settles it. */
type Note = { tone: "ok" | "warn" | "error"; text: string; unsettled?: boolean };
/** The change on its way: `checking` reads whether turning it on may start an install, before anything is sent. */
type Saving = { name: string; enabled: boolean; phase: "checking" | "saving" };

/** The note a change's outcome leaves under the toolset's row. */
function noteFor(t: Toolset, enabled: boolean, r: ToolsetChange): Note {
  const now = r.list?.toolsets.find((x) => x.name === t.name)?.enabled;
  switch (r.kind) {
    case "saved":
      return {
        tone: r.warning ? "warn" : "ok",
        text:
          (r.warning ? `Hermes answered with an error (${r.warning}), but reads ${t.label} back as ${onOff(enabled)}.` : `Saved: Hermes reads ${t.label} back as ${onOff(enabled)}.`) +
          " Chats Hermes starts from now use it." +
          (r.installing ? ` Hermes also started installing ${r.installing} on the server for it, in the background.` : ""),
      };
    case "conflict":
      return r.now === undefined
        ? { tone: "warn", text: `Not changed: Hermes no longer lists ${t.label}.` }
        : { tone: "warn", text: `Not changed: ${t.label} was turned ${onOff(r.now)} elsewhere since this list was read. It shows as Hermes has it now.` };
    case "rejected":
      return {
        tone: "error",
        text: `Hermes didn't make the change (${r.reason}). ${now === undefined ? `It was ${onOff(t.enabled)} before.` : `It reads ${t.label} back as ${onOff(now)}.`}`,
      };
    case "mismatch":
      return {
        tone: "error",
        text:
          `Hermes took the change but reads ${t.label} back as ${onOff(now ?? !enabled)}. Something else in the profile's settings, ` +
          "such as agent.disabled_toolsets, decides it. Check it with hermes tools on the server.",
      };
    case "unknown":
      return {
        tone: "warn",
        unsettled: true,
        text:
          `Hermes didn't confirm the change (${r.reason}), so it may or may not have it. ` +
          (now === undefined ? "It's read again when Hermes is back; Refresh to check sooner." : `Read back just now, ${t.label} is ${onOff(now)}. Refresh to check again.`),
      };
  }
}

function ToolsetRow({
  t,
  write,
  connected,
  saving,
  note,
  onToggle,
}: {
  t: Toolset;
  write?: WriteSupport;
  connected: boolean;
  saving?: Saving;
  note?: Note;
  onToggle: (t: Toolset) => void;
}) {
  const id = `toolset-${t.name}`;
  const mine = saving?.name === t.name;
  const canSwitch = write?.ok === true && changeableName(t.name);
  return (
    <div className="toolset-row" aria-busy={mine || undefined}>
      <div className="toolset-head">
        <div className="toolset-label">
          <div className="appearance-title" id={`${id}-label`}>
            {t.label}
            {t.platform !== "cli" && <span className="badge">{t.platformLabel} only</span>}
            {!t.configured && <span className="badge warn">Needs setup</span>}
          </div>
          {/* Plugin toolsets can describe themselves at length: two lines here, all of it on hover. */}
          <div className="muted small toolset-desc" id={`${id}-desc`} title={t.description || undefined}>
            {t.description || t.tools.join(", ")}
          </div>
        </div>
        {canSwitch ? (
          <button
            className="switch"
            role="switch"
            aria-checked={t.enabled}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-desc`}
            disabled={!connected || saving !== undefined}
            onClick={() => onToggle(t)}
          >
            <span className="switch-knob" />
          </button>
        ) : (
          <span className={`badge ${t.enabled ? "" : "off"}`} aria-label={`${t.label} is ${onOff(t.enabled)}`}>
            {t.enabled ? "On" : "Off"}
          </span>
        )}
      </div>
      {t.platform !== "cli" && <div className="muted small toolset-hint">Changes Hermes's {t.platformLabel} chats, not this app's.</div>}
      {t.configOnly && (
        <div className="muted small toolset-hint">A setting with no tools of its own: it turns speech-to-text on or off for the profile, Dictation in this app included.</div>
      )}
      {!t.configured && (
        <div className="muted small toolset-hint">
          Its provider or API key isn't set up on the server, so its tools may not be offered even while it's on. Set it up with{" "}
          <span className="mono">hermes tools</span> there.
        </div>
      )}
      {write?.ok && !changeableName(t.name) && <div className="muted small toolset-hint">This app can't send its name to Hermes, so it can't change it.</div>}
      {mine && (
        <div className="small muted toolset-hint" role="status">
          {saving.phase === "checking" ? `Checking what turning ${t.label} on needs…` : `Saving: turning ${t.label} ${onOff(saving.enabled)}…`}
        </div>
      )}
      {!mine && note && (
        <div className={`small toolset-hint ${note.tone === "error" ? "sign-in-error" : note.tone === "warn" ? "warn-note" : "muted"}`} role={note.tone === "ok" ? "status" : "alert"}>
          {note.text}
        </div>
      )}
    </div>
  );
}

export function ToolsetSettings({
  api,
  profile,
  connected,
  runningReplies = 0,
}: {
  api: ToolsetsApi;
  profile: string;
  connected: boolean;
  /** Chats of this profile with a reply running now. */
  runningReplies?: number;
}) {
  const [list, setList] = useState<ToolsetList>();
  const [write, setWrite] = useState<WriteSupport>();
  const [loadError, setLoadError] = useState<string>();
  const [unsupported, setUnsupported] = useState<string>();
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState<Saving>();
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [ask, setAsk] = useState<{ t: Toolset; installs: string[] }>();
  /** A change whose outcome is unknown: the list is read again once Hermes is back. */
  const [reread, setReread] = useState(false);
  // Synchronous guards: state updates land after a second click could.
  const busy = useRef(false);
  const live = useRef(true);
  const shownList = useRef<ToolsetList | undefined>(undefined);
  shownList.current = list;
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  /** Reads the list, and whether Hermes takes changes, for this component's profile. */
  const read = useCallback(
    async (probe: boolean) => {
      if (busy.current) return;
      busy.current = true;
      setReading(true);
      try {
        const [fresh, support] = await Promise.all([
          api.list(profile),
          probe ? api.writeSupport(profile).catch((e): WriteSupport => ({ ok: false, reason: `Couldn't check whether Hermes takes changes: ${messageOf(e)}` })) : undefined,
        ]);
        if (!live.current) return;
        // A note about a toolset that has changed since (elsewhere) no longer describes it, and an unconfirmed change is
        // settled by this read: the switch shows what Hermes has.
        const before = new Map(shownList.current?.toolsets.map((t) => [t.name, t.enabled]));
        const moved = new Set(fresh.toolsets.filter((t) => before.has(t.name) && before.get(t.name) !== t.enabled).map((t) => t.name));
        setNotes((n) => Object.fromEntries(Object.entries(n).filter(([name, note]) => !moved.has(name) && !note.unsettled)));
        setList(fresh);
        if (support) setWrite(support);
        setLoadError(undefined);
        setUnsupported(undefined);
        setReread(false);
      } catch (e) {
        if (!live.current) return;
        if (e instanceof UnsupportedServerError) setUnsupported(e.message);
        else setLoadError(messageOf(e));
      } finally {
        busy.current = false;
        if (live.current) setReading(false);
      }
    },
    [api, profile],
  );

  // The first read, again on reconnecting (another client may have changed it meanwhile), and after an unknown outcome.
  const wasConnected = useRef(false);
  useEffect(() => {
    const back = connected && !wasConnected.current;
    wasConnected.current = connected;
    if (back) void read(true);
  }, [connected, read]);
  useEffect(() => {
    if (connected && reread) void read(false);
  }, [connected, reread, read]);
  // Coming back to the window reads it again, for changes made elsewhere meanwhile.
  useEffect(() => {
    const onFocus = () => connected && list && void read(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [connected, list, read]);

  const commit = async (t: Toolset, enabled: boolean) => {
    setSaving({ name: t.name, enabled, phase: "saving" });
    let note: Note;
    try {
      const r = await api.set(profile, t.name, enabled, t.enabled);
      if (!live.current) return;
      // Every outcome but a lost answer carries the list as Hermes has it after the attempt.
      if (r.list) setList(r.list);
      if (r.kind === "unknown" && !r.list) setReread(true);
      note = noteFor(t, enabled, r);
    } catch (e) {
      if (!live.current) return;
      // The read before the change failed: nothing was sent.
      note = { tone: "error", text: `Nothing changed: couldn't read ${t.label} from Hermes first: ${messageOf(e)}` };
    }
    setNotes((n) => ({ ...n, [t.name]: note }));
  };

  const toggle = async (t: Toolset) => {
    if (busy.current || !connected) return;
    busy.current = true;
    setAsk(undefined);
    setNotes(({ [t.name]: _gone, ...rest }) => rest);
    const enabled = !t.enabled;
    try {
      if (enabled && !t.configOnly) {
        setSaving({ name: t.name, enabled, phase: "checking" });
        const installs = await api.pendingInstalls(profile, t.name);
        if (!live.current) return;
        if (installs?.length) return setAsk({ t, installs });
      }
      await commit(t, enabled);
    } finally {
      busy.current = false;
      if (live.current) setSaving(undefined);
    }
  };

  const confirmInstall = async (t: Toolset) => {
    if (busy.current || !connected) return;
    busy.current = true;
    setAsk(undefined);
    try {
      await commit(t, true);
    } finally {
      busy.current = false;
      if (live.current) setSaving(undefined);
    }
  };

  const intro = (
    <>
      <h2>Toolsets</h2>
      <p className="muted">
        Which tools Hermes offers the model in the <span className="mono">{profile}</span> profile. Hermes keeps this choice on the server, in the profile's
        settings, so the command line, the TUI and the Hermes desktop app use it too. It is the same for every chat in the profile.
      </p>
      <p className="muted small toolset-scope">
        <strong>When it takes effect:</strong> in chats Hermes starts after the change. A chat Hermes already has open, and a reply running in it, keeps the
        tools it started with.
      </p>
      <p className="muted small toolset-scope">
        <ShieldCheck size={12} /> Toolsets aren't Approvals. Turning one on doesn't change which commands Hermes asks about before running them, or YOLO.
      </p>
    </>
  );

  if (unsupported || !list) {
    return (
      <section>
        {intro}
        <div className="settings-row">
          <div className={`small ${loadError ? "sign-in-error" : unsupported ? "warn-note" : "muted"}`} role={loadError || unsupported ? "alert" : "status"}>
            {unsupported ?? (loadError ? `Couldn't read the toolsets: ${loadError}` : connected ? "Reading the toolsets from Hermes…" : "Connect to Hermes to see the profile's toolsets.")}
          </div>
          {(loadError || unsupported) && connected && (
            <button className="btn" disabled={reading} onClick={() => void read(true)}>
              Try again
            </button>
          )}
        </div>
      </section>
    );
  }

  const here = list.toolsets.filter((t) => t.platform === "cli");
  const elsewhere = list.toolsets.filter((t) => t.platform !== "cli");
  const row = (t: Toolset) => (
    <ToolsetRow key={t.name} t={t} write={write} connected={connected} saving={saving} note={notes[t.name]} onToggle={(x) => void toggle(x)} />
  );

  return (
    <section>
      {intro}
      {runningReplies > 0 && (
        <p className="small warn-note toolset-scope" role="status">
          <TriangleAlert size={12} /> A reply is running in {runningReplies === 1 ? "a chat" : `${runningReplies} chats`} of this profile. A change here doesn't
          reach {runningReplies === 1 ? "it" : "them"}.
        </p>
      )}
      {!connected && (
        <p className="small warn-note toolset-scope" role="status">
          Not connected to Hermes. This is what Hermes had at {timeOf(list.readAt)}; it can't be changed until Hermes is back.
        </p>
      )}
      {write && !write.ok && (
        <p className="small warn-note toolset-scope" role="status">
          {write.reason} Each toolset shows whether it's on.
        </p>
      )}
      <div className="settings-row toolset-status">
        <div className="muted small" role="status">
          {reading ? "Reading the toolsets from Hermes…" : loadError ? null : `Read from Hermes at ${timeOf(list.readAt)}.`}
          {loadError && <span className="sign-in-error">Couldn't read them again: {loadError}</span>}
        </div>
        <button className="btn" disabled={!connected || reading || saving !== undefined} onClick={() => void read(write?.ok !== true)}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {ask && (
        <div className="confirm toolset-ask" role="alertdialog" aria-label="Install on the server">
          <span className="confirm-msg">
            <TriangleAlert size={12} /> Turn on {ask.t.label}?
          </span>
          <span className="confirm-detail">
            Hermes starts installing {ask.installs.join(", ")} on the server when it's turned on, in the background, because it isn't installed there yet.
          </span>
          <div className="confirm-actions">
            <button className="btn" onClick={() => setAsk(undefined)}>
              Keep it off
            </button>
            <button className="btn danger" onClick={() => void confirmInstall(ask.t)}>
              Turn on
            </button>
          </div>
        </div>
      )}
      <div className="toolset-list" role="group" aria-label="Toolsets for this app's chats">
        {here.map(row)}
      </div>
      {elsewhere.length > 0 && (
        <>
          <h3 className="toolset-subhead">Other platforms</h3>
          <p className="muted small toolset-scope">These only reach the platform named on each, such as Hermes's Discord bot, not chats in this app.</p>
          <div className="toolset-list" role="group" aria-label="Toolsets for other platforms">
            {elsewhere.map(row)}
          </div>
        </>
      )}
    </section>
  );
}
