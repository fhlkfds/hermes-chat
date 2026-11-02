import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connect, readSaved, type Delivery, type Hermes } from "./hermes/transport";
import { CHECK_EVERY_MS } from "./hermes/otherProfiles";
import { type Account, type SavedSignIn, launchSignIn, savedSignIn, signIn, signOut } from "./hermes/account";
import { localChatCache } from "./hermes/chatCache";
import { draftKey, drafts } from "./hermes/drafts";
import { chatToReopen, forgetOpenChat, rememberOpenChat } from "./hermes/uiPrefs";
import { exportChat } from "./hermes/exportChat";
import { systemKeyring } from "./hermes/tauriKeyring";
import { desktopNotify } from "./hermes/tauriNotify";
import { tauriPipe, type SignInDetails } from "./hermes/tauriPipe";
import { type Attachment, type Chat, type Found, isOutgoing } from "./hermes/model";
import type { ModelPick } from "./hermes/models";
import { ChatList, Rail } from "./ui/Sidebar";
import { ChatPane } from "./ui/ChatPane";
import { SearchPalette } from "./ui/Search";
import { SettingsScreen } from "./ui/Settings";
import { composing } from "./ui/bits";
import { appearanceStore } from "./ui/appearance";
import { StatusBar } from "./ui/StatusBar";
import { systemFonts } from "./ui/tauriFonts";
import { SignIn } from "./ui/SignIn";
import { ModelControls } from "./ui/ModelPicker";
import { getUIPrefs, setUIPrefs, subscribe as subscribeUIPrefs, toggleModelFavorite, type StickyModelPick } from "./hermes/uiPrefs";

const SAVED = "hermes-chat.sign-in"; // Everything but the password, which is in the system keyring.
// Hermes also announces store changes over the socket; the poll catches anything it misses.
const SYNC_EVERY_MS = 60_000;
const TOAST_MS = 5_000;

/** A short notice above the composer; `undo` puts back what it reports. `at` restarts the timer for a repeat. */
type Toast = { text: string; undo?: () => void; at: number };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const withoutProfile = ({ profile: _profile, ...pick }: StickyModelPick): ModelPick => pick;

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
  store: { load: loadSignIn, save: (d) => localStorage.setItem(SAVED, JSON.stringify(d)) },
  connect: (d) => connect(tauriPipe(d), undefined, localChatCache(d), desktopNotify),
  readSaved: (d, reason) => readSaved(tauriPipe(d), reason, localChatCache(d), desktopNotify),
};

const savedDrafts = drafts(localStorage);
// Applied as the app loads, so the chosen fonts show from the first screen.
const appearance = appearanceStore(localStorage, document.documentElement);

/** What launch ends in: signed in with the saved password, or the sign-in screen and why. */
type Launch = { hermes: Hermes } | { initial: SignInDetails; error?: string };
let launching: Promise<Launch> | undefined;

/**
 * Signs in with the saved password, if there is one; if Hermes can't be reached, what this computer saved opens to
 * read. If that fails the sign-in screen has it filled in, so Connect tries again. Runs once, though StrictMode runs
 * effects twice.
 */
