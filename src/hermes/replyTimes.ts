// Reply times (ADR 0181): how long each reply took, as this app timed it, from Hermes's `message.start` to its
// `message.complete`. Hermes stores no time per reply (its session rows keep only `started_at`, `ended_at` and
// `last_activity_at`), so only replies this app watched finish are timed. Each one shows on its reply's usage line
// (`ReplyUsage.ms`), and each finished one is kept here per profile, so Usage analytics can say how long replies take.
import type { UsageChat } from "./usageAnalytics";

/** One finished reply this app timed. `chat`: its chat's id. `at`: when it finished, Unix ms. `ms`: how long it took. */
export type ReplyTime = { chat: string; at: number; ms: number };

/** The most reply times kept per profile, the newest. */
export const REPLY_TIMES_KEPT = 1000;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The reply times in a saved list, leaving out any entry that isn't one. */
export function replyTimesOf(v: unknown): ReplyTime[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((e) => {
    const [at, ms] = [num(e?.at), num(e?.ms)];
    return typeof e?.chat === "string" && e.chat && at !== undefined && ms !== undefined ? [{ chat: e.chat, at, ms }] : [];
  });
}

/** `times` with `t` added last, keeping only the newest `REPLY_TIMES_KEPT`. */
export const withReplyTime = (times: readonly ReplyTime[], t: ReplyTime): ReplyTime[] => [...times, t].slice(-REPLY_TIMES_KEPT);

/** How long the timed replies of some chats took. `chats`: how many of the chats had a timed reply. */
export type ReplyTimeStats = { replies: number; chats: number; median: number; mean: number; longest: number };

/**
 * How long the replies in `chats` took, from the times kept for each chat's profile. A compressed chat's replies may be
 * kept under any of its segments' ids, so every segment counts. Undefined when none of them has a timed reply.
 */
export function replyTimeStats(chats: readonly Pick<UsageChat, "profile" | "segments">[], timesOf: (profile: string) => readonly ReplyTime[]): ReplyTimeStats | undefined {
  const byProfile = new Map<string, Map<string, number[]>>();
  const kept = (profile: string) => {
    let of = byProfile.get(profile);
    if (!of) {
      of = new Map();
      for (const t of timesOf(profile)) of.set(t.chat, [...(of.get(t.chat) ?? []), t.ms]);
      byProfile.set(profile, of);
    }
    return of;
  };
  const all: number[] = [];
  let timedChats = 0;
  for (const c of chats) {
    const of = kept(c.profile);
    const mine = c.segments.flatMap((s) => of.get(s.id) ?? []);
    if (mine.length) timedChats++;
    all.push(...mine);
  }
  if (!all.length) return undefined;
  const sorted = all.sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return {
    replies: sorted.length,
    chats: timedChats,
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    longest: sorted[sorted.length - 1],
  };
}
