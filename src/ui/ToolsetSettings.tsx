// Settings → Toolsets: which toolsets Hermes offers the model, for the profile shown, as Hermes has them on the server.
// A switch changes one toolset for the whole profile; it is checked against a fresh read first and shown as saved only
// once Hermes reads it back that way. Reads and writes: toolsets.ts.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  UnsupportedServerError,
  changeableName,
  type Caution,
  type Pending,
  type Toolset,
  type ToolsetChange,
  type ToolsetGuards,
  type ToolsetList,
  type ToolsetsApi,
  type WriteSupport,
} from "../hermes/toolsets";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const onOff = (on: boolean) => (on ? "on" : "off");
const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * What happened to the latest change of one toolset, under its row. `unsettled`: Hermes didn't confirm it, for this
 * reason; a later read says what Hermes has instead of dropping the note.
 */
type Note = { tone: "ok" | "warn" | "error"; text: string; unsettled?: string };
/** A change being checked before it's sent: whether it may start an install or bring MCP servers back. */
type Checking = { name: string; enabled: boolean };

/** One caution, as the confirmation says it. */
function cautionText(c: Caution, t: Toolset): string {
  if (c.kind === "install") return `Hermes starts installing ${c.keys.join(", ")} on the server when ${t.label} is turned on, in the background, because it isn't installed there yet.`;
  if (c.kind === "noMcp")
    return `This profile has MCP servers turned off for ${t.platformLabel} with no_mcp. Hermes clears no_mcp whenever it saves a toolset change, so new chats would be offered the profile's MCP servers again.`;
  return `This app couldn't check ${c.what}.`;
}

/** Why a change the owner started wasn't asked about or sent: Hermes's list changed under it. */
function outdated(t: Toolset, now: Toolset | undefined): Note {
  return now === undefined
    ? { tone: "warn", text: `Not changed: Hermes no longer lists ${t.label}.` }
    : { tone: "warn", text: `Not changed: ${t.label} was turned ${onOff(now.enabled)} elsewhere while this was being checked. It shows as Hermes has it now.` };
}

