// @vitest-environment jsdom
// The preview pane beside the chat, driven the way the owner would drive it in the signed-in app, against a fake
// Hermes whose `/api/fs/*` routes answer as the deployed server did. Each test checks what the owner sees and what went
// to Hermes; the frames' sandboxes are checked as rendered, since that is what keeps their content away from the app.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { getUIPrefs } from "../hermes/uiPrefs";
import type { FileView, Framing } from "../hermes/preview";
import { ServerPageError, type LocalFiles, type ServerPage, type ServerPages, type WebPages } from "./tauriPreview";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const pane = () => {
  const el = document.querySelector<HTMLElement>("aside.preview:not([hidden])");
  if (!el) throw new Error("The preview pane isn't open");
  return el;
};
const paneOpen = () => !!document.querySelector("aside.preview:not([hidden])");
/** The preview's file reads. The Outputs capability probe's `GET /api/fs/list` at sign-in may land at any time. */
const fsReads = (s: FakeHermes) => s.restRequests.filter((r) => r.path.startsWith("/api/fs/") && r.path !== "/api/fs/list");

/** A local disk the Open dialog picks from: `pick` is what the owner picks next (null cancels). */
function localDisk(files: Record<string, FileView | Error>) {
  const local: LocalFiles & { next: { path: string; name: string } | null } = {
    next: null,
    pick: async () => local.next,
    read: async (f) => {
      const v = files[f.path];
      if (!v) throw new Error("No such file or directory (os error 2)");
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return local;
}

/**
 * The web as Rust's framing check sees it (src-tauri/src/web_page.rs): each address answers as `answers` says, and any
 * other answers that nothing refused. `checked` and `opened` record what the pane asked for.
 */
function theWeb(answers: Record<string, Framing | Error | Promise<Framing>> = {}, openFails?: string) {
  const web: WebPages & { checked: string[]; opened: string[] } = {
    checked: [],
    opened: [],
    check: async (url) => {
      web.checked.push(url);
      const a = answers[url] ?? { kind: "notRefused" };
      if (a instanceof Error) throw a;
      return a;
    },
    openInBrowser: async (url) => {
      if (openFails) throw new Error(openFails);
      web.opened.push(url);
    },
  };
  return web;
}

/**
 * The Hermes server's loopback as Rust's SSH tunnels reach it (src-tauri/src/server_page.rs). Each `open` gets the
 * next of `answers` (a page opens when there is none left), and the tunnel's end on this computer is
 * `http://127.0.0.1:4100<n>`. `opened`, `closed` and `live` record what the pane did, by key "1", "2"…; `drop(key,
 * why)` ends a tunnel as ssh exiting would, even one still connecting.
 */
function theServer(...answers: (ServerPageError | Promise<void> | { url: string })[]) {
  const pages: ServerPages & { opened: string[]; closed: string[]; live: Map<string, (why: string) => void>; drop(key: string, why: string): void } = {
    opened: [],
    closed: [],
    live: new Map(),
    open: (url, onClosed) => {
      pages.opened.push(url);
      const id = String(pages.opened.length);
      pages.live.set(id, onClosed);
      const a = answers.shift();
      const page = (async (): Promise<ServerPage> => {
        if (a instanceof Error) {
          pages.live.delete(id);
          throw a;
        }
        if (a instanceof Promise) await a;
        const u = new URL(url);
        return { id, url: a && "url" in a ? a.url : `${u.protocol}//127.0.0.1:4100${id}${u.pathname}${u.search}`, target: "liam@hermes", at: `${u.hostname}:${u.port}` };
      })();
      return {
        page,
        close: () => {
          pages.closed.push(id);
          pages.live.delete(id);
        },
      };
    },
    drop: (key, why) => {
      const onClosed = pages.live.get(key);
      pages.live.delete(key);
      onClosed?.(why);
    },
  };
  return pages;
}

/**
 * Signed in, with the chat "Fix the app" open: a reply with a link, then a read_file call on a server file, a
 * browser_navigate call and a terminal call.
 */
async function signedIn({ local = localDisk({}), web = theWeb(), pages = theServer() } = {}) {
  const server = new FakeHermes();
  server.sessions = [row("fix", 1, { pinned: true, title: "Fix the app" }), row("other", 2, { pinned: true, title: "Another chat" })];
  server.transcripts = {
    fix: [
      { role: "user", text: "Why does the app crash?" },
      { role: "tool", name: "read_file", context: "main.py", args: { path: "/home/liam/app/main.py" } },
      { role: "tool", name: "browser_navigate", context: "docs", args: { url: "https://docs.example.com/crash" } },
      { role: "tool", name: "patch", context: "main.py", args: { path: "/home/liam/app/main.py" }, content: '{"success": true, "diff": "-a\\n+b"}' },
      {
        role: "assistant",
        text: "It reads a missing file. See [the docs](https://docs.example.com/crash) and [a mail](mailto:x@example.com). The fix runs at [the dev server](http://localhost:5173/app?v=2).",
      },
    ],
  };
  server.serverFiles = {
    "/home/liam/app/main.py": 'open("missing.txt")\n',
    "/home/liam/app/README.md": "# App\n\nRead [the guide](https://guide.example.com/).\n\n<script>alert(1)</script>\n",
    "/home/liam/app/index.html": '<h1>Hi</h1><script>parent.__TAURI_INTERNALS__.invoke("password_load")</script>',
    "/home/liam/app/logo.png": "\x89PNG\r\n\x1a\nimage",
    "/home/liam/app/app.bin": "\x7fELF\0\0\0\0",
    "/home/liam/app/.env": "SECRET=1",
  };
  const hermes = await connect(server.openPipe);
  const user = userEvent.setup();
  render(
    <Main
      hermes={hermes}
      connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }}
      localFiles={local}
      webPages={web}
      serverPages={pages}
      onSignOut={async () => {}}
    />,
  );
  await user.click(await screen.findByRole("button", { name: /Fix the app/ }));
  await screen.findByText(/It reads a missing file/);
  await settle(hermes);
  return { server, hermes, user, local, web, pages };
}

