// Reply times (ADR 0181): the times this app kept, read back safely, capped, and summed up for the chats a Usage view shows.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedSignIn } from "./account";
import { localChatCache } from "./chatCache";
import { forgetProfileLocally, renameProfileLocally } from "./profileLocalData";
import { REPLY_TIMES_KEPT, replyTimeStats, replyTimesOf, withReplyTime, type ReplyTime } from "./replyTimes";

const chat = (profile: string, ...ids: string[]) => ({ profile, ids });

describe("Reply times", () => {
  it("read back only the entries that are reply times", () => {
    expect(replyTimesOf(null)).toEqual([]);
    expect(replyTimesOf({ chat: "a" })).toEqual([]);
    expect(replyTimesOf([{ chat: "a", at: 5, ms: 900 }, { chat: "", at: 1, ms: 1 }, { chat: "b", at: 1, ms: -3 }, { chat: "c", at: "x", ms: 1 }, null])).toEqual([
      { chat: "a", at: 5, ms: 900 },
    ]);
  });

  it(`keep the newest ${REPLY_TIMES_KEPT}`, () => {
    let times: ReplyTime[] = [];
    for (let n = 0; n < REPLY_TIMES_KEPT + 5; n++) times = withReplyTime(times, { chat: "a", at: n, ms: n });
    expect(times).toHaveLength(REPLY_TIMES_KEPT);
    expect(times[0].at).toBe(5);
    expect(times.at(-1)!.at).toBe(REPLY_TIMES_KEPT + 4);
  });

  it("sum up the shown chats' replies, by profile and across a compressed chat's session ids", () => {
    const kept: Record<string, ReplyTime[]> = {
      default: [
        { chat: "a", at: 1, ms: 1000 },
        { chat: "a-tip", at: 2, ms: 3000 },
        { chat: "elsewhere", at: 3, ms: 99_000 },
      ],
      work: [
        { chat: "a", at: 4, ms: 8000 },
        { chat: "w", at: 5, ms: 4000 },
      ],
    };
    const stats = replyTimeStats([chat("default", "a", "a-tip"), chat("work", "w"), chat("work", "untimed")], (p) => kept[p] ?? []);
    expect(stats).toEqual({ replies: 3, chats: 2, median: 3000, mean: 8000 / 3, longest: 4000 });
  });

  it("take the middle two's average as the median of an even number", () => {
    const kept = [1000, 2000, 6000, 9000].map((ms, at) => ({ chat: "a", at, ms }));
    expect(replyTimeStats([chat("default", "a")], () => kept)?.median).toBe(4000);
  });

  it("are none when no shown chat has a timed reply", () => {
    expect(replyTimeStats([chat("default", "a")], () => [{ chat: "b", at: 1, ms: 1 }])).toBeUndefined();
    expect(replyTimeStats([], () => [])).toBeUndefined();
  });
});

describe("Reply times on this computer", () => {
  const nas: SavedSignIn = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" };
  afterEach(() => vi.unstubAllGlobals());
  function memoryStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    return store;
  }

  it("are kept per connection and profile, and move or go with the profile", async () => {
    memoryStorage();
    const cache = localChatCache(nas);
    cache.saveReplyTime("default", { chat: "a", at: 1, ms: 1200 });
    cache.saveReplyTime("default", { chat: "b", at: 2, ms: 800 });
    expect(localChatCache(nas).loadReplyTimes("default")).toEqual([
      { chat: "a", at: 1, ms: 1200 },
      { chat: "b", at: 2, ms: 800 },
    ]);
    expect(localChatCache(nas).loadReplyTimes("work")).toEqual([]);
    expect(localChatCache({ ...nas, sshTarget: "liam@other" }).loadReplyTimes("default")).toEqual([]);

    await renameProfileLocally(nas, "default", "home");
    expect(localChatCache(nas).loadReplyTimes("default")).toEqual([]);
    expect(localChatCache(nas).loadReplyTimes("home")).toHaveLength(2);
    await forgetProfileLocally(nas, "home");
    expect(localChatCache(nas).loadReplyTimes("home")).toEqual([]);
  });
});