/** The note a change's outcome leaves under the toolset's row. */
function noteFor(t: Toolset, enabled: boolean, r: ToolsetChange): Note {
  const now = r.list?.toolsets.find((x) => x.name === t.name)?.enabled;
  switch (r.kind) {
    case "saved":
      return {
        tone: r.warning ? "warn" : "ok",
        text:
          (r.warning ? `Hermes answered with an error (${r.warning}), but reads ${t.label} back as ${onOff(enabled)}.` : `Saved: Hermes reads ${t.label} back as ${onOff(enabled)}.`) +
          " It's the profile's list for new chats." +
          (r.installing ? ` Hermes also started installing ${r.installing} on the server for it, in the background.` : "") +
          (r.mcpBack ? " Hermes cleared no_mcp, so new chats are offered the profile's MCP servers again." : ""),
      };
    case "confirm":
      return { tone: "warn", text: `Not sent yet: checked again just before sending, turning ${t.label} ${onOff(enabled)} now needs your confirmation above.` };
    case "conflict":
      return r.now === undefined
        ? { tone: "warn", text: `Not changed: Hermes no longer lists ${t.label}.` }
        : { tone: "warn", text: `Not changed: ${t.label} was turned ${onOff(r.now)} elsewhere since this list was read. It shows as Hermes has it now.` };
    case "rejected":
      return {
        tone: "error",
        text: `Hermes refused the change (${r.reason}). ${now === undefined ? `It was ${onOff(t.enabled)} before.` : `It reads ${t.label} back as ${onOff(now)}.`}`,
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
        unsettled: r.reason,
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
  locked,
  saving,
  checking,
  problem,
  note,
  onToggle,
}: {
  t: Toolset;
  write?: WriteSupport;
  connected: boolean;
  /** Another change, or a read, is under way: no switch takes a click. */
  locked: boolean;
  saving?: Pending;
  checking?: Checking;
  /** What keeps its provider from working, from the provider readiness Hermes reports. */
  problem?: string;
  note?: Note;
  onToggle: (t: Toolset) => void;
}) {
  const id = `toolset-${t.name}`;
  const mine = saving?.name === t.name ? saving : undefined;
  const checkingMe = checking?.name === t.name ? checking : undefined;
  const canSwitch = write?.ok === true && changeableName(t.name);
  return (
    <div className="toolset-row" aria-busy={mine || checkingMe ? true : undefined}>
      <div className="toolset-head">
        <div className="toolset-label">
          <div className="appearance-title" id={`${id}-label`}>
            {t.label}
            {t.platform !== "cli" && <span className="badge">{t.platformLabel} only</span>}
            {(!t.configured || problem) && <span className="badge warn">Needs setup</span>}
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
            disabled={!connected || locked}
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
      {(!t.configured || problem) && (
        <div className="muted small toolset-hint">
          {problem ?? "Its provider or API key isn't set up on the server."} {t.configOnly ? "It may not work" : "Its tools may not work, or be offered,"} even while it's on. Set it up with{" "}
          <span className="mono">hermes tools</span> there.
        </div>
      )}
      {write?.ok && !changeableName(t.name) && <div className="muted small toolset-hint">This app can't send its name to Hermes, so it can't change it.</div>}
      {(mine || checkingMe) && (
        <div className="small muted toolset-hint" role="status">
          {mine ? `Saving: turning ${t.label} ${onOff(mine.enabled)}…` : `Checking what turning ${t.label} ${onOff(checkingMe!.enabled)} does…`}
        </div>
      )}
      {!mine && !checkingMe && note && (
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
  const [guards, setGuards] = useState<ToolsetGuards>();
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string>();
  const [unsupported, setUnsupported] = useState<string>();
  const [reading, setReading] = useState(false);
  const [checking, setChecking] = useState<Checking>();
  const [notes, setNotes] = useState<Record<string, Note>>({});
  /** A change waiting for the owner's confirmation. `again`: the check right before sending found something new. */
  const [ask, setAsk] = useState<{ t: Toolset; enabled: boolean; cautions: Caution[]; again?: boolean }>();
  /** A change whose outcome is unknown: the list is read again once Hermes is back. */
  const [reread, setReread] = useState(false);
  // The change on its way belongs to the API, not to this screen: leaving and coming back still shows it and waits.
  const pending = useSyncExternalStore(api.subscribe, api.pending);
  const savingHere = pending?.profile === profile ? pending : undefined;
  // Synchronous guards, since state lands after a second click could.
  const readingNow = useRef(false);
  const checkingNow = useRef(false);
  /** A read asked for while another read or a change was under way; `true` also asks whether Hermes takes changes. */
  const wanted = useRef<boolean | undefined>(undefined);
  const live = useRef(true);
  /** Bumped by each change's result: a read that started before it is older than what's shown, and is dropped. */
  const stamp = useRef(0);
  /** Bumped by each provider-readiness read: only the latest one's answer is shown. */
  const readinessRead = useRef(0);
  const shownList = useRef<ToolsetList | undefined>(undefined);
  shownList.current = list;
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  /**
   * Reads the list for this component's profile, and with `full` whether Hermes takes changes, the config guards and
   * provider readiness too. Asked while another read is under way, it runs once that is done; while a change to this
   * profile is on its way, it runs, and runs again once the change is done.
   */
  const read = useCallback(
    async (full: boolean) => {
      if (readingNow.current) {
        wanted.current = (wanted.current ?? false) || full;
        return;
      }
      if (api.pending()?.profile === profile) wanted.current = wanted.current ?? false;
      readingNow.current = true;
      const started = stamp.current;
      setReading(true);
      try {
        const [fresh, support, g] = await Promise.all([
          api.list(profile),
          full ? api.writeSupport(profile).catch((e): WriteSupport => ({ ok: false, reason: `Couldn't check whether Hermes takes changes: ${messageOf(e)}` })) : undefined,
          full ? api.guards(profile) : undefined,
        ]);
        if (!live.current) return;
        if (stamp.current !== started) return;
        // A note about a toolset that has changed since (elsewhere) no longer describes it, and an unconfirmed change is
        // settled by this read: the switch shows what Hermes has.
        const before = new Map(shownList.current?.toolsets.map((t) => [t.name, t.enabled]));
        const moved = new Set(fresh.toolsets.filter((t) => before.has(t.name) && before.get(t.name) !== t.enabled).map((t) => t.name));
        setNotes((n) =>
          Object.fromEntries(
            Object.entries(n).flatMap(([name, note]): [string, Note][] => {
              const t = fresh.toolsets.find((x) => x.name === name);
              if (note.unsettled !== undefined && t)
                return [[name, { tone: "warn", text: `Hermes didn't confirm the last change (${note.unsettled}). Read back at ${timeOf(fresh.readAt)}, ${t.label} is ${onOff(t.enabled)}.` }]];
              return moved.has(name) ? [] : [[name, note]];
            }),
          ),
        );
        setList(fresh);
        // A confirmation open for a toolset that has since changed, or gone, no longer asks the right question.
        setAsk((a) => {
          if (!a) return a;
          const now = fresh.toolsets.find((x) => x.name === a.t.name);
          if (now && now.enabled === a.t.enabled) return a;
          setNotes((n) => ({ ...n, [a.t.name]: outdated(a.t, now) }));
          return undefined;
        });
        if (support) setWrite(support);
        if (full) setGuards(g);
        setLoadError(undefined);
        setUnsupported(undefined);
        setReread(false);
        if (full) {
          const mine = ++readinessRead.current;
          void api.setupProblems(profile, fresh).then((p) => live.current && mine === readinessRead.current && setProblems(p));
        }
      } catch (e) {
        if (!live.current || stamp.current !== started) return;
        if (e instanceof UnsupportedServerError) setUnsupported(e.message);
        else setLoadError(messageOf(e));
      } finally {
        readingNow.current = false;
        if (live.current) setReading(false);
        // What was asked meanwhile, such as the read on reconnecting, on every path out, a dropped or failed read
        // included. One waiting for a change to this profile runs when that is done.
        if (wanted.current !== undefined && live.current && api.pending()?.profile !== profile) {
          const again = wanted.current;
          wanted.current = undefined;
          void read(again);
        }
      }
    },
    [api, profile],
  );

  // A change finishing (here, or before this screen was opened) runs the read that waited for it.
  useEffect(() => {
    if (pending || wanted.current === undefined || !connected) return;
    const again = wanted.current;
    wanted.current = undefined;
    void read(again);
  }, [pending, connected, read]);

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

  const commit = async (t: Toolset, enabled: boolean, accepted: Caution[] = []) => {
    let note: Note;
    try {
      const r = await api.set(profile, t.name, enabled, t.enabled, accepted);
      if (!live.current) return;
      stamp.current++;
      // Every outcome but a lost answer carries the list as Hermes has it after the attempt.
      if (r.list) setList(r.list);
      if (r.kind === "confirm") {
        const fresh = r.list.toolsets.find((x) => x.name === t.name) ?? t;
        setAsk({ t: fresh, enabled, cautions: r.cautions, again: true });
      }
      if (r.kind === "unknown" && !r.list) setReread(true);
      if (r.kind === "saved" && r.mcpBack) setGuards((g) => g && { ...g, noMcp: g.noMcp.filter((p) => p !== t.platform) });
      note = noteFor(t, enabled, r);
    } catch (e) {
      if (!live.current) return;
      // The read before the change failed: nothing was sent.
      note = { tone: "error", text: `Nothing changed: couldn't read ${t.label} from Hermes first: ${messageOf(e)}` };
    }
    setNotes((n) => ({ ...n, [t.name]: note }));
  };

  const toggle = async (t: Toolset) => {
    // A read under way doesn't hold a change up: the write checks a fresh read itself, and a read older than its result
    // is dropped. (Coming back to the window starts one, which must not swallow the click that brought the owner back.)
    if (checkingNow.current || api.pending() || !connected) return;
    checkingNow.current = true;
    setAsk(undefined);
    setNotes(({ [t.name]: _gone, ...rest }) => rest);
    const enabled = !t.enabled;
    let cautions: Caution[];
    try {
      setChecking({ name: t.name, enabled });
      cautions = await api.cautions(profile, t, enabled);
    } finally {
      checkingNow.current = false;
      if (live.current) setChecking(undefined);
    }
    if (!live.current) return;
    // The list may have been read again while this was checked: ask, or send, only about what Hermes has now.
    const now = shownList.current?.toolsets.find((x) => x.name === t.name);
    if (!now || now.enabled !== t.enabled) return setNotes((n) => ({ ...n, [t.name]: outdated(t, now) }));
    if (cautions.length) return setAsk({ t: now, enabled, cautions });
    await commit(now, enabled);
  };

  const confirm = async () => {
    if (!ask || api.pending() || !connected) return;
    const { t, enabled, cautions } = ask;
    setAsk(undefined);
    await commit(t, enabled, cautions);
  };

  const intro = (
    <>
      <h2>Toolsets</h2>
      <p className="muted">
        Which tools Hermes offers the model in the <span className="mono">{profile}</span> profile. Hermes keeps this list on the server, in the profile's
        settings, so the command line, the TUI and the Hermes desktop app use it too. It is the same for every chat in the profile.
      </p>
      <p className="muted small toolset-scope">
        <strong>When it takes effect:</strong> in chats Hermes starts after the change. A chat Hermes already has open, and a reply running in it, keeps the
        tools it started with. A server started with <span className="mono">HERMES_TUI_TOOLSETS</span> set uses that list instead.
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

  const locked = !!pending || !!checking;
  const here = list.toolsets.filter((t) => t.platform === "cli");
  const elsewhere = list.toolsets.filter((t) => t.platform !== "cli");
  const row = (t: Toolset) => (
    <ToolsetRow
      key={t.name}
      t={t}
      write={write}
      connected={connected}
      locked={locked}
      saving={savingHere}
      checking={checking}
      problem={problems[t.name]}
      note={notes[t.name]}
      onToggle={(x) => void toggle(x)}
    />
  );

  return (
    <section>
      {intro}
      {guards?.codingFocus && (
        <p className="small warn-note toolset-scope" role="status">
          This profile's agent.coding_context is focus: in a code workspace, Hermes gives new chats its own coding selection of toolsets instead of this list.
        </p>
      )}
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
      {pending && pending.profile !== profile && (
        <p className="small muted toolset-scope" role="status">
          Waiting for a change in the {pending.profile} profile to finish before this one can change.
        </p>
      )}
      <div className="settings-row toolset-status">
        <div className="muted small" role="status">
          {reading ? "Reading the toolsets from Hermes…" : loadError ? null : `Read from Hermes at ${timeOf(list.readAt)}.`}
          {loadError && <span className="sign-in-error">Couldn't read them again: {loadError}</span>}
        </div>
        <button className="btn" disabled={!connected || locked || reading} onClick={() => void read(true)}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {ask && (
        <div className="confirm toolset-ask" role="alertdialog" aria-label={`Turn ${ask.t.label} ${onOff(ask.enabled)}`}>
          <span className="confirm-msg">
            <TriangleAlert size={12} /> Turn {ask.t.label} {onOff(ask.enabled)}?
          </span>
          {ask.again && <span className="confirm-detail">Checked again just before sending, this changed since you were asked:</span>}
          {ask.cautions.map((c, i) => (
            <span className="confirm-detail" key={i}>
              {cautionText(c, ask.t)}
            </span>
          ))}
          <div className="confirm-actions">
            <button className="btn" onClick={() => setAsk(undefined)}>
              Keep it {onOff(ask.t.enabled)}
            </button>
            <button className="btn danger" disabled={!connected || !!pending} onClick={() => void confirm()}>
              Turn {onOff(ask.enabled)}
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