/** Opens the chat's tool calls, then the one named `name`. */
async function openTool(user: ReturnType<typeof userEvent.setup>, name: string) {
  const group = screen.queryByRole("button", { name: /3 tool calls/ });
  if (group?.getAttribute("aria-expanded") === "false") await user.click(group);
  await user.click(screen.getAllByRole("button", { name: new RegExp(`^${name}`) })[0]);
}

describe("Opening the preview pane", () => {
  it("opens a link from a reply in the pane, in a frame that can't reach the app, and leaves the chat as it was", async () => {
    const { user, server, hermes } = await signedIn();
    const link = screen.getByRole("link", { name: "the docs" });
    // A plain click would have replaced the app's own window with the page.
    expect(fireEvent.click(link)).toBe(false);

    const frame = await within(pane()).findByTitle("Web page: https://docs.example.com/crash");
    expect(frame.getAttribute("src")).toBe("https://docs.example.com/crash");
    const sandbox = frame.getAttribute("sandbox")!.split(" ");
    expect(sandbox.sort()).toEqual(["allow-forms", "allow-same-origin", "allow-scripts"]);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(within(pane()).getByText("Web")).toBeTruthy();
    expect(within(pane()).getByRole("status").textContent).toContain("Loading page");

    // The chat is still there and still sends.
    await user.type(screen.getByPlaceholderText("Message Hermes"), "Thanks{Enter}");
    await settle(hermes);
    expect(server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text)).toEqual(["Thanks"]);
    expect((screen.getByPlaceholderText("Message Hermes") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText(/It reads a missing file/)).toBeTruthy();
  });

  it("doesn't follow a link that isn't a web page", async () => {
    await signedIn();
    expect(fireEvent.click(screen.getByRole("link", { name: "a mail" }))).toBe(false);
    expect(paneOpen()).toBe(false);
  });

  it("opens the server file a tool call read, saying it is on the server", async () => {
    const { server, user } = await signedIn();
    // Hermes takes its time answering, so the pane shows it is loading.
    let answer = () => {};
    const readText = server.rest["GET /api/fs/read-text"];
    server.rest["GET /api/fs/read-text"] = (req) => new Promise((resolve) => (answer = () => resolve(readText(req))));
    await openTool(user, "read_file");
    await user.click(screen.getByRole("button", { name: "main.py" }));

    expect((await within(pane()).findByRole("status")).textContent).toContain("Loading main.py");
    act(() => answer());
    expect(await within(pane()).findByText(/missing\.txt/)).toBeTruthy();
    server.rest["GET /api/fs/read-text"] = readText;
    expect(within(pane()).getByText("Server · liam@hermes")).toBeTruthy();
    expect(within(pane()).getByText("/home/liam/app/main.py")).toBeTruthy();
    expect(fsReads(server).map((r) => [r.path, r.query.get("path"), r.query.get("profile")])).toEqual([
      ["/api/fs/read-text", "/home/liam/app/main.py", "default"],
    ]);

    await user.click(within(pane()).getByRole("button", { name: "Reload" }));
    await within(pane()).findByText(/missing\.txt/);
    expect(fsReads(server)).toHaveLength(2);
  });

  it("opens the page a browser tool visited, and a tool call's output", async () => {
    const { user } = await signedIn();
    await openTool(user, "browser_navigate");
    await user.click(screen.getByRole("button", { name: "crash" }));
    expect(await within(pane()).findByTitle("Web page: https://docs.example.com/crash")).toBeTruthy();

    await openTool(user, "patch");
    await user.click(screen.getByRole("button", { name: "Output" }));
    expect(within(pane()).getByText("Tool output")).toBeTruthy();
    expect(within(pane()).getByText(/"success": true/)).toBeTruthy();
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();
  });

  it("opens from the chat header, where the owner types a server path or web address", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    const box = within(pane()).getByRole("textbox", { name: "Web address or path on the Hermes server" });
    expect(within(pane()).getByText("liam@hermes")).toBeTruthy();

    await user.type(box, "notes.md{Enter}");
    expect(within(pane()).getByRole("alert").textContent).toContain("starting with / or ~/");
    await user.clear(box);
    await user.type(box, "file:///home/liam/notes.md{Enter}");
    expect(within(pane()).getByRole("alert").textContent).toBe("To preview a file on this computer, use Open a file on this computer.");
    await user.clear(box);
    await user.type(box, `${location.origin}/{Enter}`);
    expect(within(pane()).getByRole("alert").textContent).toBe("Hermes Chat's own pages don't open in the preview.");

    await user.clear(box);
    await user.type(box, "/home/liam/app/README.md{Enter}");
    expect(await within(pane()).findByRole("heading", { name: "App" })).toBeTruthy();
  });
});