function launch(): Promise<Launch> {
  return (launching ??= (async () => {
    const saved = await savedSignIn(account);
    if (!saved) return { initial: { ...loadSignIn(), password: "" } };
    try {
      return { hermes: await launchSignIn(saved, account) };
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
  // Only the first sign-in after the app starts reopens the last chat; signing in again after Sign out starts fresh.
  const [coldStart, setColdStart] = useState(true);

  useEffect(() => {
    void launch().then((l) => {
      if ("hermes" in l) return setHermes(l.hermes);
      setInitial(l.initial);
      setError(l.error);
    });
  }, []);

  if (hermes)
    return (
      <Main
        hermes={hermes}
        connection={account.store.load()}
        notSaved={notSaved}
        reopenLast={coldStart}
        onSignOut={async () => {
          let failure: string | undefined;
          try {
            await signOut(hermes, account);
          } catch (e) {
            failure = messageOf(e);
          }
          setHermes(null);
          setColdStart(false);
          setNotSaved(undefined);
          setInitial({ ...loadSignIn(), password: "" });
          setError(failure);
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
          const { hermes: h, notSaved } = await signIn(d, account);
          setNotSaved(notSaved);
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
  notSaved,
  reopenLast = false,
  onSignOut,
}: {
  hermes: Hermes;
  connection: SavedSignIn;
  notSaved?: string;
  /** This is the app starting: open the profile's last open chat, if the owner wants it reopened. */
  reopenLast?: boolean;
  onSignOut: () => Promise<void>;
}) {
  const { profile, chats, olderPulled, archivedListed, status, route, unsecure, closedReason, syncError, others, models } = useSyncExternalStore(
    hermes.subscribe,
    hermes.getSnapshot,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  // What the owner has typed and not sent, kept for each chat on this connection and profile.
  const draftOf = (chatId: string | null) => draftKey(connection, profile, chatId);
  const shownDraft = draftOf(selectedId);
  const composerText = useSyncExternalStore(savedDrafts.subscribe, () => savedDrafts.get(shownDraft));

  // The model pick is sticky: new chats start on it, in this profile, until the owner picks another. It is kept on this
  // computer only and never becomes the profile's default. Picked in another profile, it gives way to this profile's
  // own model. A chat on screen shows the model it runs on, and a pick there switches that chat alone.
  const { modelPicker, modelFavorites } = useSyncExternalStore(subscribeUIPrefs, getUIPrefs);
  const catalog = models?.profile === profile ? models : undefined;
  const sticky: ModelPick | undefined = modelPicker?.profile === profile ? withoutProfile(modelPicker) : catalog?.defaultPick;
  const shownModel = (selected !== draft && selected.model) || sticky;
  const pickModel = (pick: ModelPick) => {
    setUIPrefs({ modelPicker: { ...pick, profile } });
    if (selected === draft) return;
    const id = selected.id;
    hermes.setModel(id, pick).catch((e) => setToast({ text: `Couldn't switch this chat's model: ${messageOf(e)}`, at: Date.now() }));
  };

  // Every move between chats is kept as the profile's last open chat, so it reopens at the next launch whether or not
  // the app closes cleanly. Going somewhere also ends the wait to reopen the last one.
  const openChat = (id: string | null, remember = true) => {
    setSelectedId(id);
    setReopening(undefined);
    setPicked(null);
    setSettingsOpen(false);
    if (remember) rememberOpenChat(profile, id);
  };

  const newChat = (remember = true) => {
    openChat(null, remember);
    setDraftError(undefined);
  };

  const pick = (found: Found) => {
    hermes.reveal(found);
    setSelectedId(found.chatId);
    setReopening(undefined);
    rememberOpenChat(profile, found.chatId);
    setPicked({ found, at: Date.now() });
    setSearchOpen(false);
    setSettingsOpen(false);
  };
  const findTarget =
    picked?.found.chatId === selected.id && picked.found.find
      ? { query: picked.found.find, itemId: hermes.locate(picked.found), at: picked.at }
      : undefined;

  /** The chat to send in: the one on screen, or a new one started now for the New chat pane. */
  const chatToSendIn = async (): Promise<{ id: string } | { delivery: Delivery }> => {
    if (selectedId) return { id: selectedId };
    try {
      const id = await hermes.newChat(sticky);
      openChat(id);
      return { id };
    } catch (e) {
      const reason = `Couldn't start a chat: ${e instanceof Error ? e.message : String(e)}`;
      setDraftError(reason);
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
  // chat for the next launch.
  const switchProfile = (name: string) => {
    newChat(false);
    setToast(null);
    void hermes.switchProfile(name);
  };

  // Undo sends the opposite change, not a stored copy, so it also works once the list has refreshed.
  const setSettled = (id: string, settled: boolean) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    const move = (s: boolean) => void (s ? hermes.settle(id) : hermes.unsettle(id));
    move(settled);
    setToast({ text: `${settled ? "Settled" : "Moved to Active"}: ${title}`, undo: () => move(!settled), at: Date.now() });
  };

  // Deleting can't be undone, so the row asked first. The chat on screen gives way to a fresh draft. A refused
  // delete says why in the list instead of the toast.
  const deleteChat = (id: string) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    if (id === selectedId) newChat();
    void hermes.delete(id).then((deleted) => deleted && setToast({ text: `Deleted: ${title}`, at: Date.now() }));
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
      ok && setToast({ text: `${archived ? "Archived" : "Restored"}: ${title}`, undo: archived ? () => setArchived(id, false) : undefined, at: Date.now() });
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
    if (!selectedId || settingsOpen) return;
    void hermes.open(selectedId);
    return () => hermes.leave(selectedId);
  }, [hermes, selectedId, status, settingsOpen]);

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

  return (
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
        onSettings={() => setSettingsOpen(true)}
      />
      {listOpen && (
        <ChatList
          profile={profile}
          others={others}
          chats={chats}
          archivedListed={archivedListed}
          syncError={syncError}
          selectedId={settingsOpen ? null : selectedId}
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
        />
      )}
      <main className="main">
        {settingsOpen ? (
          <SettingsScreen
            status={status}
            route={route}
            unsecure={unsecure}
            username={connection.username}
            passwordSaved={!notSaved}
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
            key={selected.id}
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
            footer={
              <StatusBar
                chat={selected}
                status={status}
                onYolo={(on) => hermes.setYolo(selected.id, on)}
                onBreakdown={() => hermes.contextBreakdown(selected.id)}
              />
            }
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
  );
}
