// A message whose send fails, or whose fate can't be known, keeps its text, and is sent again only when the owner
// asks. These run the real transport against FakeHermes and the draft store over an in-memory localStorage, the way
// App wires them together.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSignIn } from "./account";
import { type DraftStorage, draftKey, drafts } from "./drafts";
import { FakeHermes, row } from "./fakeHermes";
import { connect } from "./transport";

function memoryStorage() {
  const items = new Map<string, string>();
  const storage: DraftStorage = {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
  };
  return Object.assign(storage, { items });
}

const nas: SavedSignIn = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" };
const TEXT = "Rotate the nginx logs and restart it";

/** Signed in, with one stored chat `c1` in the list, and its composer holding `TEXT`. */
async function ready() {
  const server = new FakeHermes();
  server.sessions = [row("c1", 0)];
  const hermes = await connect(server.openPipe);
  await hermes.sync();
  const storage = memoryStorage();
  const d = drafts(storage);
  const key = draftKey(nas, "default", "c1");
  d.set(key, TEXT);
  const submits = () => server.requests.filter((r) => r.method === "prompt.submit");
  /** What App does on Enter: empty the composer, send, then keep the text as the outcome says. */
  const send = async () => {
    const text = d.take(key);
    const delivery = await hermes.send("c1", text);
    d.afterSend(key, text, delivery);
    return delivery;
  };
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === "c1")!;
  return { server, hermes, storage, d, key, submits, send, chat };
}

describe("Failed-send recovery", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("an acknowledged message is let go: the composer stays empty and nothing is held", async () => {
    const { d, key, storage, submits, send } = await ready();
    expect(await send()).toEqual({ delivery: "accepted" });
    expect(submits()).toHaveLength(1);
    expect(d.get(key)).toBe("");
    expect(d.undelivered(key)).toEqual([]);
    expect(storage.items.size).toBe(0);
  });

  describe("fails before it goes out: definitely unsent", () => {
    it("while the connection is down, the text comes back into the composer", async () => {
      const { server, d, key, submits, send } = await ready();
      server.refuse = "Can't reach the Hermes dashboard: connection refused";
      server.drop();
      expect(await send()).toEqual({ delivery: "unsent", reason: "Not connected to Hermes." });
      expect(submits()).toHaveLength(0);
      expect(d.get(key)).toBe(TEXT);
      expect(d.undelivered(key)).toEqual([]);
    });

    it("when the pipe can't take the frame, nothing was sent", async () => {
      const { server, d, key, submits, send } = await ready();
      server.failSend = "The connection to Hermes is closed.";
      const delivery = await send();
      expect(delivery).toMatchObject({ delivery: "unsent" });
      expect(submits()).toHaveLength(0);
      expect(d.get(key)).toBe(TEXT);
    });

    it("when Hermes answers with an error, it didn't take the message", async () => {
      const { server, d, key, send } = await ready();
      server.handlers["prompt.submit"] = (r) => server.fail(r.id, 4009, "session busy");
      expect(await send()).toEqual({ delivery: "unsent", reason: "session busy" });
      expect(d.get(key)).toBe(TEXT);
    });

    it("keeps the text aside, not over it, when the owner typed something new meanwhile", async () => {
      const { server, hermes, d, key } = await ready();
      server.refuse = "connection refused";
      server.drop();
      const text = d.take(key);
      d.set(key, "something newer");
      d.afterSend(key, text, await hermes.send("c1", text));
      expect(d.get(key)).toBe("something newer");
      expect(d.undelivered(key)).toMatchObject([{ text: TEXT, delivery: "unsent" }]);
    });
  });

  describe("the connection drops after it went out, before Hermes answered: unknown", () => {
    /** Hermes gets the prompt and starts a tool, then the connection drops before the answer goes back. */
    async function droppedMidSend() {
      const ctx = await ready();
      ctx.server.handlers["prompt.submit"] = (r) => {
        ctx.server.event(String(r.params.session_id), "tool.start", { tool_id: "t1", name: "terminal", preview: "systemctl restart nginx" });
        ctx.server.drop("closed by the server (1006 )");
      };
      const delivery = await ctx.send();
      return { ...ctx, delivery };
    }

    it("is reported as unknown, not as a failure", async () => {
      const { delivery, submits } = await droppedMidSend();
      expect(delivery).toEqual({ delivery: "unknown", reason: expect.stringContaining("closed by the server") });
      expect(submits()).toHaveLength(1);
    });

    it("keeps the text out of the composer, held with its uncertainty, and says so in the chat", async () => {
      const { d, key, chat } = await droppedMidSend();
      expect(d.get(key)).toBe("");
      expect(d.undelivered(key)).toMatchObject([{ text: TEXT, delivery: "unknown" }]);
      expect(chat().items.at(-1)).toMatchObject({ kind: "error", text: expect.stringContaining("may already have it") });
    });

    it("still holds it after a restart", async () => {
      const { storage, key } = await droppedMidSend();
      expect(drafts(storage).undelivered(key)).toMatchObject([{ text: TEXT, delivery: "unknown" }]);
    });

    it("reconnecting sends nothing again, even when the history holds the same text", async () => {
      const { server, hermes, d, key, submits } = await droppedMidSend();
      server.transcripts.c1 = [{ role: "user", text: TEXT }];
      await hermes.reconnect();
      await hermes.open("c1");
      await vi.advanceTimersByTimeAsync(60_000);
      await hermes.idle();
      expect(hermes.getSnapshot().status).toBe("connected");
      expect(submits()).toHaveLength(1);
      // Matching text isn't proof Hermes got this send, so it stays the owner's call.
      expect(d.undelivered(key)).toMatchObject([{ text: TEXT, delivery: "unknown" }]);
    });

    it("is sent again only when the owner retries, and let go once Hermes takes it", async () => {
      const { server, hermes, d, key, submits } = await droppedMidSend();
      server.handlers["prompt.submit"] = (r) => server.respond(r.id, { status: "streaming" });
      await hermes.reconnect();
      const [held] = d.undelivered(key);

      expect(await d.retry(key, held.id, (t) => hermes.send("c1", t))).toEqual({ delivery: "accepted" });
      expect(submits()).toHaveLength(2);
      expect(submits()[1].params.text).toBe(TEXT);
      expect(d.undelivered(key)).toEqual([]);
      expect(d.get(key)).toBe("");
    });

    it("a retry that can't go out leaves it unknown, since the first send may still have landed", async () => {
      const { hermes, d, key, submits } = await droppedMidSend();
      const [held] = d.undelivered(key);
      expect(await d.retry(key, held.id, (t) => hermes.send("c1", t))).toMatchObject({ delivery: "unsent" });
      expect(submits()).toHaveLength(1);
      expect(d.undelivered(key)).toMatchObject([{ id: held.id, text: TEXT, delivery: "unknown" }]);
    });

    it("can be dismissed", async () => {
      const { storage, d, key } = await droppedMidSend();
      const [held] = d.undelivered(key);
      d.dismiss(key, held.id);
      expect(d.undelivered(key)).toEqual([]);
      expect(drafts(storage).undelivered(key)).toEqual([]);
    });
  });
});
