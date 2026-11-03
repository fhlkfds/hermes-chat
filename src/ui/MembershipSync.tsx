// Which chats are in each project, between computers (ADR 0023, GLOSSARY.md "Project membership"): where it is kept,
// the preview before this computer's is copied to Hermes, the changes Hermes hasn't confirmed yet, and the ones that
// wait for the owner because another computer changed the same chat meanwhile.
import { useState } from "react";
import { ArrowLeft, CloudUpload, History, RefreshCw, TriangleAlert } from "lucide-react";
import type { MembershipOp } from "../hermes/membership";
import type { MembershipStatus, Project } from "../hermes/projects";
import { Spinner, relTime, storedTime } from "./bits";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const chatsText = (n: number) => `${n} ${n === 1 ? "chat" : "chats"}`;
const ago = (ts: number) => (relTime(ts) === "now" ? "just now" : `${relTime(ts)} ago`);

export function MembershipSync({
  status,
  projects,
  profile,
  connected,
  titleOf,
  onMigrate,
  onNotNow,
  onSync,
  onResolve,
  onRestore,
  onClose,
}: {
  status: MembershipStatus;
  /** Every project Hermes listed, archived ones included, for their names. */
  projects: Project[];
  profile: string;
  connected: boolean;
  /** A chat's title, if the list has it. */
  titleOf: (chatId: string) => string | undefined;
  onMigrate: () => Promise<void>;
  onNotNow: () => void;
  onSync: () => Promise<void>;
  onResolve: (id: string, keep: "mine" | "theirs") => Promise<void>;
  onRestore: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmRestore, setConfirmRestore] = useState(false);
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? "a project Hermes no longer has";
  const chatName = (id: string) => titleOf(id) ?? "A chat not in the list";

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(undefined);
    }
  };

  const offline = connected ? undefined : "Connect to Hermes first.";
  const waiting = status.pending.filter((o) => !o.conflict);
  const conflicts = status.pending.filter((o) => o.conflict);
  const plan = status.plan;

  return (
    <div className="settings project-screen membership-screen">
      <div className="settings-inner">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <h1>Chats in projects, between computers</h1>
        <p className="muted">
          Which chats are in each project of the <span className="mono">{profile}</span> profile.{" "}
          {status.mode === "synced"
            ? "Hermes keeps it, so every computer signed in to this profile shows the same."
            : status.mode === "offer"
              ? "This Hermes server can keep it, so every computer shows the same. Until this computer's is copied there, it stays on this computer."
              : status.supported === false
                ? "This Hermes server doesn't keep it, so it is kept on this computer, and another computer can show a chat in different projects."
                : "It is kept on this computer until Hermes has been asked whether it can keep it."}
        </p>
        {(error ?? status.error) && (
          <p className="sign-in-error small" role="alert">
            {error ?? `Couldn't sync with Hermes: ${status.error} Changes are kept on this computer and sent at the next sync.`}
          </p>
        )}

        {status.mode === "local" && status.supported === false && (
          <section>
            <h2>What Hermes needs</h2>
            <p className="muted">
              Hermes's project store has projects and their folders, but no record of which chats are in a project. Hermes Chat syncs it once
              Hermes answers the projects list with <span className="mono">chat_membership</span> and has <span className="mono">projects.chats.list</span>{" "}
              and <span className="mono">projects.chats.apply</span>. Until then nothing is sent, and nothing about it is stored on the server.
            </p>
          </section>
        )}

        {status.mode === "local" && status.supported && (
          <section>
            <h2>Kept on this computer for now</h2>
            <p className="muted">You chose Not now. Hermes Chat asks again the next time it starts.</p>
          </section>
        )}

        {status.mode === "offer" && plan && (
          <section aria-labelledby="sync-preview">
            <h2 id="sync-preview">
              <CloudUpload size={15} /> Copy this computer's to Hermes
            </h2>
            <p className="muted">Nothing changes in Hermes until you copy. Chats already in a project in Hermes stay in it.</p>
            <ul className="sync-plan">
              <li>
                <strong>{chatsText(plan.add.length)}</strong> will be added to {plan.add.length === 1 ? "its project" : "their projects"} in Hermes
                {plan.add.length > 0 && ":"}
                {plan.add.length > 0 && (
                  <ul>
                    {Object.entries(plan.byProject).map(([id, n]) => (
                      <li key={id}>
                        {nameOf(id)}: {chatsText(n)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
              <li>
                <strong>{chatsText(plan.already)}</strong> {plan.already === 1 ? "is" : "are"} already there, and won't be added twice.
              </li>
              {plan.takenOut.length > 0 && (
                <li>
                  <strong>{chatsText(plan.takenOut.length)}</strong> {plan.takenOut.length === 1 ? "was" : "were"} taken out of{" "}
                  {plan.takenOut.length === 1 ? "its project" : "their projects"} on another computer, and will stay out:
                  <ul>
                    {plan.takenOut.map((x) => (
                      <li key={`${x.project} ${x.chat}`}>
                        {chatName(x.chat)} in {nameOf(x.project)}
                      </li>
                    ))}
                  </ul>
                </li>
              )}
              {plan.skipped > 0 && (
                <li>
                  <strong>{chatsText(plan.skipped)}</strong> {plan.skipped === 1 ? "is" : "are"} in projects Hermes no longer has, or has archived, and
                  won't be copied.
                </li>
              )}
            </ul>
            <p className="muted small">
              This computer's copy is kept as it is now, so its chats can be put back later. From then on, the list shows what Hermes has.
            </p>
            <div className="confirm-actions sync-actions">
              <button className="btn" disabled={!!busy} onClick={onNotNow}>
                Not now
              </button>
              <button className="btn primary" disabled={!connected || !!busy} title={offline} onClick={() => void run("migrate", onMigrate)}>
                {busy === "migrate" ? <Spinner /> : <CloudUpload size={14} />} Copy to Hermes
              </button>
            </div>
          </section>
        )}

        {status.mode === "synced" && (
          <section>
            <h2>Sync</h2>
            <div className="settings-row">
              <p className="muted">
                {status.syncing
                  ? "Syncing with Hermes…"
                  : status.readAt
                    ? `Read from Hermes ${ago(status.readAt)}.`
                    : connected
                      ? "Not read from Hermes since Hermes Chat started."
                      : "Not connected: the list shows what Hermes had at the last read, with this computer's changes on top."}
                {status.supported === false && " This Hermes server no longer says it keeps membership, so changes wait here."}
              </p>
              <button className="btn" disabled={!connected || !!busy || status.syncing} title={offline} onClick={() => void run("sync", onSync)}>
                {status.syncing ? <Spinner /> : <RefreshCw size={14} />} Sync now
              </button>
            </div>
          </section>
        )}

        {conflicts.length > 0 && (
          <section aria-labelledby="sync-conflicts">
            <h2 id="sync-conflicts" className="warn-text">
              <TriangleAlert size={15} /> {conflicts.length === 1 ? "A change needs" : `${conflicts.length} changes need`} your decision
            </h2>
            <p className="muted">
              Another computer changed {conflicts.length === 1 ? "this chat" : "these chats"} in the same project after this computer's change was
              made. Until you decide, the list shows what Hermes has.
            </p>
            <ul className="sync-ops">
              {conflicts.map((o) => (
                <ConflictRow key={o.id} op={o} chat={chatName(o.chat)} project={nameOf(o.project)} busy={!!busy} connected={connected} onResolve={(keep) => run(`resolve ${o.id}`, () => onResolve(o.id, keep))} />
              ))}
            </ul>
          </section>
        )}

        {waiting.length > 0 && (
          <section aria-labelledby="sync-waiting">
            <h2 id="sync-waiting">Waiting to sync</h2>
            <p className="muted">
              {connected ? "Hermes hasn't confirmed these yet." : "These are sent when Hermes Chat is connected again."} Until then they're kept on
              this computer, and the list shows them.
            </p>
            <ul className="sync-ops">
              {waiting.map((o) => (
                <li key={o.id} className="sync-op">
                  <span className="badge">Waiting</span>
                  <span>
                    {o.member ? "Put" : "Take"} <strong>{chatName(o.chat)}</strong> {o.member ? "in" : "out of"} {nameOf(o.project)}
                  </span>
                  <span className="muted small">{ago(o.at)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {status.recovery && (
          <section>
            <h2>
              <History size={15} /> This computer's copy
            </h2>
            <div className="settings-row">
              <p className="muted">
                Kept from {storedTime(status.recovery.at)}, when it was copied to Hermes.{" "}
                {status.restorable
                  ? `${chatsText(status.restorable)} in it ${status.restorable === 1 ? "isn't" : "aren't"} in ${status.restorable === 1 ? "its project" : "their projects"} in Hermes now.`
                  : "Every chat in it is in its project in Hermes."}
              </p>
              {!confirmRestore ? (
                <button className="btn" disabled={!connected || !status.restorable || !!busy} title={offline} onClick={() => setConfirmRestore(true)}>
                  Put them back…
                </button>
              ) : (
                <div className="confirm" role="alertdialog" aria-label="Put chats back?" onKeyDown={(e) => e.key === "Escape" && setConfirmRestore(false)}>
                  <span>
                    Put {chatsText(status.restorable)} back in {status.restorable === 1 ? "its project" : "their projects"}, on every computer? Chats
                    taken out on another computer go back in too.
                  </span>
                  <div className="confirm-actions">
                    <button className="btn" autoFocus onClick={() => setConfirmRestore(false)}>
                      Cancel
                    </button>
                    <button
                      className="btn"
                      disabled={!!busy}
                      onClick={() => void run("restore", onRestore).then(() => setConfirmRestore(false))}
                    >
                      Put back
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function ConflictRow({
  op,
  chat,
  project,
  busy,
  connected,
  onResolve,
}: {
  op: MembershipOp;
  chat: string;
  project: string;
  busy: boolean;
  connected: boolean;
  onResolve: (keep: "mine" | "theirs") => Promise<void>;
}) {
  const theirs = op.conflict!.member;
  return (
    <li className="sync-op conflict">
      <span className="badge warn">Conflict</span>
      <span className="sync-op-text">
        <strong>{chat}</strong> in {project}: this computer {op.member ? "put it in" : "took it out"} {ago(op.at)}; in Hermes it is now{" "}
        {theirs ? "in" : "out"}.
      </span>
      <span className="sync-op-actions">
        <button className="btn" disabled={busy} onClick={() => void onResolve("theirs")}>
          Keep it {theirs ? "in" : "out"}
        </button>
        <button className="btn" disabled={busy || !connected} title={connected ? undefined : "Connect to Hermes first."} onClick={() => void onResolve("mine")}>
          {op.member ? "Put it in" : "Take it out"}
        </button>
      </span>
    </li>
  );
}
