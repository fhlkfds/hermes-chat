// Connection diagnostics (Settings → Diagnostics), and the note a screen shows in place of itself when the connected
// Hermes lacks what it needs (`CapabilityGate`). Both read the one capability store the transport keeps
// (src/hermes/capabilities.ts, ADR 0041).
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, ArrowLeft, BookOpen, Check, ClipboardCopy, RefreshCw, Stethoscope } from "lucide-react";
import {
  CAPABILITIES,
  type CapabilityId,
  type CapabilitySnapshot,
  type CapabilityState,
  type CapabilityStore,
  authLine,
  guideUrl,
  protocolText,
  reportText,
  sourceText,
  specOf,
  stateText,
  versionLine,
} from "../hermes/capabilities";
import { Spinner, relTime, storedTime } from "./bits";

/** Opens a compatibility guide page in the owner's browser. */
export type OpenGuide = (url: string) => void;

export const useCapabilities = (store: CapabilityStore): CapabilitySnapshot => useSyncExternalStore(store.subscribe, store.getSnapshot);

const BADGE: Record<CapabilityState, string> = { supported: "cap-ok", unsupported: "cap-no", unknown: "cap-unknown", unreachable: "cap-unknown" };

function StateBadge({ state }: { state: CapabilityState }) {
  return <span className={`badge cap-badge ${BADGE[state]}`}>{stateText(state)}</span>;
}

/** "Checked 2 min ago", with the exact time on hover. */
function Checked({ at, prefix = "Checked" }: { at?: number; prefix?: string }) {
  // Re-renders each minute so the relative time stays right.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  if (at === undefined) return <span>Not checked yet</span>;
  const ago = relTime(at) === "now" ? "just now" : `${relTime(at)} ago`;
  return (
    <time dateTime={new Date(at).toISOString()} title={storedTime(at)}>
      {prefix ? `${prefix} ${ago}` : ago}
    </time>
  );
}

/** The line above the feature list: checking, never checked, couldn't check, or when it was checked. */
function CheckStatus({ snap, connected }: { snap: CapabilitySnapshot; connected: boolean }) {
  if (snap.checking)
    return (
      <>
        <Spinner /> Checking what this Hermes server supports…
      </>
    );
  if (snap.checkedAt === undefined) return <>{connected ? "Checks start a moment after the connection opens." : "Connect to Hermes to check what it supports."}</>;
  if (!connected)
    return (
      <>
        Not connected: as last checked. <Checked at={snap.checkedAt} />.
      </>
    );
  return (
    <>
      <Checked at={snap.checkedAt} />. Checked again on each reconnect, and whenever Hermes reports another build.
    </>
  );
}

/**
 * Settings → Diagnostics: what the connected Hermes says it is, how this app signs in, and each capability's state with
 * how it was learnt and when. Check again reads it all afresh; Copy report puts a report with nothing secret on the
 * clipboard.
 */
