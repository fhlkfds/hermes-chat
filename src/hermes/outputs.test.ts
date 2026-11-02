// Outputs (outputs.ts): which stored tool results count as files Hermes made, how they are kept, and how the index
// reads Hermes, against a fake Hermes whose stored rows and `/api/fs/list` answer as the deployed `bf0203a` does.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes, row, type TranscriptMessage } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import {
  MAX_CHATS_PER_RUN,
  MAX_ROWS_PER_CHAT,
  OUTPUTS_KEY,
  OUTPUTS_KEPT,
  OutputsIndex,
  checkPaths,
  outputsFromRows,
  outputsIn,
  previewable,
  producedBy,
  readScope,
  shownName,
  typeOf,
  versions,
  type OutputsIo,
  type StoredRow,
} from "./outputs";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

/** A storage like localStorage, optionally refusing writes as a full one does. */
function memory(full = false) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (full) throw new DOMException("quota", "QuotaExceededError");
      m.set(k, v);
    },
  };
}

/** A tool call and its stored result, as an assistant row and a tool row. */
function call(id: string, name: string, args: Record<string, unknown>, result: unknown, rowId: number, ts = 1_790_000_000 + rowId): TranscriptMessage[] {
  return [
    { role: "assistant", text: "", row_id: rowId, timestamp: ts, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", name, tool_call_id: id, row_id: rowId + 1, timestamp: ts, result: typeof result === "string" ? result : JSON.stringify(result) },
  ];
}

const written = (path: string, bytes = 12) => ({ bytes_written: bytes, dirs_created: false, resolved_path: path, files_modified: [path] });

describe("which tool results are Outputs", () => {
  it("lists what write_file, patch, text_to_speech and image_generate say they wrote", () => {
    expect(producedBy("write_file", JSON.stringify(written("/srv/out/report.md", 2048)))).toEqual([{ path: "/srv/out/report.md", how: "written", size: 2048 }]);
    expect(producedBy("patch", JSON.stringify({ success: true, files_created: ["/srv/a.ts", "relative.ts"], files_modified: ["/srv/b.ts"] }))).toEqual([
      { path: "/srv/a.ts", how: "created" },
    ]);
    expect(producedBy("text_to_speech", JSON.stringify({ success: true, file_path: "/h/.hermes/audio/tts_1.mp3", file_paths: ["/h/.hermes/audio/tts_1.mp3", "/h/.hermes/audio/tts_2.mp3"], media_tag: "MEDIA:/h/.hermes/audio/tts_1.mp3" }))).toEqual([
      { path: "/h/.hermes/audio/tts_1.mp3", how: "speech" },
      { path: "/h/.hermes/audio/tts_2.mp3", how: "speech" },
    ]);
    expect(producedBy("image_generate", JSON.stringify({ success: true, image: "/h/.hermes/cache/images/cat.png" }))).toEqual([{ path: "/h/.hermes/cache/images/cat.png", how: "image" }]);
  });

  it("lists nothing for a failed call, a provider URL, an edit of an existing file, or another tool's paths", () => {
    expect(producedBy("write_file", JSON.stringify({ error: "Refusing to write to sensitive path" }))).toEqual([]);
    expect(producedBy("image_generate", JSON.stringify({ success: true, image: "https://fal.media/files/cat.png" }))).toEqual([]);
    expect(producedBy("image_generate", JSON.stringify({ success: false, image: null, error: "quota" }))).toEqual([]);
    expect(producedBy("patch", JSON.stringify({ success: true, files_modified: ["/srv/b.ts"], files_created: [] }))).toEqual([]);
    const rows: StoredRow[] = [
      { id: 1, role: "assistant", content: "I saved it to /srv/out/summary.pdf and MEDIA:/srv/out/x.png" },
      { id: 2, role: "tool", tool_name: "terminal", tool_call_id: "t", content: JSON.stringify({ output: "wrote /srv/out/data.csv", exit_code: 0 }) },
      { id: 3, role: "tool", tool_name: "read_file", tool_call_id: "r", content: JSON.stringify({ path: "/srv/out/in.txt", content: "…" }) },
    ];
    expect(outputsFromRows("c", rows)).toEqual({ outputs: [], unlabelled: 0 });
  });

  it("takes an older write_file result's path from the call's arguments, and counts a producer result that says nothing", () => {
    const rows: StoredRow[] = [
      { id: 1, role: "assistant", tool_calls: JSON.stringify([{ id: "w1", function: { name: "write_file", arguments: JSON.stringify({ path: "/srv/old.txt", content: "x" }) } }]) },
      { id: 2, role: "tool", tool_name: "write_file", tool_call_id: "w1", content: JSON.stringify({ bytes_written: 1 }) },
      { id: 3, role: "tool", tool_name: "write_file", tool_call_id: "w2", content: JSON.stringify({ bytes_written: 5 }) },
      { id: 4, role: "tool", tool_name: "text_to_speech", tool_call_id: "s1", content: "Audio saved (output cut short…" },
    ];
    const { outputs, unlabelled } = outputsFromRows("c", rows);
    expect(outputs.map((o) => [o.path, o.size, o.callId, o.rowId])).toEqual([["/srv/old.txt", 1, "w1", 2]]);
    expect(unlabelled).toBe(2);
  });

  it("keys an Output by chat, call and path, so reading the chat again makes no new ones", () => {
    const rows: StoredRow[] = [{ id: 9, role: "tool", tool_name: "write_file", tool_call_id: "w", content: JSON.stringify(written("/srv/a.md")) }];
    const first = outputsFromRows("c", rows).outputs;
    const again = outputsFromRows("c", [...rows, ...rows]).outputs;
    expect(again).toEqual(first);
    expect(outputsFromRows("other", rows).outputs[0].key).not.toBe(first[0].key);
  });
});

describe("showing an Output", () => {
  it("makes invisible and direction-changing characters in a name visible", () => {
    expect(shownName("/srv/out/invoice‮fdp.exe")).toBe("invoice�fdp.exe");
    expect(shownName("/srv/out/a\nb.txt")).toBe("a�b.txt");
    expect(shownName("/srv/<img src=x onerror=alert(1)>.html")).toBe("<img src=x onerror=alert(1)>.html");
    expect(typeOf("/srv/x‮gnp.exe")).toBe("other");
  });

  it("sorts types and says which can be previewed", () => {
    expect([typeOf("/a/b.PNG"), typeOf("/a/b.md"), typeOf("/a/b.pdf"), typeOf("/a/b.mp3"), typeOf("/a/b.tar.gz"), typeOf("/a/Makefile")]).toEqual([
      "image",
      "text",
      "document",
      "media",
      "archive",
      "other",
    ]);
    const o = (path: string, extra = {}) => ({ key: path, path, how: "written" as const, ...extra });
    expect(previewable(o("/a/b.md")).ok).toBe(true);
    expect(previewable(o("/a/b.html")).ok).toBe(true);
    expect(previewable(o("/a/Makefile")).ok).toBe(true);
    expect(previewable(o("/a/b.pdf"))).toEqual({ ok: false, why: "The preview can't show document files." });
    expect(previewable(o("/a/b.png", { size: 40 * 1024 * 1024 })).ok).toBe(false);
    expect(previewable(o("/a/b.md", { availability: { state: "missing", checkedAt: 1 } })).ok).toBe(false);
  });

  it("numbers the versions of one path, oldest first", () => {
    const o = (key: string, path: string, at: number) => ({ key, path, how: "written" as const, at });
    const v = versions([o("1", "/a.md", 30), o("2", "/a.md", 10), o("3", "/b.md", 5), o("4", "/a.md", 20)]);
    expect(v.get("2")).toEqual({ n: 1, of: 3, latest: false });
    expect(v.get("1")).toEqual({ n: 3, of: 3, latest: true });
    expect(v.has("3")).toBe(false);
  });
});

/** A signed-in app against a fake Hermes holding these chats and transcripts. */
async function signedIn(setup: (s: FakeHermes) => void) {
  const server = new FakeHermes();
  setup(server);
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  return { server, hermes };
}

describe("indexing chats on a fake Hermes", () => {
  it("finds several files, keeps them across a reconnect with the same provenance, and makes no duplicates", async () => {
    const { server, hermes } = await signedIn((s) => {
      s.sessions = [row("chat-a", 0, { title: "Report" })];
      s.transcripts["chat-a"] = [
        { role: "user", text: "Write the report and a chart", row_id: 1 },
        ...call("w1", "write_file", { path: "/srv/out/report.md", content: "# R" }, written("/srv/out/report.md", 3), 2),
        ...call("i1", "image_generate", { prompt: "chart" }, { success: true, image: "/srv/out/chart.png" }, 4),
        ...call("w2", "write_file", { path: "/srv/out/report.md", content: "# R2" }, written("/srv/out/report.md", 4), 6),
        { role: "assistant", text: "Done: /srv/out/report.md", row_id: 8 },
      ];
      s.serverFiles["/srv/out/report.md"] = "# R2";
      s.serverFiles["/srv/out/chart.png"] = "PNG";
    });
    const storage = memory();
    const index = new OutputsIndex(hermes.outputsIo("default"), storage, "scope");
    const chats = [{ id: "chat-a", updatedAt: 100 }];
    await index.index(chats);
    const found = outputsIn(index.getSnapshot());
    expect(found.map((o) => [o.path, o.how, o.callId, o.rowId]).sort()).toEqual([
      ["/srv/out/chart.png", "image", "i1", 5],
      ["/srv/out/report.md", "written", "w1", 3],
      ["/srv/out/report.md", "written", "w2", 7],
    ]);
    // Every request named the profile and asked for the newest rows, without inline images.
    const reads = server.restRequests.filter((r) => r.path.endsWith("/messages"));
    expect(reads.every((r) => r.query.get("profile") === "default" && r.query.get("order") === "latest" && r.query.get("inline_images") === "false")).toBe(true);

    await index.check(found);
    expect(outputsIn(index.getSnapshot()).map((o) => o.availability?.state)).toEqual(["available", "available", "available"]);

    // Reconnect, then a new run with the chat changed: the same keys, and nothing twice.
    server.drop();
    await hermes.reconnect();
    expect(hermes.getSnapshot().status).toBe("connected");
    const again = new OutputsIndex(hermes.outputsIo("default"), storage, "scope");
    expect(outputsIn(again.getSnapshot())).toEqual(outputsIn(index.getSnapshot()));
    await again.index([{ id: "chat-a", updatedAt: 200 }]);
    const keys = outputsIn(again.getSnapshot()).map((o) => o.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys.sort()).toEqual(found.map((o) => o.key).sort());
    // The availability already known for a path is kept.
    expect(outputsIn(again.getSnapshot()).every((o) => o.availability?.state === "available")).toBe(true);
  });

  it("doesn't read an unchanged chat again, and reads it again when forced", async () => {
    const { server, hermes } = await signedIn((s) => {
      s.transcripts["c"] = call("w", "write_file", { path: "/a" }, written("/srv/a.txt"), 1);
    });
    const index = new OutputsIndex(hermes.outputsIo("default"), memory(), "scope");
    await index.index([{ id: "c", updatedAt: 1 }]);
    const reads = () => server.restRequests.filter((r) => r.path.endsWith("/messages")).length;
    const n = reads();
    await index.index([{ id: "c", updatedAt: 1 }]);
    expect(reads()).toBe(n);
    await index.index([{ id: "c", updatedAt: 1 }], true);
    expect(reads()).toBeGreaterThan(n);
  });

  it("reads at most the newest rows per chat, and says older ones weren't read", async () => {
    const { hermes } = await signedIn((s) => {
      s.transcripts["long"] = Array.from({ length: MAX_ROWS_PER_CHAT + 50 }, (_, i) => ({ role: "user" as const, text: `m${i}`, row_id: i + 1 }));
    });
    const index = new OutputsIndex(hermes.outputsIo("default"), memory(), "scope");
    await index.index([{ id: "long", updatedAt: 1 }]);
    expect(index.getSnapshot().chats.long.partial).toEqual({ olderRows: true });
  });

  it("reads a page too big in smaller pages, and skips a single row too big to read", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    const { hermes } = await signedIn((s) => {
      s.transcripts["c"] = [
        ...call("w", "write_file", { path: "/a" }, written("/srv/kept.txt"), 1),
        { role: "tool", name: "read_file", tool_call_id: "r", row_id: 3, result: big },
        ...call("w2", "write_file", { path: "/b" }, written("/srv/also.txt"), 4),
      ];
    });
    const index = new OutputsIndex(hermes.outputsIo("default"), memory(), "scope");
    await index.index([{ id: "c", updatedAt: 1 }]);
    const c = index.getSnapshot().chats.c;
    expect(c.outputs.map((o) => o.path).sort()).toEqual(["/srv/also.txt", "/srv/kept.txt"]);
    expect(c.partial).toEqual({ bigRows: 1 });
  });

  it("indexes the most recent chats first, at most a run's worth, and says how many wait", async () => {
    const { hermes } = await signedIn(() => {});
    const index = new OutputsIndex(hermes.outputsIo("default"), memory(), "scope");
    const chats = Array.from({ length: MAX_CHATS_PER_RUN + 3 }, (_, i) => ({ id: `c${i}`, updatedAt: i }));
    await index.index(chats);
    const snap = index.getSnapshot();
    expect(Object.keys(snap.chats)).toHaveLength(MAX_CHATS_PER_RUN);
    expect(snap.chats.c0).toBeUndefined();
    expect(snap.waiting).toBe(3);
  });

  it("drops what a cancelled run reads, as when the profile changes during a fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const io: OutputsIo = {
      rows: async () => {
        await gate;
        return [{ id: 1, role: "tool", tool_name: "write_file", tool_call_id: "w", content: JSON.stringify(written("/srv/late.txt")) }];
      },
      listDir: async () => ({ entries: [] }),
    };
    const storage = memory();
    const index = new OutputsIndex(io, storage, "work-profile");
    const run = index.index([{ id: "c", updatedAt: 1 }]);
    expect(index.getSnapshot().indexing).toEqual({ done: 0, total: 1 });
    index.cancel();
    release();
    await run;
    expect(index.getSnapshot().chats).toEqual({});
    expect(index.getSnapshot().indexing).toBeUndefined();
    expect(storage.m.get(OUTPUTS_KEY)).toBeUndefined();
  });

  it("says when the server has no stored-messages route", async () => {
    const { server, hermes } = await signedIn(() => {});
    server.transcripts = {};
    const io = hermes.outputsIo("default");
    const index = new OutputsIndex({ ...io, rows: () => Promise.reject(new Error('The dashboard answered 404: {"detail":"Not Found"}')) }, memory(), "s");
    await index.index([{ id: "c", updatedAt: 1 }]);
    expect(index.getSnapshot().unsupported).toMatch(/can't list a chat's stored messages/);
  });
});

