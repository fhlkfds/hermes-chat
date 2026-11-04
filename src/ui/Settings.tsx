// The Settings screen, in nine tabs. General, ported from the prototype: the connection and Sign out, what shows on
// launch, screenshots, updates, the local cache, older history, importing transcripts, and backups. Appearance: how the app looks on this
// computer (AppearanceSettings.tsx). Model: the profile's models on Hermes (ModelSettings.tsx). Voice: Dictation, Read
// aloud and voice conversations, and the profile's speech providers on Hermes (VoiceProviderSettings.tsx). Toolsets: which tools
// Hermes offers the model in the profile (ToolsetSettings.tsx). Persona: the profile's SOUL.md on Hermes
// (PersonaSettings.tsx). Memory: what Hermes remembers for the profile (MemorySettings.tsx). Skills: the profile's
// skills, switched and edited on Hermes (SkillSettings.tsx). Diagnostics: what the connected Hermes is and what it
// supports (Diagnostics.tsx); a tab whose feature Hermes lacks says so in its place.
// Profiles are switched in the list's header, not here (ADR 0001). The search box (Ctrl+F) shows the sections of every
// tab whose text holds what was typed (settingsSearch.ts).
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, AudioLines, Brain, Cpu, Download, KeyRound, Lock, LogOut, Palette, PlugZap, Puzzle, Search, Settings2, ShieldCheck, Sparkles, Stethoscope, Trash2, Wrench, X } from "lucide-react";
import type { Chat, ConnectionStatus } from "../hermes/model";
import type { Route } from "../hermes/pipe";
import { TRANSCRIPT_LIMIT_BYTES } from "../hermes/chatCache";
import { STATUS_LABEL, arrowSelect, fmtSize, routeLabel } from "./bits";
import type { AppearanceStore, Fonts } from "./appearance";
import { AppearanceSettings } from "./AppearanceSettings";
import type { ModelSettingsApi } from "../hermes/modelSettings";
import { ModelSettings } from "./ModelSettings";
import type { ToolsetsApi } from "../hermes/toolsets";
import { ToolsetSettings, type OpenChat } from "./ToolsetSettings";
import type { MemoryApi } from "../hermes/memory";
import { MemorySettings } from "./MemorySettings";
import type { MemoryProvidersApi } from "../hermes/memoryProviders";
import { MemoryProviderSettings } from "./MemoryProviderSettings";
import type { SkillsApi } from "../hermes/skills";
import { SkillSettings } from "./SkillSettings";
import { PersonaSettings, type PersonaWhere } from "./PersonaSettings";
import type { PersonaApi } from "../hermes/persona";
import type { PersonaStore } from "../hermes/personaStore";
import { StartupSettings } from "./StartupSettings";
import { VoiceSettings, useVoiceChanges } from "./Voice";
import type { VoiceSetup } from "../hermes/pipe";
import type { VoiceSettingsApi } from "../hermes/voiceSettings";
import { VoiceProviderSettings } from "./VoiceProviderSettings";
import { ScreenshotSettings } from "./ScreenshotSettings";
import { TraySettings } from "./TraySettings";
import type { TrayWiring } from "../hermes/tauriTray";
import type { ScreenshotSupport } from "../hermes/tauriScreenshot";
import { UpdateSettings } from "./UpdateSettings";
import { ImportSection, type ImportWiring } from "./ImportTranscripts";
import { BackupSection, type BackupWiring } from "./Backup";
import { guideUrl, type CapabilityId, type CapabilityStore } from "../hermes/capabilities";
import { CapabilityGate, DiagnosticsSettings, type OpenGuide } from "./Diagnostics";
import { NAMED, applySearch, clearMarks, queryWords, textMatches } from "./settingsSearch";

