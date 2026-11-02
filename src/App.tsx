import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { PanelRight } from "lucide-react";
import { connect, readSaved, type Delivery, type Hermes } from "./hermes/transport";
import { CHECK_EVERY_MS } from "./hermes/otherProfiles";
import { type Account, type Kept, type SavedSignIn, launchSignIn, savedSignIn, signIn, signInForm, signOutToSignIn } from "./hermes/account";
import { localChatCache } from "./hermes/chatCache";
import { draftKey, drafts } from "./hermes/drafts";
import { chatToReopen, forgetOpenChat, rememberOpenChat } from "./hermes/uiPrefs";
import { exportChat } from "./hermes/exportChat";
import { projectLinks, projectScope } from "./hermes/projectLinks";
import { ProjectsStore, type Project } from "./hermes/projects";
import { systemHeaderKeyring, systemKeyring } from "./hermes/tauriKeyring";
import { desktopNotify } from "./hermes/tauriNotify";
import { tauriPipe, type SignInDetails } from "./hermes/tauriPipe";
import { type Attachment, type Chat, type Found, isOutgoing } from "./hermes/model";
import type { ModelPick } from "./hermes/models";
import { ChatList, Rail } from "./ui/Sidebar";
import { ChatPane } from "./ui/ChatPane";
import { SearchPalette } from "./ui/Search";
import { SettingsScreen } from "./ui/Settings";
import { composing, routeLabel } from "./ui/bits";
import { ProjectScreen, ProjectSwitcher, type ProjectUnread } from "./ui/Projects";
import { appearanceStore } from "./ui/appearance";
import { StatusBar } from "./ui/StatusBar";
import { systemFonts } from "./ui/tauriFonts";
import { SignIn } from "./ui/SignIn";
import { ModelControls } from "./ui/ModelPicker";
import { PANE_MIN_WIDTH, PreviewPane } from "./ui/PreviewPane";
import { PreviewContext } from "./ui/previewContext";
import { tauriLocalFiles, type LocalFiles } from "./ui/tauriPreview";
import type { PreviewTarget } from "./hermes/preview";
import type { Route } from "./hermes/pipe";
import { getUIPrefs, setUIPrefs, subscribe as subscribeUIPrefs, toggleModelFavorite, type StickyModelPick } from "./hermes/uiPrefs";

const SAVED = "hermes-chat.sign-in"; // Everything but the password and extra headers, which are in the system keyring.
// Hermes also announces store changes over the socket; the poll catches anything it misses.
const SYNC_EVERY_MS = 60_000;
const TOAST_MS = 5_000;

/** A short notice above the composer; `undo` puts back what it reports. `at` restarts the timer for a repeat. */
type Toast = { text: string; undo?: () => void; at: number };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const withoutProfile = ({ profile: _profile, ...pick }: StickyModelPick): ModelPick => pick;

/** The narrowest the chat gets beside the preview pane; narrower than this and the pane covers the chat instead. */
const CHAT_MIN_WIDTH = 440;
const PREVIEW_DEFAULT_WIDTH = 480;

/** How the preview pane names the Hermes server: the SSH target, or the dashboard's host. */
function serverLabel(route?: Route): string {
  if (!route) return "the server";
  if (route.kind === "ssh") return route.target;
  try {
    return new URL(route.url).host;
  } catch {
    return route.url;
  }
}