describe("What the pane shows", () => {
  async function openPath(path: string) {
    const s = await signedIn();
    await s.user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await s.user.type(within(pane()).getByRole("textbox"), `${path}{Enter}`);
    return s;
  }

  it("renders a Markdown file without its raw HTML, and its links open in the pane", async () => {
    const { user } = await openPath("/home/liam/app/README.md");
    await within(pane()).findByRole("heading", { name: "App" });
    expect(pane().querySelector("script")).toBeNull();
    expect(within(pane()).getByText("<script>alert(1)</script>")).toBeTruthy();

    await user.click(within(pane()).getByRole("button", { name: "Source" }));
    expect(within(pane()).getByText(/# App/)).toBeTruthy();

    await user.click(within(pane()).getByRole("button", { name: "Rendered" }));
    await user.click(within(pane()).getByRole("link", { name: "the guide" }));
    expect(await within(pane()).findByTitle("Web page: https://guide.example.com/")).toBeTruthy();
  });

  it("renders an HTML file with scripts, forms and the network off", async () => {
    await openPath("/home/liam/app/index.html");
    const frame = await within(pane()).findByTitle("Rendered /home/liam/app/index.html");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toMatch(/^<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
    expect(frame.getAttribute("src")).toBeNull();
  });

  it("shows an image", async () => {
    await openPath("/home/liam/app/logo.png");
    const img = await within(pane()).findByRole("img", { name: "logo.png" });
    expect(img.getAttribute("src")).toBe(`data:image/png;base64,${btoa("\x89PNG\r\n\x1a\nimage")}`);
  });

  it("says why it can't show a binary file, a missing one, or one with credentials", async () => {
    const { user } = await openPath("/home/liam/app/app.bin");
    expect((await within(pane()).findByRole("note")).textContent).toBe("No preview for this fileThe preview can't show binary files. It's 8 B.");

    for (const [path, why] of [
      ["/home/liam/app/gone.py", "There's no file at this path on the Hermes server."],
      ["/home/liam/app/.env", "Hermes doesn't show this file, since it may hold credentials."],
    ]) {
      await user.click(within(pane()).getByRole("button", { name: "Open something else" }));
      await user.type(within(pane()).getByRole("textbox"), `${path}{Enter}`);
      expect((await within(pane()).findByRole("alert")).textContent).toBe(`Couldn't open this file${why}`);
    }
  });

  it("opens a file from this computer, labelled as local, and never asks Hermes for it", async () => {
    const local = localDisk({
      "/home/me/todo.txt": { kind: "text", text: "buy milk", language: "", format: "code", size: 8, truncated: false },
      "/home/me/locked.txt": new Error("Permission denied (os error 13)"),
    });
    const { server, user } = await signedIn({ local });
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));

    local.next = null;
    await user.click(within(pane()).getByRole("button", { name: "Open a file on this computer…" }));
    expect(within(pane()).getByRole("textbox")).toBeTruthy();

    local.next = { path: "/home/me/todo.txt", name: "todo.txt" };
    await user.click(within(pane()).getByRole("button", { name: "Open a file on this computer…" }));
    expect(await within(pane()).findByText("buy milk")).toBeTruthy();
    expect(within(pane()).getByText("This computer")).toBeTruthy();
    expect(within(pane()).queryByText(/Server ·/)).toBeNull();
    expect(fsReads(server)).toEqual([]);

    await user.click(within(pane()).getByRole("button", { name: "Open something else" }));
    local.next = { path: "/home/me/locked.txt", name: "locked.txt" };
    await user.click(within(pane()).getByRole("button", { name: "Open a file on this computer…" }));
    expect((await within(pane()).findByRole("alert")).textContent).toContain("Permission denied (os error 13)");
  });
});

describe("Web pages a site won't let the pane show (issue #55)", () => {
  const GOOGLE = "https://www.google.com/";
  /**
   * What WebKitGTK 2.54 did for both www.google.com and example.com: the frame's `load` fired within a few hundred
   * milliseconds, and its location then threw a SecurityError, whether the page showed or was refused.
   */
  const loadCrossOrigin = (frame: HTMLElement) => {
    Object.defineProperty(frame, "contentWindow", {
      get: () => ({
        get location() {
          throw new DOMException("Blocked a frame from accessing a cross-origin frame.", "SecurityError");
        },
      }),
    });
    fireEvent.load(frame);
  };
  async function openWeb(url: string, web: ReturnType<typeof theWeb>) {
    const s = await signedIn({ web });
    await s.user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await s.user.type(within(pane()).getByRole("textbox"), `${url}{Enter}`);
    return s;
  }

  it("says a site refuses to be shown, instead of a blank frame, and opens it in the browser", async () => {
    // What www.google.com answers: WebKitGTK fires the frame's load at once and leaves it white.
    let answer = (_: Framing) => {};
    const web = theWeb({ [GOOGLE]: new Promise<Framing>((resolve) => (answer = resolve)) });
    const { user } = await openWeb(GOOGLE, web);
    loadCrossOrigin(within(pane()).getByTitle(`Web page: ${GOOGLE}`));
    expect(within(pane()).queryByRole("status")).toBeNull();
    expect(web.checked).toEqual([GOOGLE]);

    await act(async () => answer({ kind: "refused", by: "X-Frame-Options: SAMEORIGIN" }));
    const note = within(pane()).getByRole("alert");
    expect(note.textContent).toContain("www.google.com doesn't allow being shown inside other apps");
    expect(note.textContent).toContain("X-Frame-Options: SAMEORIGIN");
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();
    // The address is still there to copy.
    expect(within(pane()).getByText(GOOGLE)).toBeTruthy();

    await user.click(within(note).getByRole("button", { name: "Open in your browser" }));
    expect(web.opened).toEqual([GOOGLE]);

    // The owner may still try, in the same sandboxed frame.
    await user.click(within(note).getByRole("button", { name: "Try showing it here anyway" }));
    const again = within(pane()).getByTitle(`Web page: ${GOOGLE}`);
    expect(again.getAttribute("sandbox")!.split(" ").sort()).toEqual(["allow-forms", "allow-same-origin", "allow-scripts"]);
    expect(within(pane()).getByRole("status").textContent).toContain("Loading page");
  });

  it("keeps showing a page that allows framing, with a way to open it in the browser", async () => {
    const web = theWeb();
    const { user } = await openWeb("https://example.com/", web);
    const frame = within(pane()).getByTitle("Web page: https://example.com/");
    await act(async () => {});
    loadCrossOrigin(frame);
    expect(web.checked).toEqual(["https://example.com/"]);
    expect(within(pane()).queryByRole("alert")).toBeNull();
    expect(within(pane()).queryByRole("status")).toBeNull();
    expect(frame.isConnected).toBe(true);

    await user.click(within(pane()).getByRole("button", { name: "open it in your browser" }));
    await user.click(within(pane()).getByRole("button", { name: "Open in your browser" }));
    expect(web.opened).toEqual(["https://example.com/", "https://example.com/"]);

    // Reload asks again.
    await user.click(within(pane()).getByRole("button", { name: "Reload" }));
    expect(web.checked).toEqual(["https://example.com/", "https://example.com/"]);
  });

  it("says a site can't be reached rather than loading forever, until the frame loads after all", async () => {
    const url = "http://127.0.0.1:4599/";
    const web = theWeb({ [url]: { kind: "unreachable", message: "Connection refused (os error 111)" } });
    const { user } = await openWeb(url, web);
    // On this computer's own loopback, not the server's.
    await user.click(await within(pane()).findByRole("button", { name: "This computer" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't reach 127.0.0.1:4599");
    expect(alert.textContent).toContain("Connection refused (os error 111)");
    // The frame stays: this computer's browser engine may reach what Rust couldn't.
    loadCrossOrigin(within(pane()).getByTitle(`Web page: ${url}`));
    expect(within(pane()).queryByRole("alert")).toBeNull();
  });

  it("leaves the frame alone when the check itself fails, and says why the browser didn't open", async () => {
    const web = theWeb({ [GOOGLE]: new Error("not running in Tauri") }, "Couldn't find xdg-open, which opens pages in your browser.");
    const { user } = await openWeb(GOOGLE, web);
    await act(async () => {});
    expect(within(pane()).getByTitle(`Web page: ${GOOGLE}`)).toBeTruthy();
    expect(within(pane()).queryByRole("alert")).toBeNull();

    await user.click(within(pane()).getByRole("button", { name: "Open in your browser" }));
    expect((await within(pane()).findByRole("alert")).textContent).toBe(
      "Couldn't open it in your browser: Couldn't find xdg-open, which opens pages in your browser.",
    );
  });
});

describe("Pages on the Hermes server's own loopback (issue #171)", () => {
  const APP_URL = "http://localhost:5173/app?v=2";
  const TUNNEL = "http://127.0.0.1:41001/app?v=2";
  const frameSrc = async () => (await within(pane()).findByTitle(`Web page: ${APP_URL}`)).getAttribute("src");

  it("opens a localhost link from a reply on the server through SSH, says so, and closes the tunnel with the preview", async () => {
    const { user, web, pages } = await signedIn();
    expect(screen.getByRole("link", { name: "the dev server" }).title).toBe(`${APP_URL}\nOpens in the preview, from the Hermes server`);
    await user.click(screen.getByRole("link", { name: "the dev server" }));

    // The frame loads the tunnel's end on this computer; the owner still sees the page's own address.
    expect(await frameSrc()).toBe(TUNNEL);
    expect(pages.opened).toEqual([APP_URL]);
    expect(within(pane()).getByText("Server · liam@hermes")).toBeTruthy();
    expect(within(pane()).getByText(APP_URL)).toBeTruthy();
    expect(within(pane()).getByText(/on the Hermes server, through SSH to liam@hermes/).textContent).toBe(
      "From localhost:5173 on the Hermes server, through SSH to liam@hermes",
    );
    expect(within(pane()).getByRole("button", { name: "Hermes server", pressed: true })).toBeTruthy();
    expect(within(pane()).getByRole("button", { name: "This computer", pressed: false })).toBeTruthy();
    // The same sandbox as any web page.
    const frame = within(pane()).getByTitle(`Web page: ${APP_URL}`);
    expect(frame.getAttribute("sandbox")!.split(" ").sort()).toEqual(["allow-forms", "allow-same-origin", "allow-scripts"]);
    // The framing check asks the page through the tunnel too.
    expect(web.checked).toEqual([TUNNEL]);

    // The owner's browser reaches it only through the tunnel.
    await user.click(within(pane()).getByTitle(/^Open in your browser, through this page's SSH tunnel/));
    expect(web.opened).toEqual([TUNNEL]);

    expect(pages.closed).toEqual([]);
    await user.click(within(pane()).getByRole("button", { name: "Close the side panel" }));
    expect(pages.closed).toEqual(["1"]);
    expect(pages.live.size).toBe(0);
  });

  it("switches to this computer, closing the tunnel, and back to the server through a new one", async () => {
    const { user, pages } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    expect(await frameSrc()).toBe(TUNNEL);

    await user.click(within(pane()).getByRole("button", { name: "This computer" }));
    expect(pages.closed).toEqual(["1"]);
    expect(await frameSrc()).toBe(APP_URL);
    expect(pane().querySelector(".where")!.textContent).toBe(" This computer");
    expect(within(pane()).getByText(/on this computer$/).textContent).toBe("From localhost:5173 on this computer");
    expect(within(pane()).getByRole("button", { name: "This computer", pressed: true })).toBeTruthy();
    // Opening it in the browser is this computer's own address now.
    expect(within(pane()).getByTitle("Open in your browser")).toBeTruthy();

    await user.click(within(pane()).getByRole("button", { name: "Hermes server" }));
    expect(await frameSrc()).toBe("http://127.0.0.1:41002/app?v=2");
    expect(pages.opened).toEqual([APP_URL, APP_URL]);

    // Reload opens a new tunnel and closes the one before.
    await user.click(within(pane()).getByRole("button", { name: "Reload" }));
    expect(await frameSrc()).toBe("http://127.0.0.1:41003/app?v=2");
    expect(pages.closed).toEqual(["1", "2"]);
    expect([...pages.live.keys()]).toEqual(["3"]);
  });

  it("says when the sign-in has no SSH target, and offers this computer instead", async () => {
    const pages = theServer(
      new ServerPageError("noSshTarget", "This sign-in uses a dashboard URL, so Hermes Chat has no SSH target to reach the server's own pages."),
    );
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("No SSH target for this server");
    expect(alert.textContent).toContain("This sign-in uses a dashboard URL");
    expect(alert.textContent).toContain("Sign in through SSH to reach pages on the server");
    // Trying again can't help.
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();

    await user.click(within(alert).getByRole("button", { name: "Open on this computer instead" }));
    expect(await frameSrc()).toBe(APP_URL);
    expect(pages.opened).toHaveLength(1);
  });

  it("says when nothing answers at the port on the server, and tries again", async () => {
    const pages = theServer(new ServerPageError("portClosed", "Nothing on the Hermes server answered at localhost:5173. ssh said: channel 2: open failed: connect failed: Connection refused"));
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("Nothing answers at localhost:5173 on the server");
    expect(alert.textContent).toContain("Connection refused");
    expect(alert.textContent).toContain("try again in a moment");

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await frameSrc()).toBe("http://127.0.0.1:41002/app?v=2");
  });

  it("says when ssh fails, with what ssh said", async () => {
    const pages = theServer(new ServerPageError("ssh", "SSH failed: liam@hermes: Permission denied (publickey)."));
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't open an SSH tunnel to the server");
    expect(alert.textContent).toContain("Permission denied (publickey)");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Open on this computer instead" })).toBeTruthy();
  });

  it("says when the tunnel closes under the page, and opens a new one on Try again", async () => {
    const { user, pages } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    expect(await frameSrc()).toBe(TUNNEL);
    act(() => pages.drop("1", "ssh ended: Connection to hermes closed by remote host."));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("The SSH tunnel to this page closed");
    expect(alert.textContent).toContain("Connection to hermes closed by remote host.");
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();
    // Nothing to open in the browser without a tunnel.
    expect((within(pane()).getByTitle(/^Open in your browser/) as HTMLButtonElement).disabled).toBe(true);

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await frameSrc()).toBe("http://127.0.0.1:41002/app?v=2");
  });

  it("ends a tunnel still connecting when its page goes, without waiting for it", async () => {
    let ready = () => {};
    const pages = theServer(new Promise<void>((resolve) => (ready = resolve)));
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    expect(within(pane()).getByRole("status").textContent).toBe(" Opening localhost:5173 on the Hermes server, through SSH to liam@hermes…");
    await user.click(within(pane()).getByRole("button", { name: "Close the side panel" }));
    expect(pages.closed).toEqual(["1"]);
    expect(pages.live.size).toBe(0);
    // Its result, if it ever comes, changes nothing.
    await act(async () => ready());
    expect(pages.closed).toEqual(["1"]);
  });

  it("stays closed when the tunnel closes before its open result arrives", async () => {
    let ready = () => {};
    const pages = theServer(new Promise<void>((resolve) => (ready = resolve)));
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    act(() => pages.drop("1", "ssh ended: Connection reset by peer"));
    await act(async () => ready());
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("The SSH tunnel to this page closed");
    expect(alert.textContent).toContain("Connection reset by peer");
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();
    expect((within(pane()).getByTitle(/^Open in your browser/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says the tunnel closed when the app left the server while it connected", async () => {
    const pages = theServer(new ServerPageError("closed", "Hermes Chat left the Hermes server, so the tunnel to it closed."));
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("The SSH tunnel to this page closed");
    expect(alert.textContent).toContain("Hermes Chat left the Hermes server");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("loads nothing but the tunnel's own address on this computer", async () => {
    const pages = theServer({ url: "https://evil.example/" });
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("The tunnel gave an address the preview doesn't load.");
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();
    expect(pages.closed).toEqual(["1"]);
  });

  it("opens a typed localhost address on the server, and refuses what isn't a web address, saying why", async () => {
    const { user, pages } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    const box = within(pane()).getByRole("textbox");
    await user.type(box, "ftp://localhost:21/{Enter}");
    expect(within(pane()).getByRole("alert").textContent).toBe("Only http:// and https:// pages open in the preview, and ftp: isn't a web address.");
    await user.clear(box);
    await user.type(box, "ssh://liam@hermes{Enter}");
    expect(within(pane()).getByRole("alert").textContent).toBe("Only http:// and https:// pages open in the preview, and ssh: isn't a web address.");
    expect(pages.opened).toEqual([]);

    await user.clear(box);
    await user.type(box, "localhost:5173{Enter}");
    expect((await within(pane()).findByTitle("Web page: http://localhost:5173/")).getAttribute("src")).toBe("http://127.0.0.1:41001/");
    expect(pages.opened).toEqual(["http://localhost:5173/"]);
  });

  it("leaves pages on other hosts on this computer, with no switch", async () => {
    const { user, pages } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(within(pane()).getByText("Web")).toBeTruthy();
    expect(within(pane()).queryByRole("button", { name: "Hermes server" })).toBeNull();
    expect(pages.opened).toEqual([]);
  });
});

describe("Closing and resizing", () => {
  it("closes with its button, the header toggle, or Escape", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    await user.click(within(pane()).getByRole("button", { name: "Close the side panel" }));
    expect(paneOpen()).toBe(false);

    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    expect(screen.getByRole("button", { name: "Close the side panel", pressed: true })).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Close the side panel" })[0]);
    expect(paneOpen()).toBe(false);

    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await user.keyboard("{Escape}");
    expect(paneOpen()).toBe(false);
  });

  it("stops a page once it is out of sight, so a closed or covered preview plays and loads nothing", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(document.querySelector("iframe[title^='Web page']")).not.toBeNull();
    await user.click(within(pane()).getByRole("button", { name: "Close the side panel" }));
    expect(document.querySelector("iframe[title^='Web page']")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    expect(within(pane()).getByTitle("Web page: https://docs.example.com/crash")).toBeTruthy();
    await user.click(within(pane()).getByRole("tab", { name: /Files/ }));
    expect(document.querySelector("iframe[title^='Web page']")).toBeNull();
  });

  it("resizes from its edge with the keyboard, and keeps the width", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    const edge = screen.getByRole("separator", { name: "Resize the side panel" });
    expect(edge.getAttribute("aria-valuenow")).toBe("480");
    edge.focus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(edge.getAttribute("aria-valuenow")).toBe("544");
    expect(pane().style.width).toBe("544px");
    expect(getUIPrefs().previewWidth).toBe(544);
    await user.keyboard("{End}");
    expect(edge.getAttribute("aria-valuenow")).toBe("300");
  });

  it("resizes by dragging its edge", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    const edge = screen.getByRole("separator");
    fireEvent.pointerDown(edge, { button: 0, clientX: 800, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 700, pointerId: 1 });
    expect(pane().style.width).toBe("580px");
    expect(getUIPrefs().previewWidth).toBeNull();
    fireEvent.pointerUp(edge, { clientX: 650, pointerId: 1 });
    expect(pane().style.width).toBe("630px");
    expect(getUIPrefs().previewWidth).toBe(630);
  });

  it("covers the chat in a window too narrow for both, and goes back to the chat without closing", async () => {
    // The main area is 600 px wide: less than the chat's 440 beside the pane's 300.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe() {
          this.cb([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
      },
    );
    const { user } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(pane().className).toContain("overlay");
    expect(screen.queryByRole("separator")).toBeNull();
    expect(pane().contains(document.activeElement)).toBe(true);
    // The chat underneath can't be reached while the pane covers it.
    expect(document.querySelector(".main-chat")!.hasAttribute("inert")).toBe(true);

    await user.click(within(pane()).getByRole("button", { name: "Back to the chat" }));
    expect(paneOpen()).toBe(false);
    expect(document.querySelector(".main-chat")!.hasAttribute("inert")).toBe(false);
    await user.type(screen.getByPlaceholderText("Message Hermes"), "still here");

    await user.click(screen.getByRole("button", { name: "Show the side panel" }));
    expect(within(pane()).getByTitle("Web page: https://docs.example.com/crash")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(paneOpen()).toBe(false);
    expect(screen.getByRole("button", { name: "Show the side panel" })).toBeTruthy();
  });

  it("keeps Alt+arrows from switching the chat hidden under a covering preview", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe() {
          this.cb([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
      },
    );
    const { user, server, hermes } = await signedIn();
    const resumes = () => server.requests.filter((r) => r.method === "session.resume").length;
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(pane().className).toContain("overlay");
    const before = resumes();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await settle(hermes);
    expect(paneOpen()).toBe(true);
    expect(resumes()).toBe(before);
  });

  it.each(["chat", "new", "search", "split"])("shows the destination after %s navigation while the preview covers the chat", async (destination) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe() {
          this.cb([{ contentRect: { width: 700 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
      },
    );
    const { user, hermes } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(pane().className).toContain("overlay");
    if (destination === "new") {
      await user.click(screen.getByRole("button", { name: "New chat (Ctrl+N)" }));
    } else if (destination === "chat") {
      await user.click(screen.getByRole("button", { name: /Another chat/ }));
    } else if (destination === "split") {
      await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /Another chat/ }) });
      await user.click(screen.getByRole("menuitem", { name: "Open in a second pane" }));
    } else {
      await user.click(screen.getByRole("button", { name: "Search all chats (Ctrl+K)" }));
      await user.type(screen.getByPlaceholderText("Search all chats, including Settled"), "Another");
      await user.click(await within(screen.getByRole("dialog", { name: "Search chats" })).findByRole("button", { name: /Another chat/ }));
    }
    await settle(hermes);
    expect(paneOpen()).toBe(false);
    expect(document.querySelector(".main-chat")!.hasAttribute("inert")).toBe(false);
    const destinationPane = document.querySelector<HTMLElement>(destination === "split" ? ".pane.active" : ".pane")!;
    expect(within(destinationPane).getByPlaceholderText("Message Hermes")).toBeTruthy();
    if (destination !== "new") expect(destinationPane.querySelector(".chat-head")!.textContent).toContain("Another chat");
    if (destination === "split") {
      expect(document.querySelectorAll(".pane")).toHaveLength(2);
      expect(document.querySelector(".panes.covered")).toBeNull();
    }
    await user.click(within(destinationPane).getByRole("button", { name: "Show the side panel" }));
    expect(within(pane()).getByTitle("Web page: https://docs.example.com/crash")).toBeTruthy();
  });

  it("closes when the owner switches profile, and a Server file is then read for the new profile", async () => {
    const { server, user, hermes } = await signedIn();
    server.otherProfiles = { work: [] };
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(paneOpen()).toBe(true);

    await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await user.click(await screen.findByRole("option", { name: /work/ }));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" }));
    expect(paneOpen()).toBe(false);

    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await user.type(within(pane()).getByRole("textbox"), "/home/liam/app/main.py{Enter}");
    await within(pane()).findByText(/missing\.txt/);
    expect(fsReads(server).at(-1)!.query.get("profile")).toBe("work");
  });
});

describe("The link menu (issue #240)", () => {
  const DOCS = "https://docs.example.com/crash";
  const menuItems = () => screen.getAllByRole("menuitem").map((b) => b.textContent);
  const item = (name: string) => screen.getByRole("menuitem", { name });
  const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 40, clientY: 50 });
  /** The clipboard: `writes` records what was copied; `fails` makes writing reject with it; `missing` has no writeText. */
  function clipboard({ fails, missing }: { fails?: Error; missing?: boolean } = {}) {
    const writes: string[] = [];
    const writeText = async (t: string) => {
      if (fails) throw fails;
      writes.push(t);
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: missing ? {} : { writeText } });
    return writes;
  }

  it("offers the Preview, the browser and copying on a web link in a reply, instead of WebKit's own menu", async () => {
    const { user, web } = await signedIn();
    const link = screen.getByRole("link", { name: "the docs" });
    expect(rightClick(link)).toBe(false);
    expect(menuItems()).toEqual(["Open in the Preview", "Open in your browser", "Copy link"]);

    await user.click(item("Open in your browser"));
    expect(web.opened).toEqual([DOCS]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(paneOpen()).toBe(false);

    rightClick(link);
    await user.click(item("Open in the Preview"));
    expect(await within(pane()).findByTitle(`Web page: ${DOCS}`)).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(web.opened).toEqual([DOCS]);
  });

  it("says why the browser didn't open", async () => {
    const { user } = await signedIn({ web: theWeb({}, "Couldn't find xdg-open, which opens pages in your browser.") });
    rightClick(screen.getByRole("link", { name: "the docs" }));
    await user.click(item("Open in your browser"));
    expect(await screen.findByText("Couldn't open it in your browser: Couldn't find xdg-open, which opens pages in your browser.")).toBeTruthy();
  });

  it("copies the link and says so, or says why it couldn't", async () => {
    const { user } = await signedIn();
    const link = screen.getByRole("link", { name: "the docs" });
    const writes = clipboard();
    rightClick(link);
    await user.click(item("Copy link"));
    expect(await screen.findByText("Link copied.")).toBeTruthy();
    expect(writes).toEqual([DOCS]);

    clipboard({ fails: new Error("Write permission denied.") });
    rightClick(link);
    await user.click(item("Copy link"));
    expect(await screen.findByText("Couldn't copy the link: Write permission denied.")).toBeTruthy();

    clipboard({ missing: true });
    rightClick(link);
    await user.click(item("Copy link"));
    expect(await screen.findByText("Couldn't copy the link.")).toBeTruthy();
  });

  it("keeps a server page out of this computer's browser, and opens it in the Preview through SSH", async () => {
    const { user, web, pages } = await signedIn();
    const writes = clipboard();
    rightClick(screen.getByRole("link", { name: "the dev server" }));
    expect(menuItems()).toEqual(["Open in the Preview", "Open in your browser", "Copy link"]);
    const browser = item("Open in your browser");
    expect(browser.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("A server page opens in your browser only through the Preview.").id).toBe(browser.getAttribute("aria-describedby"));

    await user.click(browser);
    expect(web.opened).toEqual([]);
    expect(pages.opened).toEqual([]);

    await user.click(item("Copy link"));
    expect(writes).toEqual(["http://localhost:5173/app?v=2"]);

    rightClick(screen.getByRole("link", { name: "the dev server" }));
    await user.click(item("Open in the Preview"));
    await waitFor(() => expect(pages.opened).toEqual(["http://localhost:5173/app?v=2"]));
    expect(web.opened).toEqual([]);
  });

  it("lets a mail link only be copied, as written", async () => {
    const { user } = await signedIn();
    const writes = clipboard();
    expect(rightClick(screen.getByRole("link", { name: "a mail" }))).toBe(false);
    expect(menuItems()).toEqual(["Copy link"]);
    await user.click(item("Copy link"));
    expect(writes).toEqual(["mailto:x@example.com"]);
  });

  it("leaves a same-page link's own menu alone, blocks it on an emptied file: link, and gives a web link in a previewed Markdown file the link menu", async () => {
    const { server, user } = await signedIn();
    server.serverFiles["/home/liam/app/GUIDE.md"] = "# Guide\n\nSee [Usage](#usage), [the site](https://guide.example.com/) and [the hosts file](file:///etc/hosts).\n\n## Usage\n\nRun it.\n";
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await user.click(within(pane()).getByRole("textbox"));
    await user.paste("/home/liam/app/GUIDE.md");
    await user.keyboard("{Enter}");
    await within(pane()).findByRole("heading", { name: "Guide" });

    expect(rightClick(within(pane()).getByRole("link", { name: "Usage" }))).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();

    // react-markdown empties a file: address, so there is nothing to copy, and WebKit's Open Link would load this page.
    const hosts = within(pane()).getByText("the hosts file");
    expect(hosts.getAttribute("href")).toBe("");
    expect(rightClick(hosts)).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();

    expect(rightClick(within(pane()).getByRole("link", { name: "the site" }))).toBe(false);
    expect(menuItems()).toEqual(["Open in the Preview", "Open in your browser", "Copy link"]);
  });

  it("opens from the keyboard on the focused link, and gives focus back on Escape", async () => {
    const { user } = await signedIn();
    const link = screen.getByRole("link", { name: "the docs" });
    link.focus();
    // The Menu key and Shift+F10 send a contextmenu with no pointer position.
    expect(fireEvent.contextMenu(link, { clientX: 0, clientY: 0 })).toBe(false);
    expect(document.activeElement).toBe(item("Open in the Preview"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("Open in your browser"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(link);
  });

  it("is on a tool call's web page chip too, and not on its file or Output chips", async () => {
    const { user, web } = await signedIn();
    await openTool(user, "browser_navigate");
    expect(rightClick(screen.getByRole("button", { name: "crash" }))).toBe(false);
    expect(menuItems()).toEqual(["Open in the Preview", "Open in your browser", "Copy link"]);
    await user.click(item("Open in your browser"));
    expect(web.opened).toEqual([DOCS]);

    await openTool(user, "read_file");
    expect(rightClick(screen.getByRole("button", { name: "main.py" }))).toBe(true);
    await openTool(user, "patch");
    expect(rightClick(screen.getByRole("button", { name: "Output" }))).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
