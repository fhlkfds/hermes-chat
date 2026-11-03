// What the preview pane opens and how it reads Server and Local files. Server files go through the real transport to a
// FakeHermes whose `/api/fs/*` routes answer as the deployed `bf0203a` did when probed (research doc "Preview pane").
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";
import { checkWebUrl, fenced, parseAddress, readLocalFile, sandboxedHtml, toolTargets, withoutBidi, type LocalText } from "./preview";
import type { Item } from "./model";

const APP = "tauri://localhost";
type ToolItem = Extract<Item, { kind: "tool" }>;
const tool = (name: string, args: Record<string, unknown>, result?: string): ToolItem => ({ kind: "tool", id: "t1", name, args, status: "done", result });

describe("Opening a web page", () => {
  it("takes http and https addresses", () => {
    expect(checkWebUrl("https://example.com/docs?q=1", APP)).toEqual({ url: "https://example.com/docs?q=1" });
    expect(checkWebUrl(" http://hermes:3000 ", APP)).toEqual({ url: "http://hermes:3000/" });
  });

  it("refuses other schemes, credentials in the address, and the app's own origin", () => {
    for (const raw of ["javascript:alert(1)", "file:///etc/passwd", "tauri://localhost/", "ipc://localhost/cmd", "data:text/html,<b>x</b>", "ftp://x"])
      expect(checkWebUrl(raw, APP), raw).toHaveProperty("error");
    expect(checkWebUrl("https://liam:hunter2@example.com", APP)).toEqual({
      error: "Web addresses with a username or password in them don't open in the preview.",
    });
    // In `npm run app` the app itself is served over http.
    expect(checkWebUrl("http://localhost:1420/", "http://localhost:1420")).toEqual({ error: "Hermes Chat's own pages don't open in the preview." });
    expect(checkWebUrl("http://localhost:5173/", "http://localhost:1420")).toEqual({ url: "http://localhost:5173/" });
  });
});

describe("The pane's address box", () => {
  it("opens a full path on the server, or a web page", () => {
    expect(parseAddress("/home/liam/notes.md", APP)).toEqual({ target: { kind: "server", path: "/home/liam/notes.md" } });
    expect(parseAddress("~/project/README.md", APP)).toEqual({ target: { kind: "server", path: "~/project/README.md" } });
    expect(parseAddress("https://example.com", APP)).toEqual({ target: { kind: "web", url: "https://example.com/" } });
  });

  it("explains a relative path, a file:// address, and an empty box", () => {
    expect(parseAddress("notes.md", APP)).toHaveProperty("error", expect.stringContaining("starting with / or ~/"));
    expect(parseAddress("file:///home/liam/notes.md", APP)).toEqual({ error: "To preview a file on this computer, use Open a file on this computer." });
    expect(parseAddress("   ", APP)).toHaveProperty("error");
  });
});

describe("What a tool call can preview", () => {
  it("finds the server file a file tool used", () => {
    expect(toolTargets(tool("read_file", { path: "/home/liam/app/main.py", offset: 1 }), APP)).toEqual([{ kind: "server", path: "/home/liam/app/main.py" }]);
    expect(toolTargets(tool("write_file", { path: "~/notes.md", content: "x" }), APP)).toEqual([{ kind: "server", path: "~/notes.md" }]);
  });

  it("finds the pages a browser or web tool used", () => {
    expect(toolTargets(tool("browser_navigate", { url: "https://example.com" }), APP)).toEqual([{ kind: "web", url: "https://example.com/" }]);
    expect(toolTargets(tool("web_extract", { urls: ["https://a.example/", "https://b.example/", 7, "javascript:alert(1)"] }), APP)).toEqual([
      { kind: "web", url: "https://a.example/" },
      { kind: "web", url: "https://b.example/" },
    ]);
  });

  it("finds MEDIA: files in the result, each once, and skips relative paths", () => {
    const t = tool("image_generate", { path: "out.png" }, "Saved MEDIA:/home/liam/.hermes/images/cat.png and MEDIA:/home/liam/.hermes/images/cat.png.");
    expect(toolTargets(t, APP)).toEqual([{ kind: "server", path: "/home/liam/.hermes/images/cat.png" }]);
  });

  it("finds nothing in a tool call that names no file or page", () => {
    expect(toolTargets(tool("terminal", { command: "ls /etc" }, "passwd\nhosts"), APP)).toEqual([]);
  });
});

/** Signed in to a FakeHermes with `files` on the server's disk. */
async function server(files: FakeHermes["serverFiles"]) {
  const s = new FakeHermes();
  s.serverFiles = files;
  const hermes = await connect(s.openPipe);
  return { s, hermes };
}

