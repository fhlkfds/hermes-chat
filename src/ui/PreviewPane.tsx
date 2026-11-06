// The preview pane beside the chat: a web page, a Server file, a Local file or a tool call's output (GLOSSARY.md
// "Preview pane"). Everything it shows is untrusted (ADR 0007): web pages load in a view of their own on Linux (ADR 0081)
// or a sandboxed frame elsewhere, neither of which can reach the app, HTML files render with scripts and network off,
// and Markdown renders without raw HTML, as replies do.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Check, Copy, ExternalLink, FileQuestion, Globe, Laptop, Plus, RotateCw, Server, Wrench } from "lucide-react";
import {
  fenced,
  loopbackOf,
  pageOn,
  parseAddress,
  previewName,
  sandboxedHtml,
  tunnelUrl,
  withoutBidi,
  type FileView,
  type Framing,
  type PageOn,
  type PreviewTarget,
} from "../hermes/preview";
import { Markdown } from "./Markdown";
import { Spinner, fmtSize } from "./bits";
import { ServerPageError, type LocalFiles, type NativePage, type NativePages, type PageEvent, type ServerPage, type ServerPages, type WebPages } from "./tauriPreview";
import { usePlacement } from "./pagePlacement";
import type { ArtifactStore } from "../hermes/artifacts";
import { ArtifactEditor } from "./ArtifactEditor";

/** Text past this many characters shows without highlighting, which would hold up the window. */
const HIGHLIGHT_MAX_CHARS = 100_000;
/** When a web page that hasn't loaded gets a note that it may never show. */
const SLOW_PAGE_MS = 15_000;

/**
 * What a framed web page may use. It may run scripts, send forms and use its own storage under its own origin, which is
 * never the app's (preview.ts `checkWebUrl`). WebKitGTK keeps no third-party cookies for it. It may not navigate the app's
 * window, open windows, or download.
 */
const WEB_SANDBOX = "allow-scripts allow-forms allow-same-origin";
const WEB_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "display-capture",
  "clipboard-read",
  "clipboard-write",
  "usb",
  "serial",
  "hid",
  "bluetooth",
  "payment",
  "fullscreen",
  "publickey-credentials-get",
]
  .map((f) => `${f} 'none'`)
  .join("; ");

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The side panel's Preview tab (SidePanel.tsx). `serverLabel`: how the app reaches the Hermes server, e.g.
 * `liam@hermes`, so a Server file says where it is. `web`: asks whether a site refuses to be shown in the frame, and
 * opens a page in the owner's browser. `serverPages`: opens a page on the Hermes server's own loopback through SSH.
 */
