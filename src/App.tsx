import { useEffect, useState, useSyncExternalStore } from "react";
import { connect, readSaved, type Delivery, type Hermes } from "./hermes/transport";
import { CHECK_EVERY_MS } from "./hermes/otherProfiles";
import { type Account, type SavedSignIn, launchSignIn, savedSignIn, signIn, signOut } from "./hermes/account";
import { localChatCache } from "./hermes/chatCache";
import { draftKey, drafts } from "./hermes/drafts";
import { systemKeyring } from "./hermes/tauriKeyring";
import { tauriPipe, type SignInDetails } from "./hermes/tauriPipe";
import type { Attachment, Chat, Found } from "./hermes/model";
import { ChatList, Rail } from "./ui/Sidebar";
import { ChatPane } from "./ui/ChatPane";
import { SearchPalette } from "./ui/Search";
import { SettingsScreen } from "./ui/Settings";
import { composing } from "./ui/bits";
import { SignIn } from "./ui/SignIn";

const SAVED = "hermes-chat.sign-in"; // Everything but the password, which is in the system keyring.
// Hermes also announces store changes over the socket; the poll catches anything it misses.
const SYNC_EVERY_MS = 60_000;
const TOAST_MS = 5_000;

/** A short notice above the composer; `undo` puts back what it reports. `at` restarts the timer for a repeat. */
type Toast = { text: string; undo?: () => void; at: number };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  connect: (d) => connect(tauriPipe(d), undefined, localChatCache(d)),
  readSaved: (d, reason) => readSaved(tauriPipe(d), reason, localChatCache(d)),
};

const savedDrafts = drafts(localStorage);

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
        onSignOut={async () => {
          let failure: string | undefined;
          try {
            await signOut(hermes, account);
          } catch (e) {
            failure = messageOf(e);
          }
          setHermes(null);
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
  onSignOut,
}: {
  hermes: Hermes;
  connection: SavedSignIn;
  notSaved?: string;
  onSignOut: () => Promise<void>;
}) {
  const { profile, chats, olderPulled, status, route, unsecure, closedReason, syncError, others } = useSyncExternalStore(
    hermes.subscribe,
    hermes.getSnapshot,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const undelivered = useSyncExternalStore(savedDrafts.subscribe, () => savedDrafts.undelivered(shownDraft));

  const openChat = (id: string | null) => {
    setSelectedId(id);
    setPicked(null);
    setSettingsOpen(false);
  };

  const newChat = () => {
    openChat(null);
    setDraftError(undefined);
  };

  const pick = (found: Found) => {
    hermes.reveal(found);
    setSelectedId(found.chatId);
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
      const id = await hermes.newChat();
      openChat(id);
      return { id };
    } catch (e) {
      const reason = `Couldn't start a chat: ${e instanceof Error ? e.message : String(e)}`;
      setDraftError(reason);
      return { delivery: { delivery: "unsent", reason } };
    }
  };

  // The composer empties as the message goes. If Hermes doesn't take it, the text comes back, in the new chat if one
  // was started; if Hermes may have it, it is held beside the composer until the owner sends it again or dismisses it.
  const send = async (text: string, attachments: Attachment[]) => {
    const typed = savedDrafts.take(shownDraft);
    const to = await chatToSendIn();
    if ("delivery" in to) return savedDrafts.afterSend(draftOf(null), typed, to.delivery);
    savedDrafts.afterSend(draftOf(to.id), typed, await hermes.send(to.id, text, attachments));
  };

  // Only the owner sends a held message again; reconnecting never does.
  const retry = (heldId: string) =>
    void savedDrafts.retry(shownDraft, heldId, async (text) => {
      const to = await chatToSendIn();
      return "delivery" in to ? to.delivery : hermes.send(to.id, text.trim());
    });

  // The other profile's chats replace the list, so the pane starts a fresh draft.
  const switchProfile = (name: string) => {
    newChat();
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

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

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
        onNew={newChat}
        onSearch={() => setSearchOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />
      {listOpen && (
        <ChatList
          profile={profile}
          others={others}
          chats={chats}
          syncError={syncError}
          selectedId={settingsOpen ? null : selectedId}
          onOpen={openChat}
          onSettle={setSettled}
          onDelete={deleteChat}
          onRename={(id, title, from) => hermes.rename(id, title, from)}
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
            onClearCache={() => hermes.clearCache()}
            onPullOlder={() => hermes.pullOlderHistory()}
            onSignOut={onSignOut}
            onClose={() => setSettingsOpen(false)}
          />
        ) : (
          <ChatPane
            key={selected.id}
            chat={selected}
            notLoaded={selected !== draft && status !== "connected" && !selected.runtimeId && !selected.items.length}
            findTarget={findTarget}
            status={status}
            alsoPostsIn={hermes.alsoPostsIn(selected.id)}
            draft={composerText}
            onDraft={(text) => savedDrafts.set(shownDraft, text)}
            undelivered={undelivered}
            onRetry={retry}
            onDismiss={(heldId) => savedDrafts.dismiss(shownDraft, heldId)}
            onAttach={(paths) => hermes.checkAttachments(paths)}
            onSend={send}
            onStop={() => void hermes.stop(selected.id)}
            onAnswer={(approvalId, choice) => void hermes.answerApproval(selected.id, approvalId, choice)}
            onSettle={selected === draft ? undefined : (s) => setSettled(selected.id, s)}
          />
        )}
      </main>
      {searchOpen && <SearchPalette onSearch={(q) => hermes.search(q)} onPick={pick} onClose={() => setSearchOpen(false)} />}
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