type Tab = "general" | "appearance" | "model" | "voice" | "toolsets" | "persona" | "memory" | "skills" | "diagnostics";
const TABS = [
  { id: "general", label: "General", Icon: Settings2 },
  { id: "appearance", label: "Appearance", Icon: Palette },
  { id: "model", label: "Model", Icon: Cpu },
  { id: "voice", label: "Voice", Icon: AudioLines },
  { id: "toolsets", label: "Toolsets", Icon: Wrench },
  { id: "persona", label: "Persona", Icon: Sparkles },
  { id: "memory", label: "Memory", Icon: Brain },
  { id: "skills", label: "Skills", Icon: Puzzle },
  { id: "diagnostics", label: "Diagnostics", Icon: Stethoscope },
] as const;

/** The tabs whose sections a search shows in place. */
const SEARCHED: readonly Tab[] = ["general", "appearance", "model", "voice", "toolsets"];
/**
 * The tabs a search names instead: each edits one thing Hermes keeps (a file, a list of entries), so it's opened to
 * search rather than mounted beside the others with its unsaved edit.
 */
const ABOUT: Partial<Record<Tab, string>> = {
  persona: "Who Hermes is and how it speaks in this profile's chats: the profile's SOUL.md, edited on the server.",
  memory: "What Hermes remembers about you and your work between chats, changed or removed entry by entry.",
  skills: "Instructions Hermes can load for a kind of task: turn each skill on or off for the profile, and edit its SKILL.md.",
  diagnostics: "The connected Hermes's version, protocol and sign-in, and which features this server supports.",
};

/** How the connection signs in, in words, for diagnostics: this app signs in only with the dashboard's username and password. */
export const signInText = (route?: Route) =>
  route?.kind === "ssh"
    ? "Dashboard username and password, through an SSH tunnel"
    : route
      ? "Dashboard username and password, at the dashboard's URL"
      : "Dashboard username and password";

/** Settings → Persona's wiring: the API, where its edits are kept on this computer, and what it edits. */
export type PersonaWiring = { api: PersonaApi; store: PersonaStore; storeKey: string; where: PersonaWhere };

const allow = (go: () => void) => go();

/** What a pull added: the older chats in Settled, and any pinned in another Hermes client, which are Active. */
function pulledText(added: Chat[]): string {
  if (!added.length) return "There were no older chats on the server.";
  const active = added.filter((c) => !c.settled).length;
  const settled = added.length - active;
  const chats = (n: number) => `${n} older ${n === 1 ? "chat" : "chats"}`;
  if (!active) return `Added ${chats(settled)} to Settled.`;
  if (!settled) return `Added ${chats(active)} to Active: ${active === 1 ? "it's" : "they're"} pinned in another Hermes client.`;
  return `Added ${chats(settled)} to Settled, and ${active} to Active: ${active === 1 ? "it's" : "they're"} pinned in another Hermes client.`;
}

