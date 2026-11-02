// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { localChatCache, outboxAttachmentPaths, subscribeOutbox } from "./chatCache";
import type { OutgoingItem } from "./model";

const connection = { mode: "ssh" as const, sshTarget: "test-host", url: "", username: "test-user" };
const pending = (path: string): OutgoingItem => ({
  kind: "user", id: "outgoing", text: "Explain this image",
  outgoing: { state: "failed", attachments: [{ path, name: "shot.png", kind: "image", size: 20 }] },
});
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it("protects captures across connections and profiles and drops only the dismissed reference", () => {
  const a = localChatCache(connection);
  const b = localChatCache({ ...connection, sshTarget: "other-host" });
  const changed = vi.fn();
  const stop = subscribeOutbox(changed);
  a.saveOutbox("default", "a", [pending("/captures/a.png")]);
  a.saveOutbox("work", "b", [pending("/captures/b.png")]);
  b.saveOutbox("default", "c", [pending("/captures/c.png")]);
  expect(outboxAttachmentPaths().sort()).toEqual(["/captures/a.png", "/captures/b.png", "/captures/c.png"]);
  a.saveOutbox("default", "a", []);
  expect(outboxAttachmentPaths().sort()).toEqual(["/captures/b.png", "/captures/c.png"]);
  expect(changed).toHaveBeenCalledTimes(4);
  stop();
});

it("protects a live outbox even when localStorage cannot save, then releases its references", () => {
  const cache = localChatCache(connection);
  const store = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
  cache.saveOutbox("default", "unsaved", [pending("/captures/unsaved.png")]);
  expect(outboxAttachmentPaths()).toContain("/captures/unsaved.png");
  store.mockRestore();
  cache.saveOutbox("default", "unsaved", []);
  expect(outboxAttachmentPaths()).not.toContain("/captures/unsaved.png");
});