/** An element's width as it changes; 0 where it can't be measured (as in tests). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

function loadSignIn(): SavedSignIn {
  const blank = { mode: "ssh" as const, sshTarget: "", url: "", username: "" };
  try {
    return { ...blank, ...JSON.parse(localStorage.getItem(SAVED) ?? "{}") };
  } catch {
    return blank;
  }
}

const account: Account = {
  keyring: systemKeyring,
  headerKeyring: systemHeaderKeyring,
  store: { load: loadSignIn, save: (d) => localStorage.setItem(SAVED, JSON.stringify(d)) },
  connect: (d) => connect(tauriPipe(d), undefined, localChatCache(d), desktopNotify),
  readSaved: (d, reason) => readSaved(tauriPipe(d), reason, localChatCache(d), desktopNotify),
};

const savedDrafts = drafts(localStorage);
// Which chats are in each project, and which project the list shows (projectLinks.ts).
const savedProjects = projectLinks(localStorage);
// Applied as the app loads, so the chosen fonts show from the first screen.
const appearance = appearanceStore(localStorage, document.documentElement);

/** The names of the extra request headers a sign-in sends; only a URL sends them. */
const headerNames = (d: SignInDetails) => (d.mode === "url" ? (d.headers ?? []).map((h) => h.name.trim()) : []);

/** What launch ends in: signed in with the saved password, or the sign-in screen and why. */
type Launch = { hermes: Hermes; headers: string[] } | { initial: SignInDetails; error?: string };
let launching: Promise<Launch> | undefined;

/**
 * Signs in with the saved password, if there is one; if Hermes can't be reached, what this computer saved opens to
 * read. If that fails the sign-in screen has it filled in, so Connect tries again. Runs once, though StrictMode runs
 * effects twice.
 */
function launch(): Promise<Launch> {
  return (launching ??= (async () => {
    const saved = await savedSignIn(account);
    if (!saved) return { initial: await signInForm(account) };
    try {
      return { hermes: await launchSignIn(saved, account), headers: headerNames(saved) };
    } catch (e) {
      return { initial: saved, error: messageOf(e) };
    }
  })());
}

export default function App() {
  const [hermes, setHermes] = useState<Hermes | null>(null);
  // The sign-in screen's details; none while launch is signing in with the saved password.
  const [initial, setInitial] = useState<SignInDetails>();
  const [error, setError] = useState<string>();
  // Why the keyring couldn't save the password at sign-in, shown once signed in.
  const [notSaved, setNotSaved] = useState<string>();
  const [kept, setKept] = useState<Kept>({ password: true, headers: true });
  // Only the first sign-in after the app starts reopens the last chat; signing in again after Sign out starts fresh.
  const [coldStart, setColdStart] = useState(true);
  // The names of the extra request headers the connection sends, for Settings.
  const [headers, setHeaders] = useState<string[]>([]);

  useEffect(() => {
    void launch().then((l) => {
      if ("hermes" in l) {
        setHeaders(l.headers);
        return setHermes(l.hermes);
      }
      setInitial(l.initial);
      setError(l.error);
    });
  }, []);

  if (hermes)
    return (
      <Main
        hermes={hermes}
        connection={account.store.load()}
        headers={headers}
        notSaved={notSaved}
        kept={kept}
        reopenLast={coldStart}
        onSignOut={async () => {
          // Everything is read first, then shown at once: the sign-in screen keeps the details it mounts with.
          const { initial, error } = await signOutToSignIn(hermes, account);
          setHermes(null);
          setColdStart(false);
          setNotSaved(undefined);
          setKept({ password: true, headers: true });
          setInitial(initial);
          setError(error);
        }}
      />
    );
  if (!initial)
    return (
      <div className="first-run">
        <div className="first-run-card">
          <div className="rail-brand big">H</div>
          <p className="muted">Signing in…</p>
        </div>
      </div>
    );
  return (
    <SignIn
      initial={initial}
      error={error}
      onSignIn={async (d) => {
        setError(undefined);
        try {
          const { hermes: h, notSaved, kept } = await signIn(d, account);
          setNotSaved(notSaved);
          setKept(kept);
          setHeaders(headerNames(d));
          setHermes(h);
        } catch (e) {
          setError(messageOf(e));
        }
      }}
    />
  );
}