export function SettingsScreen({
  status,
  route,
  unsecure,
  username,
  passwordSaved,
  headers = [],
  headersSaved = true,
  profile,
  olderPulled,
  cacheBytes,
  appearance,
  listFonts,
  checkScreenshots,
  tray,
  modelSettings,
  toolsets,
  runningReplies = 0,
  openChat,
  memory,
  memoryProviders,
  onMemoryDirty = () => {},
  memoryDiscards = 0,
  skills,
  onSkillDirty = () => {},
  skillDiscards = 0,
  onClearCache,
  onPullOlder,
  onSignOut,
  onSetUp,
  onClose,
  voiceSetup,
  voiceSettings,
  onVoiceChange,
  showVoice,
  persona,
  onPersonaDirty = () => {},
  guard = allow,
  showTextGeneration,
  importer,
  backup,
  showMemory,
  capabilities,
  openGuide = () => {},
  showDiagnostics,
  connectionManager,
}: {
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  username: string;
  /** The keyring kept the password at sign-in. */
  passwordSaved: boolean;
  /** The names of the extra request headers the connection sends; their values are never shown. */
  headers?: string[];
  /** The keyring kept the extra headers at sign-in. */
  headersSaved?: boolean;
  profile: string;
  olderPulled: boolean;
  /** The storage the saved chat lists and Saved copies take now. */
  cacheBytes: () => number;
  appearance: AppearanceStore;
  /** The installed font families, for the font pickers. */
  listFonts: () => Promise<Fonts>;
  /** How screenshots are taken on this desktop; left out where there is no desktop app to ask. */
  checkScreenshots?: () => Promise<ScreenshotSupport>;
  /** The tray icon and Close to tray; left out where there is no desktop app to ask. */
  tray?: TrayWiring;
  /** The profile's model setup on Hermes. */
  modelSettings: ModelSettingsApi;
  /** The profile's toolsets on Hermes; without it there is no Toolsets tab. */
  toolsets?: ToolsetsApi;
  /** Chats of the shown profile with a reply running now. */
  runningReplies?: number;
  /** The chat in the active pane, for Toolsets' read of what it has. */
  openChat?: OpenChat;
  /** The profile's memory on Hermes; the Memory tab shows only with it. */
  memory?: MemoryApi;
  /** Each profile's external memory provider on Hermes, shown in the Memory tab under the profile's own memory. */
  memoryProviders?: MemoryProvidersApi;
  /** Called with whether the Memory tab has an unsaved edit. */
  onMemoryDirty?: (dirty: boolean) => void;
  /** Changes each time the owner discards the unsaved memory edit from App's question. */
  memoryDiscards?: number;
  /** The profile's skills on Hermes; the Skills tab shows only with it. */
  skills?: SkillsApi;
  /** Called with whether the Skills tab has an unsaved edit. */
  onSkillDirty?: (dirty: boolean) => void;
  /** Changes each time the owner discards the unsaved skill edit from App's question. */
  skillDiscards?: number;
  onClearCache: () => void;
  /** Importing transcripts into the profile shown; without it there is no Import section. */
  importer?: ImportWiring;
  /** Export and restore of what this computer keeps; without it there is no Backup section. */
  backup?: BackupWiring;
  /** Resolves to the older chats added. */
  onPullOlder: () => Promise<Chat[]>;
  onSignOut: () => Promise<void>;
  /** Opens setup again, to change the connection or give Hermes a model provider's key. */
  onSetUp?: () => void;
  onClose: () => void;
  /** The shown profile's voice set-up, for the Voice tab. */
  voiceSetup?: () => Promise<VoiceSetup>;
  /** The profile's speech providers on Hermes, picked and set up in the Voice tab. */
  voiceSettings?: VoiceSettingsApi;
  /** Calls `fn` whenever the voice set-up may have changed on Hermes; returns its unsubscribe. */
  onVoiceChange?: (fn: () => void) => () => void;
  /** Set, each time anew, to show the Voice tab: from a voice conversation's "Change voice settings". */
  showVoice?: object;
  /** Settings → Persona; the tab is left out without it. */
  persona?: PersonaWiring;
  /** Says whether the Persona tab holds an edit Hermes doesn't have yet. */
  onPersonaDirty?: (dirty: boolean, kept: boolean) => void;
  /** Runs `go`, once the owner agrees to leave an unsaved persona, memory or skill edit behind, if there is one. */
  guard?: (go: () => void) => void;
  /** Set, each time anew, to show the Model tab at the Text generation model: from a title that couldn't be regenerated. */
  showTextGeneration?: object;
  /** The saved connections (Connections.tsx `ConnectionManager`), shown first in General. */
  connectionManager?: ReactNode;
  /** Set (to a new object each time) to show the Memory tab. */
  showMemory?: object;
  /** What the connected Hermes supports; without it there is no Diagnostics tab and no tab is held back. */
  capabilities?: CapabilityStore;
  /** Opens a compatibility guide page in the browser. */
  openGuide?: OpenGuide;
  /** Set, each time anew, to show the Diagnostics tab, at a capability if it names one: from a screen's note. */
  showDiagnostics?: { id?: CapabilityId };
}) {
  const [bytes, setBytes] = useState(cacheBytes);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState<string>();
  const [pullError, setPullError] = useState<string>();
  const [signingOut, setSigningOut] = useState(false);
  /** What's typed in the search box; Settings shows search results while it holds a word. */
  const [query, setQuery] = useState("");
  // The Memory tab's two parts each say whether they hold an unsaved change; the tab has one while either does.
  const memoryParts = useRef({ entries: false, providers: false });
  const memoryPart = (part: "entries" | "providers") => (dirty: boolean) => {
    memoryParts.current[part] = dirty;
    onMemoryDirty(memoryParts.current.entries || memoryParts.current.providers);
  };
  const onEntriesDirty = useCallback(memoryPart("entries"), [onMemoryDirty]);
  const onProvidersDirty = useCallback(memoryPart("providers"), [onMemoryDirty]);
  const [tab, setTabNow] = useState<Tab>(
    showTextGeneration ? "model" : showMemory && memory ? "memory" : showDiagnostics && capabilities ? "diagnostics" : showVoice ? "voice" : "general",
  );
  // The Voice tab's set-up rows read again after a save there (or a Toolsets speech-to-text switch).
  const voiceChanges = useVoiceChanges(onVoiceChange ? { onChange: onVoiceChange } : undefined);
  // A new object each time a note asks for a capability, so the row is focused again even for the same one.
  const [diagFocus, setDiagFocus] = useState<{ id: CapabilityId } | undefined>(showDiagnostics?.id ? { id: showDiagnostics.id } : undefined);
  const tabs = TABS.filter(
    (t) =>
      (t.id !== "toolsets" || toolsets) &&
      (t.id !== "voice" || voiceSetup || voiceSettings) &&
      (t.id !== "persona" || persona) &&
      (t.id !== "memory" || memory) &&
      (t.id !== "skills" || skills) &&
      (t.id !== "diagnostics" || capabilities),
  );
  // Leaving the Persona, Memory or Skills tab asks first while it holds an unsaved edit.
  const setTab = (t: Tab) => t !== tab && guard(() => setTabNow(t));
  // Asked from elsewhere in the app, these end a search too.
  useEffect(() => {
    if (!showTextGeneration) return;
    setQuery("");
    setTab("model");
  }, [showTextGeneration]);
  useEffect(() => {
    if (!showMemory || !memory) return;
    setQuery("");
    setTab("memory");
  }, [showMemory]);
  useEffect(() => {
    if (!showVoice) return;
    setQuery("");
    setTab("voice");
  }, [showVoice]);
  useEffect(() => {
    if (!showDiagnostics || !capabilities) return;
    setQuery("");
    setDiagFocus(showDiagnostics.id ? { id: showDiagnostics.id } : undefined);
    setTab("diagnostics");
  }, [showDiagnostics]);
  /** A tab's note about a feature Hermes lacks opens Diagnostics at it. */
  const toDiagnostics = (id: CapabilityId) =>
    guard(() => {
      setQuery("");
      setDiagFocus({ id });
      setTabNow("diagnostics");
    });
  /** `body`, unless the connected Hermes lacks capability `id`; then the note saying so, and nothing of `body` runs. */
  const gated = (id: CapabilityId, body: ReactNode) =>
    capabilities ? (
      <CapabilityGate store={capabilities} id={id} openGuide={openGuide} onDiagnostics={toDiagnostics}>
        {body}
      </CapabilityGate>
    ) : (
      body
    );

  const pull = async () => {
    setPulling(true);
    setPullError(undefined);
    try {
      setPulled(pulledText(await onPullOlder()));
    } catch (e) {
      setPullError(`Couldn't pull older history: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPulling(false);
    }
  };

  const searchBox = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const words = queryWords(query);
  const searching = words.length > 0;
  const wordsKey = words.join(" ");
  const [found, setFound] = useState(0);
  // The shown sections follow the text as it changes: a tab reading from Hermes fills in after the search starts.
  useLayoutEffect(() => {
    const root = results.current;
    if (!root || !wordsKey) return;
    const w = wordsKey.split(" ");
    const run = () => setFound(applySearch(root, w));
    run();
    const seen = new MutationObserver(run);
    seen.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: NAMED });
    return () => {
      seen.disconnect();
      clearMarks();
    };
  }, [wordsKey]);
  // Ctrl+F finds in Settings; the chat panes it covers aren't active, so theirs doesn't open. A dialog keeps its focus, and a
  // shortcut recorder keeps the keys it takes.
  // Escape ends a search from anywhere in Settings, not only the box: the focus is often on a result by then.
  const searchingRef = useRef(false);
  searchingRef.current = searching;
  const screenRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchBox.current?.focus();
        searchBox.current?.select();
      } else if (e.key === "Escape" && searchingRef.current) {
        const at = document.activeElement;
        if (at && at !== document.body && !screenRef.current?.contains(at)) return;
        e.preventDefault();
        setQuery("");
        searchBox.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  /** Starting a search leaves the tab shown, so it asks first, as switching tabs does, while that tab holds an unsaved edit. */
  const typed = (v: string) => (!searching && queryWords(v).length ? guard(() => setQuery(v)) : setQuery(v));
  /** A tab picked while searching ends the search there. */
  const pick = (t: Tab) => {
    if (!searching) return setTab(t);
    setQuery("");
    setTabNow(t);
  };
  const elsewhere = tabs.filter((t) => ABOUT[t.id] && textMatches(`${t.label} ${ABOUT[t.id]}`, words));

  const general = (
    <>
      {connectionManager}
      <section>
        <h2>Connection in use</h2>
        <div className="settings-status">
          <span className={`conn-dot ${status} ${unsecure ? "unsecure" : ""}`} />
          <span>{STATUS_LABEL[status]}</span>
          {unsecure && <span className="badge warn">Unsecure</span>}
          <span className="muted mono">{routeLabel(route)}</span>
        </div>
        <div className="settings-row">
          <div className="muted small">
            <KeyRound size={12} /> Signed in as <span className="mono">{username}</span>.{" "}
            {passwordSaved ? "The password is saved in your system keyring." : "The system keyring couldn't save the password."}
          </div>
          <button
            className="btn"
            disabled={signingOut}
            onClick={async () => {
              setSigningOut(true);
              // Resolves without signing out when the owner chose to stay with an unsaved persona edit.
              await onSignOut().finally(() => setSigningOut(false));
            }}
          >
            <LogOut size={14} /> {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
        {headers.length > 0 && (
          <div className="muted small settings-headers">
            <ShieldCheck size={12} /> Sends {headers.length === 1 ? "an extra request header" : `${headers.length} extra request headers`}:{" "}
            {headers.map((h, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <span className="mono">{h}</span>
              </span>
            ))}
            .{" "}
            {headersSaved
              ? "Their values are saved in your system keyring and never shown."
              : "Their values are never shown. The system keyring couldn't save them, so you type them again at the next sign-in."}
          </div>
        )}
        <p className="muted small settings-note">
          Signing out deletes the saved password from the keyring. You type it again at the next sign-in.
          {headers.length > 0 && headersSaved && " The extra request headers stay saved, to change or remove on the sign-in screen."}
        </p>
        {capabilities && (
          <div className="settings-row settings-setup">
            <div className="muted small">See the Hermes version, protocol and sign-in, and which features this server supports.</div>
            <button className="btn" onClick={() => pick("diagnostics")}>
              <Stethoscope size={14} aria-hidden /> Connection diagnostics
            </button>
          </div>
        )}
        {onSetUp && (
          <div className="settings-row settings-setup">
            <div className="muted small">
              Change this connection's address or sign-in, or give Hermes a model provider's API key. The connection stays as it is until the
              change is tested and saved. To keep it and use another server too, add a connection above.
            </div>
            <button className="btn" onClick={onSetUp}>
              <PlugZap size={14} /> Run setup again
            </button>
          </div>
        )}
      </section>

      <StartupSettings />
      <TraySettings tray={tray} />

      <ScreenshotSettings checkSupport={checkScreenshots} />
      <UpdateSettings />

      <section>
        <h2>Local cache</h2>
        <p className="muted">
          Hermes Chat keeps a copy of each profile's chat list on this computer, so the list shows as soon as you sign in. It also keeps a
          Saved copy of the chats you opened most recently, up to {fmtSize(TRANSCRIPT_LIMIT_BYTES)}, so you can read them while Hermes can't be
          reached. The oldest copies are deleted first when that fills up. Clearing the cache keeps your display settings.
        </p>
        <div className="settings-row">
          <div>
            <div className="big-num">{fmtSize(bytes)}</div>
            <div className="muted small">{bytes ? "Stored on this computer" : "Nothing stored"}</div>
          </div>
          {!confirmClear ? (
            <button className="btn" disabled={!bytes} onClick={() => setConfirmClear(true)}>
              <Trash2 size={14} /> Clear local cache
            </button>
          ) : (
            <div className="confirm">
              <span>
                <Lock size={12} /> Only the chat copies on this computer are deleted; your display settings are kept. Nothing on your Hermes
                server is touched; the list is saved again at the next refresh, and a chat's Saved copy when you next open it.
              </span>
              <div className="confirm-actions">
                <button className="btn" onClick={() => setConfirmClear(false)}>
                  Cancel
                </button>
                <button
                  className="btn danger"
                  onClick={() => {
                    onClearCache();
                    setBytes(cacheBytes());
                    setConfirmClear(false);
                  }}
                >
                  Clear {fmtSize(bytes)}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section>
        <h2>History</h2>
        <p className="muted">
          The list shows chats from the past month. Older chats stay on the server until you pull them for the{" "}
          <span className="mono">{profile}</span> profile.
        </p>
        <div className="settings-row">
          <div className={`small ${pullError ? "sign-in-error" : "muted"}`} role={pullError ? "alert" : undefined}>
            {pullError ?? pulled ?? (olderPulled ? "All chats are listed, however old." : "Showing chats from the past month.")}
          </div>
          <button className="btn" disabled={pulling || olderPulled || status !== "connected"} onClick={pull}>
            <Download size={14} /> {pulling ? "Pulling…" : olderPulled ? "Up to date" : "Pull older history"}
          </button>
        </div>
      </section>
      {importer && <ImportSection wiring={importer} connected={status === "connected"} />}
      {backup && <BackupSection wiring={backup} />}
    </>
  );

  /** The content of a tab: the same whether it's shown alone or with others in a search. */
  const panel = (id: Tab): ReactNode => {
    switch (id) {
      case "persona":
        return (
          persona &&
          // An edit is for one connection and profile: another profile is another editor.
          gated(
            "persona",
            <PersonaSettings
              key={`${persona.storeKey}`}
              api={persona.api}
              store={persona.store}
              storeKey={persona.storeKey}
              where={persona.where}
              connected={status === "connected"}
              onDirty={onPersonaDirty}
            />,
          )
        );
      case "memory":
        // An edit lives only while this tab is open, and for one profile; leaving with one asks first.
        return (
          memory && (
            <>
              {gated(
                "memory",
                <MemorySettings key={profile} api={memory} profile={profile} status={status} server={routeLabel(route) ?? "not known until connected"} onDirtyChange={onEntriesDirty} discardSignal={memoryDiscards} />,
              )}
              {memoryProviders && (
                <MemoryProviderSettings key={`providers-${profile}`} api={memoryProviders} profile={profile} connected={status === "connected"} onDirtyChange={onProvidersDirty} discardSignal={memoryDiscards} />
              )}
            </>
          )
        );
      case "skills":
        // An edit lives only while this tab is open, and for one profile; leaving with one asks first.
        return (
          skills &&
          gated(
            "skills",
            <SkillSettings key={profile} api={skills} profile={profile} status={status} server={routeLabel(route) ?? "not known until connected"} onDirtyChange={onSkillDirty} discardSignal={skillDiscards} />,
          )
        );
      case "appearance":
        return <AppearanceSettings store={appearance} listFonts={listFonts} />;
      case "model":
        // A draft lives only while this tab is open, and for one profile.
        return <ModelSettings key={profile} api={modelSettings} profile={profile} connected={status === "connected"} showTextGeneration={searching ? undefined : showTextGeneration} />;
      case "voice":
        return (
          <>
            <VoiceSettings status={status} profile={profile} setup={voiceSetup} changes={voiceChanges} />
            {voiceSettings && (
              // Read for one profile and connection; another starts afresh, with nothing typed kept.
              <VoiceProviderSettings key={profile} api={voiceSettings} profile={profile} connected={status === "connected"} />
            )}
          </>
        );
      case "toolsets":
        // Read for one profile; switching profile reads the new one's afresh.
        return (
          toolsets &&
          gated("toolsets", <ToolsetSettings key={profile} api={toolsets} profile={profile} connected={status === "connected"} runningReplies={runningReplies} chat={openChat} onGuide={() => openGuide(guideUrl("toolsetSwitches"))} />)
        );
      case "diagnostics":
        return (
          capabilities && (
            <DiagnosticsSettings
              store={capabilities}
              connected={status === "connected"}
              server={routeLabel(route)}
              signIn={signInText(route)}
              headers={headers.length}
              unsecure={unsecure}
              profile={profile}
              openGuide={openGuide}
              focus={diagFocus}
            />
          )
        );
      case "general":
        return general;
    }
  };
  const shownTab = tabs.some((t) => t.id === tab) ? tab : "general";
  const total = found + elsewhere.length;

  return (
    <div className="settings" ref={screenRef}>
      <div className="settings-inner">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <div className="settings-head">
          <h1>Settings</h1>
          <div className="settings-search" role="search">
            <Search size={14} aria-hidden />
            <input
              ref={searchBox}
              type="search"
              aria-label="Search settings"
              placeholder="Search settings"
              value={query}
              onChange={(e) => typed(e.target.value)}
            />
            {query && (
              <button className="icon-btn" aria-label="Clear search" title="Clear search" onClick={() => (setQuery(""), searchBox.current?.focus())}>
                <X size={14} />
              </button>
            )}
          </div>
        </div>
        <div
          className="settings-tabs"
          role="tablist"
          aria-label="Settings"
          // While searching no tab is selected, so the arrows move on from the tab that has the focus.
          onKeyDown={(e) => {
            const ids = tabs.map((t) => t.id);
            const focused = ids.find((id) => (e.target as HTMLElement).id === `settings-tab-${id}`);
            arrowSelect(e, ids, searching && focused ? focused : tab, pick);
          }}
        >
          {tabs.map(({ id, label, Icon }) => {
            const on = !searching && shownTab === id;
            return (
              <button
                key={id}
                id={`settings-tab-${id}`}
                className={`settings-tab ${on ? "on" : ""}`}
                role="tab"
                aria-selected={on}
                tabIndex={on || (searching && id === tabs[0].id) ? 0 : -1}
                aria-controls={searching ? undefined : `settings-panel-${id}`}
                onClick={() => pick(id)}
              >
                <Icon size={14} /> {label}
              </button>
            );
          })}
        </div>

        {searching ? (
          <div className="settings-results">
            <p className="muted small settings-search-count" role="status">
              {total ? `${total} ${total === 1 ? "match" : "matches"} for “${query.trim()}”` : `No settings match “${query.trim()}”.`}
            </p>
            <div ref={results}>
            {elsewhere.map(({ id, label, Icon }) => (
              <div key={id} className="settings-row settings-search-elsewhere" data-search-mark>
                <div>
                  <div className="settings-search-tab">
                    <Icon size={13} /> {label}
                  </div>
                  <div className="muted small">{ABOUT[id]}</div>
                </div>
                <button className="btn" onClick={() => pick(id)}>
                  Open {label}
                </button>
              </div>
            ))}
              {tabs
                .filter((t) => SEARCHED.includes(t.id))
                .map(({ id, label, Icon }) => (
                  <div key={id} data-search-group={id} role="group" aria-label={label}>
                    <div className="settings-search-tab">
                      <Icon size={13} /> {label}
                    </div>
                    {panel(id)}
                  </div>
                ))}
            </div>
          </div>
        ) : (
          <div id={`settings-panel-${shownTab}`} role="tabpanel" aria-labelledby={`settings-tab-${shownTab}`}>
            {panel(shownTab)}
          </div>
        )}
      </div>
    </div>
  );
}