export function DiagnosticsSettings({
  store,
  connected,
  server,
  signIn,
  headers,
  unsecure,
  profile,
  openGuide,
  focus,
  copyText = (text) => (navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard"))),
}: {
  store: CapabilityStore;
  connected: boolean;
  /** The connection's address, as the rest of Settings shows it. */
  server?: string;
  /** How this app signs in, in words. */
  signIn: string;
  /** How many extra request headers the connection sends; their values never reach this screen. */
  headers: number;
  unsecure: boolean;
  profile: string;
  openGuide: OpenGuide;
  /** A capability to bring into view and focus, from a screen's note. */
  focus?: { id: CapabilityId };
  /** Puts text on the clipboard. */
  copyText?: (text: string) => Promise<void>;
}) {
  const snap = useCapabilities(store);
  const [copied, setCopied] = useState<"done" | "failed">();
  const f = snap.facts;
  const focused = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (!focus) return;
    focused.current?.scrollIntoView?.({ block: "center" });
    focused.current?.focus();
  }, [focus]);
  // "Copied" stays only until the next change, so it never describes an older report.
  useEffect(() => setCopied(undefined), [snap]);

  const copy = () => {
    const text = reportText(snap, { app: "Hermes Chat", server, signIn, headers, unsecure, profile });
    copyText(text).then(
      () => setCopied("done"),
      () => setCopied("failed"),
    );
  };
  const probed = CAPABILITIES.filter((c) => c.probe);
  // Every check failed to get an answer, and the version couldn't be read: the server, not a feature, is the problem.
  const failed = !snap.checking && snap.checkedAt !== undefined && !!f.versionWhy && probed.every((c) => snap.caps[c.id].state === "unreachable");

  return (
    <div className="diagnostics">
      <section aria-labelledby="diag-server">
        <h2 id="diag-server">Server</h2>
        <p className="muted small">What the Hermes server says about itself. A version alone doesn't show what it can do, so each feature below is checked on its own.</p>
        <dl className="diag-facts">
          <dt>Server</dt>
          <dd>
            <span className="mono">{server ?? "Not connected"}</span> {unsecure && <span className="badge warn">Unsecure</span>}
          </dd>
          <dt>Profile</dt>
          <dd className="mono">{profile}</dd>
          <dt>Hermes version</dt>
          <dd>
            <span className={f.version || f.build ? "mono" : "muted"}>{versionLine(f)}</span>
            {f.commit && (
              <span className="muted">
                {" "}
                · commit <span className="mono">{f.commit.slice(0, 10)}</span>
              </span>
            )}
            {f.releaseDate && <span className="muted"> · released {f.releaseDate}</span>}
          </dd>
          <dt>Protocol</dt>
          <dd>{protocolText(f.protocol)}</dd>
          <dt>Sign-in</dt>
          <dd>{authLine(f, signIn)}</dd>
          <dt>Feature flags</dt>
          <dd>
            {f.flags ? (
              f.flags.length ? (
                <span className="mono">{f.flags.join(", ")}</span>
              ) : (
                "None turned on"
              )
            ) : (
              <span className="muted">{f.flagsWhy ?? "Not read yet"}</span>
            )}
          </dd>
          <dt>Extra request headers</dt>
          <dd>{headers ? `${headers}, whose values are never shown` : "None"}</dd>
        </dl>
      </section>

      <section aria-labelledby="diag-features">
        <div className="diag-head">
          <div>
            <h2 id="diag-features">Features</h2>
            <div className="muted small" role="status" aria-live="polite">
              <CheckStatus snap={snap} connected={connected} />
            </div>
          </div>
          <div className="diag-actions">
            <button className="btn" disabled={!connected || snap.checking} onClick={() => void store.refresh()}>
              <RefreshCw size={14} aria-hidden /> Check again
            </button>
            <button className="btn" onClick={copy}>
              {copied === "done" ? <Check size={14} aria-hidden /> : <ClipboardCopy size={14} aria-hidden />} {copied === "done" ? "Copied" : "Copy report"}
            </button>
          </div>
        </div>
        <div className="sr-only" aria-live="polite">
          {copied === "done" ? "Report copied, with secrets taken out." : ""}
        </div>
        {copied === "failed" && (
          <p className="diag-alert" role="alert">
            <AlertTriangle size={14} aria-hidden /> Couldn't put the report on the clipboard.
          </p>
        )}
        {failed && (
          <p className="diag-alert" role="alert">
            <AlertTriangle size={14} aria-hidden /> Hermes didn't answer any check. {f.versionWhy} Each feature shows why below; Check again once the connection is steady.
          </p>
        )}
        <table className="diag-table">
          <caption className="sr-only">What this Hermes server supports, feature by feature</caption>
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">State</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {CAPABILITIES.map((spec) => {
              const cap = snap.caps[spec.id];
              const here = focus?.id === spec.id;
              return (
                <tr key={spec.id} id={`capability-${spec.id}`} ref={here ? focused : undefined} tabIndex={here ? -1 : undefined} className={here ? "diag-focus" : undefined}>
                  <th scope="row">
                    <div>{spec.label}</div>
                    <div className="muted small">{spec.usedBy}</div>
                  </th>
                  <td>
                    <StateBadge state={cap.state} />
                    <div className="muted small">
                      {sourceText(cap.source)}
                      {cap.checkedAt !== undefined && (
                        <>
                          {", "}
                          <Checked at={cap.checkedAt} prefix="" />
                        </>
                      )}
                    </div>
                  </td>
                  <td className="small">
                    {cap.why && <div>{cap.why}</div>}
                    {cap.state !== "supported" && (
                      <div className="muted">
                        Needs: {spec.needs} Without it: {spec.without}{" "}
                        <button className="link-btn" onClick={() => openGuide(guideUrl(spec.id))} aria-label={`Compatibility guide: ${spec.label}`}>
                          Compatibility guide
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted small settings-note">
          Checks only read: nothing is changed on the server to find out. Results are kept in memory for this sign-in, never on disk. The report holds no
          password, cookie, ticket or header value.{" "}
          <button className="link-btn" onClick={() => openGuide(guideUrl())}>
            Read the compatibility guide
          </button>
        </p>
      </section>
    </div>
  );
}

/**
 * Shows `children` unless the connected Hermes is known to lack capability `id`. Then a note says what is missing and
 * what Hermes needs, and links to diagnostics and the guide, in place of the screen, so it reads and writes nothing.
 * While the capability is supported, unknown or couldn't be checked, the screen shows and finds out for itself.
 * A screen already open when Hermes turns out to lack its feature stays, with the note above it, so an unsaved edit in
 * it isn't lost; the transport refuses its writes (capabilities.ts). `title` and `onClose` frame the note as a screen
 * of its own, for the rail's screens.
 */
export function CapabilityGate({
  store,
  id,
  openGuide,
  onDiagnostics,
  title,
  onClose,
  children,
}: {
  store: CapabilityStore;
  id: CapabilityId;
  openGuide: OpenGuide;
  /** Opens Settings → Diagnostics at this capability; left out where diagnostics can't be reached. */
  onDiagnostics?: (id: CapabilityId) => void;
  title?: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  const snap = useCapabilities(store);
  const cap = snap.caps[id];
  const missing = cap.state === "unsupported";
  // Whether the screen was shown when this gate opened: then it stays, whatever is learnt later.
  const [screenOpen] = useState(!missing);
  // The note's slot comes first either way, so the screen keeps its place, and its state, when the note appears.
  if (!missing)
    return (
      <>
        {null}
        {children}
      </>
    );
  const spec = specOf(id);
  const headingId = `capability-missing-${id}`;
  const note = (
    <section className="capability-missing" aria-labelledby={headingId}>
      <h2 id={headingId}>
        <Stethoscope size={15} aria-hidden /> This Hermes server doesn't support {spec.label}
      </h2>
      <p>
        {spec.label} needs {spec.needs.replace(/^The /, "the ").replace(/\.$/, "")}. {cap.why}
      </p>
      <p className="muted">
        {spec.without} Updating Hermes on the server adds it. <Checked at={cap.checkedAt} />
        {snap.stale && " (not connected now: as last checked)"}.
      </p>
      <div className="capability-missing-actions">
        {onDiagnostics && (
          <button className="btn" onClick={() => onDiagnostics(id)}>
            <Stethoscope size={14} aria-hidden /> Connection diagnostics
          </button>
        )}
        <button className="btn" onClick={() => openGuide(guideUrl(id))} aria-label={`Compatibility guide: ${spec.label}`}>
          <BookOpen size={14} aria-hidden /> Compatibility guide
        </button>
      </div>
    </section>
  );
  if (screenOpen)
    return (
      <>
        {note}
        {children}
      </>
    );
  if (!onClose) return note;
  return (
    <div className="settings">
      <div className="settings-inner">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden /> Back to chat
        </button>
        <h1>{title ?? spec.label}</h1>
        {note}
      </div>
    </div>
  );
}