describe("checking where files are", () => {
  it("tells available, missing, renamed, a folder now, a gone folder and a forbidden one apart, one listing per folder", async () => {
    const { server, hermes } = await signedIn((s) => {
      s.serverFiles["/srv/out/kept.txt"] = "k";
      s.serverFiles["/srv/out/renamed-to.txt"] = "r";
      s.serverDirs.add("/srv/out/dir.txt");
      s.serverDirs.add("/srv/out");
    });
    const io = hermes.outputsIo("default");
    server.rest["GET /api/fs/list"] = ((list) => (req) => (req.query.get("path") === "/locked" ? { entries: [], error: "EACCES" } : list(req)))(server.rest["GET /api/fs/list"]);
    const found = await checkPaths(io, ["/srv/out/kept.txt", "/srv/out/renamed-from.txt", "/srv/out/dir.txt", "/srv/gone/x.txt", "/locked/x.txt"], 5);
    expect(Object.fromEntries([...found].map(([p, a]) => [p, a.state]))).toEqual({
      "/srv/out/kept.txt": "available",
      "/srv/out/renamed-from.txt": "missing",
      "/srv/out/dir.txt": "folder",
      "/srv/gone/x.txt": "missing",
      "/locked/x.txt": "forbidden",
    });
    expect(server.restRequests.filter((r) => r.path === "/api/fs/list").map((r) => r.query.get("path"))).toEqual(["/srv/out", "/srv/gone", "/locked"]);
  });

  it("reports a refused listing as forbidden and another failure as unknown", async () => {
    const io = (err: string): OutputsIo => ({ rows: async () => [], listDir: () => Promise.reject(new Error(err)) });
    expect((await checkPaths(io('The dashboard answered 403: {"detail":"Access denied"}'), ["/a/b"])).get("/a/b")?.state).toBe("forbidden");
    expect((await checkPaths(io("Can't reach the Hermes dashboard"), ["/a/b"])).get("/a/b")).toMatchObject({ state: "unknown", why: "Can't reach the Hermes dashboard" });
  });

  it("adds a Server file the owner names only once it is there", async () => {
    const { hermes } = await signedIn((s) => {
      s.serverFiles["/srv/hand/picked.csv"] = "a,b";
      s.serverDirs.add("/srv/hand/sub");
    });
    const index = new OutputsIndex(hermes.outputsIo("default"), memory(), "s");
    await expect(index.add("relative.csv")).rejects.toThrow(/full path/);
    await expect(index.add("/srv/hand/nope.csv")).rejects.toThrow(/deleted, moved or renamed|isn't on the server/);
    await expect(index.add("/srv/hand/sub")).rejects.toThrow(/folder/);
    const added = await index.add(" /srv/hand/picked.csv ", "chat-1");
    expect(added).toMatchObject({ path: "/srv/hand/picked.csv", how: "added", chatId: "chat-1", availability: { state: "available" } });
    await expect(index.add("/srv/hand/picked.csv", "chat-1")).rejects.toThrow(/already/);
    expect(outputsIn(index.getSnapshot(), new Set(["chat-1"]))).toHaveLength(1);
    expect(outputsIn(index.getSnapshot(), new Set(["chat-2"]))).toHaveLength(0);
    index.remove(added.key);
    expect(index.getSnapshot().added).toEqual([]);
  });
});

describe("what this computer keeps", () => {
  it("keeps each connection and profile apart, holds metadata only, and survives a hand-edited document", async () => {
    const storage = memory();
    const io: OutputsIo = {
      rows: async () => [{ id: 1, role: "tool", tool_name: "write_file", tool_call_id: "w", content: JSON.stringify({ ...written("/srv/a.md"), content: "SECRET BODY" }) }],
      listDir: async () => ({ entries: [] }),
    };
    await new OutputsIndex(io, storage, "conn|default").index([{ id: "c", updatedAt: 1 }]);
    expect(readScope(storage, "conn|work").chats).toEqual({});
    expect(Object.keys(readScope(storage, "conn|default").chats)).toEqual(["c"]);
    expect(storage.m.get(OUTPUTS_KEY)).not.toContain("SECRET BODY");

    storage.m.set(OUTPUTS_KEY, JSON.stringify({ v: 1, scopes: { s: { chats: { c: { updatedAt: 1, outputs: [{ key: "k", path: "relative", how: "written" }, { key: "k2", path: "/ok", how: "nope" }] } } } } }));
    expect(readScope(storage, "s").chats.c.outputs).toEqual([]);
    storage.m.set(OUTPUTS_KEY, "{not json");
    expect(readScope(storage, "s")).toMatchObject({ chats: {}, added: [] });
  });

  it("drops the chats indexed longest ago past the limit, and says when storage refuses", async () => {
    const storage = memory();
    let t = 0;
    const perChat = 1000;
    const io: OutputsIo = {
      rows: async (chatId) =>
        Array.from({ length: perChat }, (_, i) => ({ id: i + 1, role: "tool", tool_name: "write_file", tool_call_id: `${chatId}-${i}`, content: JSON.stringify(written(`/srv/${chatId}/${i}.txt`)) })),
      listDir: async () => ({ entries: [] }),
    };
    const index = new OutputsIndex(io, storage, "s", () => ++t);
    await index.index([{ id: "old", updatedAt: 3 }, { id: "mid", updatedAt: 2 }, { id: "new", updatedAt: 1 }, { id: "newest", updatedAt: 0 }]);
    const kept = readScope(storage, "s");
    const total = Object.values(kept.chats).reduce((n, c) => n + c.outputs.length, 0);
    expect(total).toBeLessThanOrEqual(OUTPUTS_KEPT);
    expect(Object.keys(kept.chats)).not.toContain("old");

    const full = new OutputsIndex(io, memory(true), "s");
    await full.index([{ id: "c", updatedAt: 1 }]);
    expect(full.getSnapshot().notSaved).toBe(true);
    expect(outputsIn(full.getSnapshot())).toHaveLength(perChat);
  });
});
