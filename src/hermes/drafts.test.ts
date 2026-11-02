import { describe, expect, it } from "vitest";
import type { SavedSignIn } from "./account";
import { type DraftStorage, draftKey, drafts } from "./drafts";

/** localStorage as the app sees it: it outlives a restart. `full` makes every write fail. */
function memoryStorage() {
  const items = new Map<string, string>();
  const storage = {
    items,
    full: false,
    getItem: (k: string) => items.get(k) ?? null,
    setItem(k: string, v: string) {
      if (storage.full) throw new Error("QuotaExceededError");
      items.set(k, v);
    },
    removeItem(k: string) {
      if (storage.full) throw new Error("QuotaExceededError");
      items.delete(k);
    },
  };
  return storage satisfies DraftStorage;
}

const nas: SavedSignIn = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" };
const direct: SavedSignIn = { mode: "url", sshTarget: "liam@hermes", url: "http://10.0.0.5:9119", username: "liam" };

describe("Composer drafts", () => {
  it("restores each chat's draft after a restart", () => {
    const storage = memoryStorage();
    const before = drafts(storage);
    before.set(draftKey(nas, "default", "chat-1"), "Check the backup logs and");
    before.set(draftKey(nas, "default", null), "A new idea");

    const after = drafts(storage);
    expect(after.get(draftKey(nas, "default", "chat-1"))).toBe("Check the backup logs and");
    expect(after.get(draftKey(nas, "default", null))).toBe("A new idea");
    expect(after.get(draftKey(nas, "default", "chat-2"))).toBe("");
  });

  it("keeps drafts apart per connection, profile and chat", () => {
    const d = drafts(memoryStorage());
    const keys = [
      draftKey(nas, "default", "chat-1"),
      draftKey(nas, "work", "chat-1"),
      draftKey(direct, "default", "chat-1"),
      draftKey({ ...nas, username: "admin" }, "default", "chat-1"),
      draftKey(nas, "default", "chat-2"),
      draftKey(nas, "default", null),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    keys.forEach((k, i) => d.set(k, `draft ${i}`));
    expect(keys.map((k) => d.get(k))).toEqual(keys.map((_, i) => `draft ${i}`));
  });

  it("empties the draft as its message goes, and deletes it from storage", () => {
    const storage = memoryStorage();
    const d = drafts(storage);
    const key = draftKey(nas, "default", "chat-1");
    d.set(key, "Restart nginx  ");

    expect(d.take(key)).toBe("Restart nginx  ");
    expect(d.get(key)).toBe("");
    expect(storage.items.size).toBe(0);
    expect(drafts(storage).get(key)).toBe("");
  });

  it("puts back a message Hermes didn't take, but not over something typed since", () => {
    const d = drafts(memoryStorage());
    const key = draftKey(nas, "default", "chat-1");
    d.set(key, "first");
    const sent = d.take(key);
    d.putBack(key, sent);
    expect(d.get(key)).toBe("first");

    d.take(key);
    d.set(key, "second");
    d.putBack(key, sent);
    expect(d.get(key)).toBe("second");
  });

  it("tells subscribers when a draft changes", () => {
    const d = drafts(memoryStorage());
    const key = draftKey(nas, "default", "chat-1");
    let calls = 0;
    const stop = d.subscribe(() => calls++);
    d.set(key, "a");
    d.set(key, "a");
    d.take(key);
    expect(calls).toBe(2);
    stop();
    d.set(key, "b");
    expect(calls).toBe(2);
  });

  it("keeps the text for this run when storage can't be written", () => {
    const storage = memoryStorage();
    storage.full = true;
    const d = drafts(storage);
    const key = draftKey(nas, "default", "chat-1");
    d.set(key, "still here");
    expect(d.get(key)).toBe("still here");
  });
});