describe("Reading a Server file", () => {
  it("reads text through dashboard REST, for the profile shown", async () => {
    const { s, hermes } = await server({ "/home/liam/app/main.py": 'print("hi")\n' });
    expect(await hermes.readServerFile("/home/liam/app/main.py")).toEqual({
      kind: "text",
      text: 'print("hi")\n',
      language: "python",
      format: "code",
      size: 12,
      truncated: false,
    });
    const req = s.restRequests.at(-1)!;
    expect([req.method, req.path, req.query.get("path"), req.query.get("profile")]).toEqual(["GET", "/api/fs/read-text", "/home/liam/app/main.py", "default"]);
  });

  it("says when only the first 512 KB is shown", async () => {
    const { hermes } = await server({ "/var/log/big.log": "x".repeat(600_000) });
    const v = await hermes.readServerFile("/var/log/big.log");
    expect(v).toMatchObject({ kind: "text", truncated: true, size: 600_000 });
    expect(v.kind === "text" && v.text.length).toBe(512 * 1024);
  });

  it("marks Markdown and HTML for their rendered view", async () => {
    const { hermes } = await server({ "/srv/README.md": "# Hi", "/srv/site/index.html": "<h1>Hi</h1>" });
    expect(await hermes.readServerFile("/srv/README.md")).toMatchObject({ format: "markdown", language: "markdown" });
    expect(await hermes.readServerFile("/srv/site/index.html")).toMatchObject({ format: "html", language: "xml" });
  });

  it("reads an image as a data URL", async () => {
    const { s, hermes } = await server({ "/home/liam/cat.png": "\x89PNG\r\n\x1a\nbytes" });
    const v = await hermes.readServerFile("/home/liam/cat.png");
    expect(v).toEqual({ kind: "image", src: `data:image/png;base64,${btoa("\x89PNG\r\n\x1a\nbytes")}`, size: 13 });
    expect(s.restRequests.at(-1)!.path).toBe("/api/fs/read-data-url");
  });

  it("won't show a binary file that isn't an image", async () => {
    const { hermes } = await server({ "/home/liam/report.pdf": "%PDF-1.7\0\0\0binary", "/usr/bin/tool": "\x7fELF\0\0\0" });
    expect(await hermes.readServerFile("/home/liam/report.pdf")).toEqual({ kind: "unsupported", reason: "The preview can't show PDF files.", size: 17 });
    expect(await hermes.readServerFile("/usr/bin/tool")).toEqual({ kind: "unsupported", reason: "The preview can't show binary files.", size: 7 });
  });

  it("explains a missing file, a folder, and a credentials file Hermes refuses", async () => {
    const { hermes } = await server({ "/home/liam/app": { dir: true }, "/home/liam/app/.env": "SECRET=1" });
    await expect(hermes.readServerFile("/home/liam/gone.txt")).rejects.toThrow("There's no file at this path on the Hermes server.");
    await expect(hermes.readServerFile("/home/liam/app")).rejects.toThrow("This path is a folder on the Hermes server, not a file.");
    await expect(hermes.readServerFile("/home/liam/app/.env")).rejects.toThrow("Hermes doesn't show this file, since it may hold credentials.");
  });

  it("says when the server can't read files at all", async () => {
    const { s, hermes } = await server({});
    delete s.rest["GET /api/fs/read-text"];
    await expect(hermes.readServerFile("/etc/hosts")).rejects.toThrow("This Hermes server can't read files for the preview.");
  });

  it("refuses a relative path before asking Hermes", async () => {
    const { s, hermes } = await server({});
    await expect(hermes.readServerFile("notes.md")).rejects.toThrow("starting with / or ~/");
    expect(s.restRequests.filter((r) => r.path.startsWith("/api/fs"))).toEqual([]);
  });

  it("doesn't show a data URL that isn't an image", async () => {
    const { s, hermes } = await server({ "/home/liam/fake.svg": "x" });
    s.rest["GET /api/fs/read-data-url"] = () => ({ dataUrl: "data:text/html;base64,PHNjcmlwdD4=" });
    expect(await hermes.readServerFile("/home/liam/fake.svg")).toMatchObject({ kind: "unsupported", reason: "The preview can't show text/html files." });
  });
});

describe("Reading a Local file", () => {
  const io = (t: Partial<LocalText>) => ({
    readText: async () => ({ size: 5, truncated: false, binary: false, text: "hello", ...t }),
    readImage: async (path: string) => `blob:${path}`,
  });

  it("reads an image as an object URL, and text as text", async () => {
    expect(await readLocalFile({ path: "/home/liam/cat.png", name: "cat.png" }, io({}))).toEqual({ kind: "image", src: "blob:/home/liam/cat.png" });
    expect(await readLocalFile({ path: "/home/liam/notes.md", name: "notes.md" }, io({}))).toEqual({
      kind: "text",
      text: "hello",
      language: "markdown",
      format: "markdown",
      size: 5,
      truncated: false,
    });
  });

  it("won't show a binary file", async () => {
    expect(await readLocalFile({ path: "/home/liam/disk.img", name: "disk.img" }, io({ binary: true, size: 4096 }))).toEqual({
      kind: "unsupported",
      reason: "The preview can't show binary files.",
      size: 4096,
    });
  });
});

describe("Rendering untrusted file text", () => {
  it("fences code so the file can't close the fence", () => {
    expect(fenced("a ``` b ```` c", "python")).toBe("`````python\na ``` b ```` c\n`````");
    expect(fenced("plain", "")).toBe("```\nplain\n```");
  });

  it("puts a no-network policy ahead of an HTML file", () => {
    const doc = sandboxedHtml("<img src=https://tracker.example/p.gif><script>alert(1)</script>");
    expect(doc.startsWith('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:;')).toBe(true);
    expect(doc).toContain("<script>alert(1)</script>");
  });
});

describe("withoutBidi", () => {
  it("shows the controls that reverse a name, and keeps right-to-left text and emoji as they are", () => {
    expect(withoutBidi("/srv/invoice\u202Efdp.exe")).toBe("/srv/invoice\uFFFDfdp.exe");
    expect(withoutBidi("a\u2066b\u2069c\u202Ad")).toBe("a\uFFFDb\uFFFDc\uFFFDd");
    const kept = "\u05E9\u05DC\u05D5\u05DD \u200F report-\u{1F468}\u200D\u{1F4BB}.md";
    expect(withoutBidi(kept)).toBe(kept);
  });
});