export function Main({
  hermes,
  connection,
  headers = [],
  notSaved,
  kept = { password: true, headers: true },
  reopenLast = false,
  localFiles = tauriLocalFiles,
  onSignOut,
}: {
  hermes: Hermes;
  connection: SavedSignIn;
  /** The names of the extra request headers the connection sends. */
  headers?: string[];
  notSaved?: string;
  /** What the keyring kept at sign-in. */
  kept?: Kept;
  /** This is the app starting: open the profile's last open chat, if the owner wants it reopened. */
  reopenLast?: boolean;
  /** Where the preview pane's Local files come from: the Open dialog, through Rust. */
  localFiles?: LocalFiles;
  onSignOut: () => Promise<void>;
}) {
  const { profile, chats, olderPulled, archivedListed, status, route, unsecure, closedReason, syncError, others, models, switching } = useSyncExternalStore(
    hermes.subscribe,
    hermes.getSnapshot,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The project screen covers the chat pane, as Settings does.
  const [projectOpen, setProjectOpen] = useState(false);
  // The chat to reopen at launch, until Hermes's list shows it is there or gone, or the owner goes somewhere first.
  const [reopening, setReopening] = useState(() => (reopenLast ? chatToReopen(profile) : undefined));
  // Opened at once when the list saved on this computer has it, so the New chat pane doesn't show first.
  const [selectedId, setSelectedId] = useState<string | null>(() => (reopening && chats.some((c) => c.id === reopening) ? reopening : null));
  const [listOpen, setListOpen] = useState(true);
  const [draftError, setDraftError] = useState<string>();
  const [toast, setToast] = useState<Toast | null>(notSaved ? { text: notSaved, at: Date.now() } : null);
  const [searchOpen, setSearchOpen] = useState(false);
  // The search result the chat on screen was opened from; `at` tells one pick from the next.
  const [picked, setPicked] = useState<{ found: Found; at: number } | null>(null);
  // What the preview pane beside the chat shows; null when it is closed. `previewHidden`: in a window too narrow for
  // both, the pane covers the chat, and the owner has gone back to the chat without closing it.
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [previewHidden, setPreviewHidden] = useState(false);
  // Counts what has been opened, so opening the same file again loads it again.
  const [previewSeq, setPreviewSeq] = useState(0);
  // The width while the owner drags the pane's edge; it is kept in the display preferences once they let go.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const openPreview = useCallback((t: PreviewTarget) => {
    setPreview(t);
    setPreviewHidden(false);
    setPreviewSeq((n) => n + 1);
  }, []);
  const mainRef = useRef<HTMLElement>(null);
  const mainWidth = useWidth(mainRef);

  // No chat selected means a fresh draft; the Hermes session is created on the first message.
  const draft: Chat = {
    id: "draft",
    title: "New chat",
    source: "app",
    settled: false,
    updatedAt: Date.now(),
    items: draftError ? [{ kind: "error", id: "e-draft", text: draftError }] : [],
  };
  const selected = chats.find((c) => c.id === selectedId) ?? draft;
  // Projects are Hermes's, one store for each connection and profile; which chats are in each is kept on this computer.
  // A project picked in the switcher narrows the list to its chats. Active, Settled and Unread work as before inside it.
  const scope = projectScope(connection, profile);
  // Keep the same store and request queue when returning to a profile: a write still finishing for that profile
  // must share ordering with its new reads and writes, rather than commit from an abandoned snapshot.
  const projectStores = useMemo(() => new Map<string, ProjectsStore>(), [hermes]);
  const projects = useMemo(() => {
    let store = projectStores.get(scope);
    if (!store) {
      store = new ProjectsStore(hermes.projects, savedProjects, scope, profile);
      projectStores.set(scope, store);
    }
    return store;
  }, [hermes, scope, projectStores]);
  const proj = useSyncExternalStore(projects.subscribe, projects.getSnapshot);
  const listable = proj.projects.filter((p) => !p.archived);
  const shownProject = listable.find((p) => p.id === proj.selectedId);
  const projectScreenOpen = projectOpen && !!shownProject;
  const inShown = shownProject && new Set(proj.chats[shownProject.id] ?? []);
  const listed = inShown ? chats.filter((c) => inShown.has(c.id)) : chats;
  const unreadChats = chats.filter((c) => c.unread && !c.archived);
  const projectUnread: ProjectUnread = {
    all: unreadChats.length,
    hidden: inShown ? unreadChats.filter((c) => !inShown.has(c.id)).length : 0,
    of: (id) => unreadChats.filter((c) => proj.chats[id]?.includes(c.id)).length,
  };
  const projectNames = (chatId: string) => listable.filter((p) => proj.chats[p.id]?.includes(chatId)).map((p) => p.name);
  const where = routeLabel(route) ?? (connection.mode === "ssh" ? `ssh://${connection.sshTarget}` : connection.url) ?? undefined;

  // What the owner has typed and not sent, kept for each chat on this connection and profile.
  const draftOf = (chatId: string | null) => draftKey(connection, profile, chatId);
  // An answer that comes after the owner switched profile belongs to the profile left, so it isn't shown.
  const stillIn = (p: string) => hermes.profile === p;
  const shownDraft = draftOf(selectedId);
  const composerText = useSyncExternalStore(savedDrafts.subscribe, () => savedDrafts.get(shownDraft));

  // The model pick is sticky: new chats start on it, in this profile, until the owner picks another. It is kept on this
  // computer only and never becomes the profile's default. Picked in another profile, it gives way to this profile's
  // own model. A chat on screen shows the model it runs on, and a pick there switches that chat alone.
  const { modelPicker, modelFavorites, previewWidth } = useSyncExternalStore(subscribeUIPrefs, getUIPrefs);
  const catalog = models?.profile === profile ? models : undefined;
  const sticky: ModelPick | undefined = modelPicker?.profile === profile ? withoutProfile(modelPicker) : catalog?.defaultPick;
  const shownModel = (selected !== draft && selected.model) || sticky;
  const pickModel = (pick: ModelPick) => {
    setUIPrefs({ modelPicker: { ...pick, profile } });
    if (selected === draft) return;
    const id = selected.id;
    hermes.setModel(id, pick).catch((e) => stillIn(profile) && setToast({ text: `Couldn't switch this chat's model: ${messageOf(e)}`, at: Date.now() }));
  };

  // Every move between chats is kept as the profile's last open chat, so it reopens at the next launch whether or not
  // the app closes cleanly. Going somewhere also ends the wait to reopen the last one.
  const openChat = (id: string | null, remember = true) => {
    setPreviewHidden(true);
    setSelectedId(id);
    setReopening(undefined);
    setPicked(null);
    setSettingsOpen(false);
    setProjectOpen(false);
    if (remember) rememberOpenChat(profile, id);
  };

  const newChat = (remember = true) => {
    openChat(null, remember);
    setDraftError(undefined);
  };

  const pick = (found: Found) => {
    setPreviewHidden(true);
    hermes.reveal(found);
    setSelectedId(found.chatId);
    setReopening(undefined);
    rememberOpenChat(profile, found.chatId);
    setPicked({ found, at: Date.now() });
    setSearchOpen(false);
    setSettingsOpen(false);
    setProjectOpen(false);
  };
  const findTarget =
    picked?.found.chatId === selected.id && picked.found.find
      ? { query: picked.found.find, itemId: hermes.locate(picked.found), at: picked.at }
      : undefined;

  /** The chat to send in: the one on screen, or a new one started now for the New chat pane. */
  const chatToSendIn = async (): Promise<{ id: string } | { delivery: Delivery }> => {
    if (selectedId) return { id: selectedId };
    const into = projects.getSnapshot().selectedId;
    try {
      const id = await hermes.newChat(sticky);
      // A chat started while the list shows a project goes in it, so it stays in the list.
      if (into && projects.getSnapshot().projects.some((p) => p.id === into)) projects.setChat(into, id, true);
      openChat(id);
      return { id };
    } catch (e) {
      const reason = `Couldn't start a chat: ${e instanceof Error ? e.message : String(e)}`;
      if (stillIn(profile)) setDraftError(reason);
      return { delivery: { delivery: "unsent", reason } };
    }
  };

  // The composer empties as the message goes. In a chat, the message shows there from the start, and if Hermes doesn't
  // take it, or may not have, it stays there marked so, with Retry. If a new chat can't be started, there is no chat to
  // show it in, so its text comes back into the composer.
  const send = async (text: string, attachments: Attachment[]) => {
    const typed = savedDrafts.take(shownDraft);
    const to = await chatToSendIn();
    if ("delivery" in to) return savedDrafts.putBack(draftOf(null), typed);
    await hermes.send(to.id, text, attachments);
  };

  // Only the owner sends a failed message again; reconnecting never does. Editing one takes its words back into the
  // composer, to go as a new message.
  const retry = (itemId: string) => void hermes.retry(selected.id, itemId);
  const edit = (itemId: string) => {
    const row = selected.items.find((i) => i.id === itemId);
    if (row?.kind !== "user") return;
    const typed = savedDrafts.get(shownDraft);
    savedDrafts.set(shownDraft, typed ? `${typed}\n\n${row.text}` : row.text);
    hermes.dismiss(selected.id, itemId);
  };

  // The other profile's chats replace the list, so the pane starts a fresh draft. The profile left keeps its last open
  // chat for the next launch, and each chat's draft. The list asks first if a reply is running or an Approval waiting.
  const switchProfile = (name: string) => {
    newChat(false);
    setProjectOpen(false);
    setToast(null);
    // A Server file is read for the profile shown, so it doesn't carry over.
    setPreview(null);
    void hermes.switchProfile(name);
  };

  // Undo sends the opposite change, not a stored copy, so it also works once the list has refreshed.
  const setSettled = (id: string, settled: boolean) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    const move = (s: boolean) => void (s ? hermes.settle(id) : hermes.unsettle(id));
    move(settled);
    setToast({ text: `${settled ? "Settled" : "Moved to Active"}: ${title}`, undo: () => move(!settled), at: Date.now() });
  };

  // Putting a chat in a project, or taking it out, is kept on this computer only; Undo puts it back.
  const setInProject = (chatId: string, p: Project, inProject: boolean) => {
    const title = chats.find((c) => c.id === chatId)?.title ?? "";
    projects.setChat(p.id, chatId, inProject);
    setToast({
      text: `${inProject ? `Put in ${p.name}` : `Taken out of ${p.name}`}: ${title}`,
      undo: () => projects.setChat(p.id, chatId, !inProject),
      at: Date.now(),
    });
  };

  // Deleting can't be undone, so the row asked first. The chat on screen gives way to a fresh draft. A refused
  // delete says why in the list instead of the toast.
  const deleteChat = (id: string) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    if (id === selectedId) newChat();
    void hermes.delete(id).then((deleted) => {
      if (!deleted) return;
      projects.forgetChat(id);
      if (stillIn(profile)) setToast({ text: `Deleted: ${title}`, at: Date.now() });
    });
  };

  // One Save dialog at a time: a second click while it is open does nothing.
  const exporting = useRef(false);
  const exportSelected = (chat: Chat) => {
    if (exporting.current) return;
    exporting.current = true;
    void exportChat(chat)
      .then((text) => text && setToast({ text, at: Date.now() }))
      .finally(() => (exporting.current = false));
  };

  // Archiving hides the chat in every Hermes client and keeps its history; the toast shows once Hermes confirms it. The
  // chat on screen gives way to a fresh draft, as it leaves the list. A write that didn't go in says why in the list.
  const setArchived = (id: string, archived: boolean) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    if (archived && id === selectedId && !archivedListed) newChat();
    const done = (ok: boolean) =>
      ok &&
      stillIn(profile) &&
      setToast({ text: `${archived ? "Archived" : "Restored"}: ${title}`, undo: archived ? () => setArchived(id, false) : undefined, at: Date.now() });
    void (archived ? hermes.archive(id) : hermes.restore(id)).then(done);
  };

  // The chat to reopen opens as soon as the list has it, the saved one at first, and stays open once the list read from
  // Hermes has it too. If that list doesn't, the chat was deleted, archived, or is older than the list reaches: the New
  // chat pane shows instead, and the chat isn't looked for at the next launch.
  useEffect(() => {
    if (!reopening) return;
    const listed = hermes.hasListed();
    if (chats.some((c) => c.id === reopening)) {
      setSelectedId(reopening);
      if (!listed) return;
    } else if (listed) {
      setSelectedId(null);
      forgetOpenChat(profile, reopening);
    } else return;
    setReopening(undefined);
  }, [hermes, reopening, chats, profile]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  // Out of focus, Hermes notifies instead of marking the chat on screen read (transport.ts `setFocused`).
  useEffect(() => {
    hermes.setFocused(document.hasFocus());
    const onFocus = () => hermes.setFocused(true);
    const onBlur = () => hermes.setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [hermes]);

  // An opened chat shows its stored history and is marked read; a chat already open on this connection is left as it
  // is. Until connected it shows its Saved copy, and after a reconnect it loads again. Settings covers the chat, so it
  // isn't on screen meanwhile.
  useEffect(() => {
    if (!selectedId || settingsOpen || projectScreenOpen) return;
    void hermes.open(selectedId);
    return () => hermes.leave(selectedId);
  }, [hermes, selectedId, status, settingsOpen, projectScreenOpen]);

  // The profile's projects, read once connected, and again for each profile.
  useEffect(() => {
    if (status === "connected") void projects.load();
  }, [projects, status]);

  // Back on the network: don't wait for the next retry, or for the owner if it gave up.
  useEffect(() => {
    const onOnline = () => void hermes.reconnect();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [hermes]);

  useEffect(() => {
    void hermes.sync();
    const timer = setInterval(() => void hermes.sync(), SYNC_EVERY_MS);
    return () => clearInterval(timer);
  }, [hermes]);

  // The models the profile offers, read once connected, and again for each profile.
  useEffect(() => {
    if (status === "connected") void hermes.loadModels();
  }, [hermes, status, profile]);

  // Switching profile reseeds the pick to that profile's own model, once its list is read.
  useEffect(() => {
    const pick = getUIPrefs().modelPicker;
    if (catalog?.defaultPick && pick?.profile !== profile) setUIPrefs({ modelPicker: { ...catalog.defaultPick, profile } });
  }, [catalog, profile]);

  // Unread chats in the other profiles are polled, so the switcher can be up to CHECK_EVERY_MS behind.
  useEffect(() => {
    void hermes.checkOtherProfiles();
    const timer = setInterval(() => void hermes.checkOtherProfiles(), CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [hermes]);

  useEffect(() => {
    // Only Ctrl/Cmd chords, and never mid-composition. No bare key does anything app-wide, so nothing typed
    // with focus outside an input can answer an Approval or stop a reply.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || composing(e)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (k === "n") {
        e.preventDefault();
        newChat();
      } else if (k === "b") {
        e.preventDefault();
        setListOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Side by side when the chat keeps its minimum width beside the narrowest pane; otherwise the pane covers the chat.
  // Width 0 means it couldn't be measured, which counts as wide.
  const previewFits = !mainWidth || mainWidth >= CHAT_MIN_WIDTH + PANE_MIN_WIDTH;
  const paneMax = mainWidth ? mainWidth - CHAT_MIN_WIDTH : 1200;
  const paneWidth = Math.min(Math.max(dragWidth ?? previewWidth ?? PREVIEW_DEFAULT_WIDTH, PANE_MIN_WIDTH), Math.max(PANE_MIN_WIDTH, paneMax));
  // Settings and the project screen cover the chat, and the pane with it.
  const previewShown = !!preview && !settingsOpen && !projectScreenOpen && (previewFits || !previewHidden);
  const previewCovers = previewShown && !previewFits;

  return (
    <PreviewContext.Provider value={openPreview}>
      <div className="app">
        <Rail
          status={status}
          route={route}
          unsecure={unsecure}
          closedReason={closedReason}
          onReconnect={() => void hermes.reconnect()}
          onToggleList={() => setListOpen((o) => !o)}
          onNew={() => newChat()}
          onSearch={() => setSearchOpen(true)}
          onSettings={() => {
            setSettingsOpen(true);
            setProjectOpen(false);
          }}
        />
        {listOpen && (
          <ChatList
            profile={profile}
            projectSwitcher={
              <ProjectSwitcher
                projects={listable}
                selected={shownProject}
                unread={projectUnread}
                loading={proj.loading}
                error={proj.error}
                connected={status === "connected"}
                onOpen={() => status === "connected" && void projects.load()}
                onSelect={(id) => {
                  projects.select(id);
                  if (!id) setProjectOpen(false);
                }}
                onCreate={async (name) => {
                  await projects.create(name);
                  setSettingsOpen(false);
                  setProjectOpen(true);
                }}
                onManage={() => {
                  setSettingsOpen(false);
                  setProjectOpen(true);
                }}
              />
            }
            projectsOf={(chatId) => {
              if (!listable.length) return undefined;
              const of = projects.projectsOf(chatId);
              return { list: listable, of, onToggle: (id, on) => setInProject(chatId, listable.find((p) => p.id === id)!, on) };
            }}
            switching={switching}
            status={status}
            others={others}
            chats={listed}
            archivedListed={archivedListed}
            syncError={syncError}
            selectedId={settingsOpen || projectScreenOpen ? null : selectedId}
            onOpen={openChat}
            onSettle={setSettled}
            onArchive={setArchived}
            onListArchived={(on) => void hermes.listArchived(on)}
            onDelete={deleteChat}
            onRename={(id, title, from) => hermes.rename(id, title, from)}
            onRegenTitle={(id) => hermes.regenerateTitle(id)}
            onListProfiles={() => hermes.profiles()}
            onCheckOthers={() => void hermes.checkOtherProfiles()}
            onSwitchProfile={switchProfile}
            onRetrySwitch={() => void (status === "connected" ? hermes.sync() : hermes.reconnect())}
          />
        )}
        <main className="main" ref={mainRef}>
          <div className="main-chat" inert={previewCovers || undefined}>
            {projectScreenOpen && shownProject && !settingsOpen ? (
              <ProjectScreen
                key={shownProject.id}
                project={shownProject}
                profile={profile}
                connection={where}
                connected={status === "connected"}
                chats={listed.length}
                unlisted={(proj.chats[shownProject.id]?.length ?? 0) - listed.length}
                onRename={(name) => projects.rename(shownProject.id, name)}
                onDelete={async () => {
                  const { name } = shownProject;
                  await projects.delete(shownProject.id);
                  setProjectOpen(false);
                  if (stillIn(profile)) setToast({ text: `Deleted the project ${name}. Its chats and folders are kept.`, at: Date.now() });
                }}
                onAddFolder={(path) => projects.addFolder(shownProject.id, path)}
                onRemoveFolder={(path) => projects.removeFolder(shownProject.id, path)}
                readFolder={async (path) => {
                  const [problem, worktrees] = await Promise.all([
                    hermes.projects.checkFolder(profile, path).then(
                      () => undefined,
                      (e) => messageOf(e),
                    ),
                    hermes.projects.worktrees(path).catch(() => []),
                  ]);
                  return { problem, worktrees };
                }}
                onClose={() => setProjectOpen(false)}
              />
            ) : settingsOpen ? (
              <SettingsScreen
                status={status}
                route={route}
                unsecure={unsecure}
                username={connection.username}
                passwordSaved={kept.password}
                headersSaved={kept.headers}
                headers={route?.kind === "url" ? headers : []}
                profile={profile}
                olderPulled={olderPulled}
                cacheBytes={() => hermes.cacheBytes()}
                appearance={appearance}
                listFonts={systemFonts}
                modelSettings={hermes.modelSettings}
                onClearCache={() => hermes.clearCache()}
                onPullOlder={() => hermes.pullOlderHistory()}
                onSignOut={onSignOut}
                onClose={() => setSettingsOpen(false)}
              />
            ) : (
              <ChatPane
                key={`${profile}/${selected.id}`}
                chat={selected}
                notLoaded={selected !== draft && status !== "connected" && !selected.runtimeId && selected.items.every(isOutgoing)}
                findTarget={findTarget}
                status={status}
                alsoPostsIn={hermes.alsoPostsIn(selected.id)}
                draft={composerText}
                onDraft={(text) => savedDrafts.set(shownDraft, text)}
                onRetry={retry}
                onEdit={edit}
                onDismiss={(itemId) => hermes.dismiss(selected.id, itemId)}
                onAttach={(paths) => hermes.checkAttachments(paths)}
                onSend={send}
                onStop={() => void hermes.stop(selected.id)}
                onAnswer={(approvalId, choice, confirmed) => void hermes.answerApproval(selected.id, approvalId, choice, confirmed)}
                onSettle={selected === draft ? undefined : (s) => setSettled(selected.id, s)}
                onExport={selected === draft ? undefined : () => exportSelected(selected)}
                onArchive={selected === draft ? undefined : (a) => setArchived(selected.id, a)}
                onUsage={selected === draft ? undefined : () => void hermes.refreshUsage(selected.id)}
                projects={selected === draft ? (shownProject ? [shownProject.name] : undefined) : projectNames(selected.id)}
                headActions={
                  <button
                    className={`icon-btn ${previewShown ? "on" : ""}`}
                    title={!preview ? "Open the preview" : previewShown ? "Close the preview" : "Show the preview"}
                    aria-pressed={previewShown}
                    onClick={() => (!preview ? openPreview({ kind: "start" }) : previewShown ? setPreview(null) : setPreviewHidden(false))}
                  >
                    <PanelRight size={16} />
                  </button>
                }
                footer={
                  <StatusBar
                    chat={selected}
                    status={status}
                    onYolo={(on) => hermes.setYolo(selected.id, on)}
                    onBreakdown={() => hermes.contextBreakdown(selected.id)}
                  />
                }
                modelControls={
                  <ModelControls
                    catalog={catalog}
                    current={shownModel}
                    defaultEffort={catalog?.defaultEffort}
                    favorites={modelFavorites}
                    onPick={pickModel}
                    onToggleFavorite={toggleModelFavorite}
                  />
                }
              />
            )}
          </div>
          {preview && previewShown && (
            <PreviewPane
              key={previewSeq}
              target={preview}
              serverLabel={serverLabel(route)}
              readServer={(path) => hermes.readServerFile(path)}
              local={localFiles}
              overlay={!previewFits}
              width={paneWidth}
              maxWidth={paneMax}
              onResize={(w, done) => {
                setDragWidth(done ? null : w);
                if (done) setUIPrefs({ previewWidth: w });
              }}
              onOpen={openPreview}
              onHide={() => setPreviewHidden(true)}
              onClose={() => setPreview(null)}
            />
          )}
        </main>
        {searchOpen && <SearchPalette onSearch={(q, archived) => hermes.search(q, { archived })} onPick={pick} onClose={() => setSearchOpen(false)} />}
        {toast && (
          <div className="toast" key={toast.at} role="status">
            <span>{toast.text}</span>
            {toast.undo && (
              <button
                onClick={() => {
                  toast.undo?.();
                  setToast(null);
                }}
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>
    </PreviewContext.Provider>
  );
}