export function PreviewPane({
  target,
  serverLabel,
  readServer,
  local,
  web,
  serverPages,
  onOpen,
  artifacts,
  connected = true,
}: {
  target: PreviewTarget;
  serverLabel: string;
  /** `host`: the file is on the dashboard's own machine (preview.ts `PreviewTarget`). */
  readServer: (path: string, host?: boolean, session?: string) => Promise<FileView>;
  local: LocalFiles;
  web: WebPages;
  serverPages: ServerPages;
  onOpen: (t: PreviewTarget) => void;
  /** Where an artifact's draft lives (artifacts.ts): editing it in the pane, and away from it, share one store. */
  artifacts?: ArtifactStore;
  connected?: boolean;
}) {
  // Reload bumps this; each target starts again from 0 because the pane is keyed by it.
  const [reloads, setReloads] = useState(0);
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState<{ text: string; failed: boolean }>();
  // A server page's tunnel address while it is open: the only way the owner's browser can reach that page.
  const [tunnel, setTunnel] = useState<string>();
  const titleId = useId();
  const on = target.kind === "web" ? pageOn(target) : undefined;
  const browserUrl = target.kind !== "web" ? undefined : on === "server" ? tunnel : target.url;
  const address = target.kind === "server" || target.kind === "local" ? target.path : target.kind === "artifact" ? target.ref.path : target.kind === "web" ? target.url : undefined;

  const openInBrowser = (url: string) => {
    setOpened(undefined);
    web.openInBrowser(url).then(
      (browser) => setOpened({ text: `Opened in ${browser ?? "your browser"}.`, failed: false }),
      (e) => setOpened({ text: `Couldn't open it in your browser: ${messageOf(e)}`, failed: true }),
    );
  };

  return (
    <section className="preview-content" aria-labelledby={titleId}>
      <header className="preview-head">
        <div className="preview-title">
          <div className="preview-name">
            <Where target={target} serverLabel={serverLabel} on={on} />
            <span id={titleId}>{withoutBidi(previewName(target))}</span>
          </div>
          {address && (
            <div className="preview-address" title={withoutBidi(address)}>
              <bdi>{withoutBidi(address)}</bdi>
            </div>
          )}
        </div>
        <div className="preview-actions">
          {address && (
            <button
              className="icon-btn"
              title={target.kind === "web" ? "Copy the address" : "Copy the path"}
              onClick={() => {
                void navigator.clipboard?.writeText(address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          )}
          {target.kind === "web" && (
            <button
              className="icon-btn"
              title={on === "server" ? "Open in your browser, through this page's SSH tunnel while it is open here" : "Open in your browser"}
              disabled={!browserUrl}
              onClick={() => browserUrl && openInBrowser(browserUrl)}
            >
              <ExternalLink size={15} />
            </button>
          )}
          {target.kind !== "start" && target.kind !== "tool" && target.kind !== "artifact" && (
            <button className="icon-btn" title="Reload" onClick={() => setReloads((n) => n + 1)}>
              <RotateCw size={15} />
            </button>
          )}
          {target.kind !== "start" && (
            <button className="icon-btn" title="Open something else" onClick={() => onOpen({ kind: "start" })}>
              <Plus size={16} />
            </button>
          )}
        </div>
      </header>
      {opened && (
        <div className={opened.failed ? "attach-note preview-opened failed" : "attach-note preview-opened"} role={opened.failed ? "alert" : "status"}>
          {opened.text}
        </div>
      )}
      <div className="preview-body">
        {target.kind === "start" ? (
          <StartView serverLabel={serverLabel} local={local} onOpen={onOpen} />
        ) : target.kind === "web" && on ? (
          <div className="preview-web">
            <PageOnSwitch at={loopbackOf(target.url)!.at} on={on} serverLabel={serverLabel} onSwitch={(next) => onOpen({ ...target, on: next })} />
            {on === "server" ? (
              <ServerWebView
                key={reloads}
                url={target.url}
                pages={serverPages}
                serverLabel={serverLabel}
                check={web.check}
                native={web.native}
                onTunnel={setTunnel}
                onOpenInBrowser={openInBrowser}
                onLocal={() => onOpen({ ...target, on: "local" })}
              />
            ) : (
              <WebView key={reloads} url={target.url} check={web.check} native={web.native} onOpenInBrowser={() => openInBrowser(target.url)} />
            )}
          </div>
        ) : target.kind === "web" ? (
          <WebView key={reloads} url={target.url} check={web.check} native={web.native} onOpenInBrowser={() => openInBrowser(target.url)} />
        ) : target.kind === "tool" ? (
          <pre className="preview-pre">{target.text || "(empty)"}</pre>
        ) : target.kind === "artifact" ? (
          artifacts ? (
            <ArtifactEditor
              store={artifacts}
              artifact={target.ref}
              connected={connected}
              onDone={() => onOpen({ kind: "server", path: target.ref.path, ...(target.ref.host && { host: true }), ...(target.ref.session && { session: target.ref.session }) })}
            />
          ) : null
        ) : target.kind === "server" ? (
          <FileBody key={reloads} name={target.path} load={() => readServer(target.path, target.host, target.session)} />
        ) : (
          <FileBody key={reloads} name={target.name} load={() => local.read(target)} />
        )}
      </div>
    </section>
  );
}

/** Where what's shown lives: on the Hermes server, on this computer, on the web, or in a tool call. */
function Where({ target, serverLabel, on }: { target: PreviewTarget; serverLabel: string; on?: PageOn }) {
  if (target.kind === "web" && on === "server")
    return (
      <span className="where where-server" title={`A page on the Hermes server's own ${loopbackOf(target.url)?.at}, through SSH to ${serverLabel}`}>
        <Server size={12} /> Server · {serverLabel}
      </span>
    );
  if (target.kind === "web" && on === "local")
    return (
      <span className="where where-local" title={`A page on this computer's own ${loopbackOf(target.url)?.at}, kept apart from Hermes Chat`}>
        <Laptop size={12} /> This computer
      </span>
    );
  switch (target.kind) {
    case "server":
    case "artifact":
      return (
        <span className="where where-server" title={`A file on the Hermes server (${serverLabel}), read through the dashboard`}>
          <Server size={12} /> Server · {serverLabel}
        </span>
      );
    case "local":
      return (
        <span className="where where-local" title="A file on this computer, read by Hermes Chat. It isn't sent to Hermes.">
          <Laptop size={12} /> This computer
        </span>
      );
    case "web":
      return (
        <span className="where where-web" title="A web page, loaded by this computer and kept apart from Hermes Chat">
          <Globe size={12} /> Web
        </span>
      );
    case "tool":
      return (
        <span className="where where-tool" title="What the tool call returned, as Hermes sent it">
          <Wrench size={12} /> Tool output
        </span>
      );
    default:
      return null;
  }
}

/** The empty pane: type a web address or a server path, or pick a file on this computer. */
function StartView({ serverLabel, local, onOpen }: { serverLabel: string; local: LocalFiles; onOpen: (t: PreviewTarget) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const got = parseAddress(text, location.origin);
    if ("error" in got) setError(got.error);
    else onOpen(got.target);
  };
  const pick = async () => {
    setError(undefined);
    setPicking(true);
    try {
      const file = await local.pick();
      if (file) onOpen({ kind: "local", ...file });
    } catch (e) {
      setError(`Couldn't open the file picker: ${messageOf(e)}`);
    } finally {
      setPicking(false);
    }
  };
  return (
    <div className="preview-start">
      <form className="preview-open" onSubmit={submit}>
        <input
          autoFocus
          aria-label="Web address or path on the Hermes server"
          placeholder="https://… or /path/on/the/server"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(undefined);
          }}
        />
        <button className="btn primary" type="submit" disabled={!text.trim()}>
          Open
        </button>
      </form>
      {error && (
        <div className="attach-note" role="alert">
          {error}
        </div>
      )}
      <p className="preview-hint">
        <Server size={13} /> A path like <code>/home/you/notes.md</code> or <code>~/notes.md</code> is read on the Hermes server, <b>{serverLabel}</b>.
      </p>
      <button className="btn preview-local-btn" onClick={() => void pick()} disabled={picking}>
        <Laptop size={14} /> Open a file on this computer…
      </button>
      <p className="preview-hint">
        Links in replies open here too, and so do the files, pages and output of a tool call: open the call and pick one under Preview.
      </p>
    </div>
  );
}

type Loaded = { view: FileView } | { error: string } | { loading: true };

/** A Server or Local file: loading, then its view, or why it can't be shown. */
function FileBody({ name, load }: { name: string; load: () => Promise<FileView> }) {
  const [state, setState] = useState<Loaded>({ loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    let made: string | undefined;
    loadRef.current().then(
      (view) => {
        const blob = view.kind === "image" && view.src.startsWith("blob:") ? view.src : undefined;
        if (!live) return blob && URL.revokeObjectURL(blob);
        made = blob;
        setState({ view });
      },
      (e) => live && setState({ error: messageOf(e) }),
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, []);

  if ("loading" in state)
    return (
      <div className="preview-state" role="status">
        <Spinner /> Loading {name.split("/").pop()}…
      </div>
    );
  if ("error" in state)
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">Couldn't open this file</div>
          <div>{state.error}</div>
        </div>
      </div>
    );
  const v = state.view;
  if (v.kind === "unsupported")
    return (
      <div className="preview-state" role="note">
        <FileQuestion size={18} />
        <div>
          <div className="preview-state-title">No preview for this file</div>
          <div>
            {v.reason}
            {v.size !== undefined && ` It's ${fmtSize(v.size)}.`}
          </div>
        </div>
      </div>
    );
  if (v.kind === "image") return <ImageView src={v.src} name={name} size={v.size} />;
  return <TextView view={v} name={name} />;
}

function ImageView({ src, name, size }: { src: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (broken)
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">Couldn't show this image</div>
          <div>Its bytes didn't make an image this computer can draw.</div>
        </div>
      </div>
    );
  return (
    <div className="preview-image">
      <img src={src} alt={name.split("/").pop()} onError={() => setBroken(true)} />
      {size !== undefined && <div className="preview-foot">{fmtSize(size)}</div>}
    </div>
  );
}

function TextView({ view, name }: { view: Extract<FileView, { kind: "text" }>; name: string }) {
  const renders = view.format !== "code";
  const [source, setSource] = useState(!renders);
  return (
    <div className="preview-text">
      {(renders || view.truncated) && (
        <div className="preview-bar">
          {renders && (
            <div className="segmented" role="group" aria-label="View">
              <button aria-pressed={!source} onClick={() => setSource(false)}>
                Rendered
              </button>
              <button aria-pressed={source} onClick={() => setSource(true)}>
                Source
              </button>
            </div>
          )}
          {view.truncated && (
            <span className="preview-truncated">
              Showing the first {fmtSize(view.text.length)} of {fmtSize(view.size)}.
            </span>
          )}
        </div>
      )}
      {!source && view.format === "markdown" ? (
        <div className="preview-doc">
          <Markdown text={view.text} />
        </div>
      ) : !source && view.format === "html" ? (
        <iframe className="preview-frame doc" title={`Rendered ${name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={sandboxedHtml(view.text)} />
      ) : view.language && view.text.length <= HIGHLIGHT_MAX_CHARS ? (
        <div className="preview-code">
          <Markdown text={fenced(view.text, view.language)} />
        </div>
      ) : (
        <pre className="preview-pre">{view.text}</pre>
      )}
    </div>
  );
}

type WebViewProps = {
  /** The page's address, as the owner sees it. */
  url: string;
  /** Where it loads from, if not `url`: a server page's tunnel. */
  src?: string;
  check: (url: string) => Promise<Framing>;
  /** The Preview's own page view, where there is one: it takes the frame's place. */
  native?: NativePages;
  onOpenInBrowser: () => void;
};

function WebView({ native, ...props }: WebViewProps) {
  return native ? <NativeWebView {...props} pages={native} /> : <FramedWebView {...props} />;
}

/**
 * A web page in the Preview's own WebKitGTK view, which Rust lays over this box (ADR 0081). The page is the top level of
 * its view, so a site that refuses framing shows. The box says what the view can't: that the page is loading, or why
 * it failed. The view shows once the page's first response comes, and hides again if a load fails.
 */
function NativeWebView({ url, src = url, pages, onOpenInBrowser }: Omit<WebViewProps, "native" | "check"> & { pages: NativePages }) {
  const box = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<NativePage>();
  const [state, setState] = useState<Exclude<PageEvent, { kind: "escaped" }>>();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_PAGE_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    // Escape in the page gave the keyboard back to the app: it lands here, inside the Preview, for the next key.
    const opened = pages.open(src, (e) => (e.kind === "escaped" ? box.current?.focus() : setState(e)));
    setPage(opened);
    return () => opened.close();
  }, [pages, src]);
  usePlacement(box, state?.kind === "shown" ? page : undefined);
  return (
    <div className="preview-web">
      <div className="preview-web-note">
        Runs on its own, with no access to Hermes Chat or your sign-in.{" "}
        <button className="link-btn" onClick={onOpenInBrowser}>
          Open it in your browser
        </button>
      </div>
      <div ref={box} className="preview-web-frame" tabIndex={-1}>
        {state?.kind === "failed" ? (
          <div className="preview-state preview-error preview-loading" role="alert">
            <AlertTriangle size={18} />
            <div>
              <div className="preview-state-title">Couldn't load {hostOf(url)}</div>
              <div>{state.message}</div>
              <div>Check the address, or Reload to try again.</div>
            </div>
          </div>
        ) : (
          state?.kind !== "shown" && (
            <div className="preview-state preview-loading" role="status">
              <Spinner /> {slow ? "Still loading the page…" : "Loading page…"}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/**
 * A web page in a frame. WebKitGTK gives the frame no sign that a site refused to be framed: it fires `load` at once
 * and stays blank. So Rust asks the site the way the frame does (`check`, ADR 0011): a refusal replaces the frame with
 * a note and Open in your browser, and a site this computer can't reach says so instead of loading forever. Anything
 * else (a script that blanks the page, say) still can't be told apart, so a page slow to load says it may not show.
 */
function FramedWebView({ url, src = url, check, onOpenInBrowser }: Omit<WebViewProps, "native">) {
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [closed, setClosed] = useState(false);
  const [framing, setFraming] = useState<Framing>();
  const [showAnyway, setShowAnyway] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_PAGE_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    let live = true;
    // A check that fails says nothing either way: the frame is left to show what it can.
    checkRef.current(src).then(
      (f) => live && setFraming(f),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [src]);
  const onLoad = () => {
    // A page that redirected the frame onto the app's own origin could reach the app; such a frame is emptied at once.
    // The frame-src policy (index.html) and Tauri's invoke key are the main guards; this is the last one (ADR 0007).
    try {
      const href = frame.current?.contentWindow?.location.href;
      if (href !== undefined && href !== "about:blank") {
        frame.current!.src = "about:blank";
        setClosed(true);
        return;
      }
    } catch {
      // Cross-origin, as it should be.
    }
    setLoaded(true);
  };
  const host = hostOf(url);
  if (closed)
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">This page was closed</div>
          <div>It tried to load Hermes Chat's own pages inside the preview.</div>
        </div>
      </div>
    );
  if (framing?.kind === "refused" && !showAnyway)
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">{host} doesn't allow being shown inside other apps</div>
          <div>
            The site's answer says so (<code className="preview-refused-by">{framing.by}</code>), so here it would stay blank. Open it in your
            browser instead.
          </div>
          <div className="preview-state-actions">
            <button className="btn primary" onClick={onOpenInBrowser}>
              <ExternalLink size={14} /> Open in your browser
            </button>
            <button
              className="link-btn"
              onClick={() => {
                setLoaded(false);
                setShowAnyway(true);
              }}
            >
              Try showing it here anyway
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div className="preview-web">
      <div className="preview-web-note">
        Runs on its own, with no access to Hermes Chat or your sign-in. Some sites don't allow being shown inside other apps; if this one stays
        blank,{" "}
        <button className="link-btn" onClick={onOpenInBrowser}>
          open it in your browser
        </button>
        .
      </div>
      <div className="preview-web-frame">
        <iframe
          ref={frame}
          className="preview-frame"
          title={`Web page: ${url}`}
          src={src}
          sandbox={WEB_SANDBOX}
          allow={WEB_PERMISSIONS}
          referrerPolicy="no-referrer"
          onLoad={onLoad}
        />
        {!loaded &&
          (framing?.kind === "unreachable" ? (
            <div className="preview-state preview-error preview-loading" role="alert">
              <AlertTriangle size={18} />
              <div>
                <div className="preview-state-title">Couldn't reach {host}</div>
                <div>{framing.message}</div>
                <div>Check the address, or Reload to try again.</div>
              </div>
            </div>
          ) : (
            <div className="preview-state preview-loading" role="status">
              <Spinner /> {slow ? "Still loading. If the page stays blank, the site may not allow being shown here." : "Loading page…"}
            </div>
          ))}
      </div>
    </div>
  );
}

/**
 * For a page on a loopback address: whose loopback it comes from, and the switch between the Hermes server's (through
 * SSH) and this computer's.
 */
function PageOnSwitch({ at, on, serverLabel, onSwitch }: { at: string; on: PageOn; serverLabel: string; onSwitch: (on: PageOn) => void }) {
  return (
    <div className="preview-on">
      <span className="preview-on-text">
        {on === "server" ? <Server size={13} /> : <Laptop size={13} />}
        <span>
          {on === "server" ? (
            <>
              From <b>{at}</b> on the Hermes server, through SSH to {serverLabel}
            </>
          ) : (
            <>
              From <b>{at}</b> on this computer
            </>
          )}
        </span>
      </span>
      <div className="segmented" role="group" aria-label={`Open ${at} from`}>
        <button aria-pressed={on === "server"} onClick={() => on !== "server" && onSwitch("server")} title={`${at} on the Hermes server, through SSH`}>
          Hermes server
        </button>
        <button aria-pressed={on === "local"} onClick={() => on !== "local" && onSwitch("local")} title={`${at} on this computer`}>
          This computer
        </button>
      </div>
    </div>
  );
}

type Tunnel = { kind: "opening" } | { kind: "open"; page: ServerPage; src: string } | { kind: "failed"; error: ServerPageError } | { kind: "closed"; message: string };

/** What a server page that didn't open is called, by why. */
const FAILED_TITLE: Record<string, string> = {
  noSshTarget: "No SSH target for this server",
  notConnected: "Not connected to the Hermes server",
  portClosed: "Nothing answers there on the server",
  notWeb: "This isn't a web page",
  notLoopback: "This page isn't on the server's own loopback",
  tooMany: "Too many server pages open",
  timeout: "SSH didn't connect",
};

/**
 * A page on the Hermes server's own loopback: Rust opens an SSH tunnel for it when it shows, and the frame loads it
 * through the tunnel's end on this computer. The tunnel closes when this goes: another page, the Preview closed or
 * hidden, or Reload (which opens a new one).
 */
function ServerWebView({
  url,
  pages,
  serverLabel,
  check,
  native,
  onTunnel,
  onOpenInBrowser,
  onLocal,
}: {
  url: string;
  pages: ServerPages;
  serverLabel: string;
  check: (url: string) => Promise<Framing>;
  native?: NativePages;
  onTunnel: (url: string | undefined) => void;
  onOpenInBrowser: (url: string) => void;
  onLocal: () => void;
}) {
  const [state, setState] = useState<Tunnel>({ kind: "opening" });
  const [tries, setTries] = useState(0);
  const at = loopbackOf(url)?.at ?? url;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const onTunnelRef = useRef(onTunnel);
  onTunnelRef.current = onTunnel;
  useEffect(() => {
    let live = true;
    // Latched: a tunnel that closed before its open result arrived stays closed.
    let ended = false;
    const opening = pagesRef.current.open(url, (message) => {
      ended = true;
      if (!live) return;
      setState({ kind: "closed", message });
      onTunnelRef.current(undefined);
    });
    setState({ kind: "opening" });
    opening.page.then(
      (page) => {
        if (!live || ended) return;
        const src = tunnelUrl(page.url, location.origin);
        if (!src) {
          opening.close();
          return setState({ kind: "failed", error: new ServerPageError("io", "The tunnel gave an address the preview doesn't load.") });
        }
        setState({ kind: "open", page, src });
        onTunnelRef.current(src);
      },
      (e) => {
        if (!live || ended) return;
        const error = e instanceof ServerPageError ? e : new ServerPageError("io", messageOf(e));
        setState(error.kind === "closed" ? { kind: "closed", message: error.message } : { kind: "failed", error });
      },
    );
    return () => {
      live = false;
      // Ends the tunnel whether it opened or is still connecting.
      opening.close();
      onTunnelRef.current(undefined);
    };
  }, [url, tries]);

  const again = (
    <button className="btn primary" onClick={() => setTries((n) => n + 1)}>
      <RotateCw size={14} /> Try again
    </button>
  );
  const local = (
    <button className="link-btn" onClick={onLocal}>
      Open on this computer instead
    </button>
  );
  if (state.kind === "opening")
    return (
      <div className="preview-state" role="status">
        <Spinner /> Opening {at} on the Hermes server, through SSH to {serverLabel}…
      </div>
    );
  if (state.kind === "failed") {
    const { kind, message } = state.error;
    const title = kind === "portClosed" ? `Nothing answers at ${at} on the server` : (FAILED_TITLE[kind] ?? "Couldn't open an SSH tunnel to the server");
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">{title}</div>
          <div>{message}</div>
          {kind === "portClosed" && <div>If Hermes is still starting it, try again in a moment.</div>}
          {kind === "noSshTarget" && <div>Sign in through SSH to reach pages on the server, or open this one on this computer.</div>}
          <div className="preview-state-actions">
            {kind !== "noSshTarget" && kind !== "notWeb" && kind !== "notLoopback" && again}
            {kind !== "notWeb" && local}
          </div>
        </div>
      </div>
    );
  }
  if (state.kind === "closed")
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">The SSH tunnel to this page closed</div>
          <div>{state.message}</div>
          <div className="preview-state-actions">
            {again}
            {local}
          </div>
        </div>
      </div>
    );
  return <WebView url={url} src={state.src} check={check} native={native} onOpenInBrowser={() => onOpenInBrowser(state.src)} />;
}

/** The host a web address names, for messages about it. */
function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
