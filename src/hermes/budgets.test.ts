// Budgets (budgets.ts, ADR 0187): the windows a budget measures, what it has spent and how honestly, its forecast and
// top chats, when an alert is owed, and the saved form.
import { describe, expect, it } from "vitest";
import {
  BUDGET_NOTES,
  crossingNotice,
  draftOf,
  dueAlert,
  evaluate,
  forecastOf,
  modelKey,
  modelUsageOf,
  readPlan,
  savedOf,
  shelfFor,
  shelfOf,
  spentLabel,
  termsOf,
  windowOf,
  type Budget,
  type BudgetId,
  type BudgetReading,
  type BudgetScope,
  type FiredMark,
  type ModelRead,
  type ReadReading,
  type SpendFacts,
  type WindowKey,
} from "./budgets";
import { chatOfRow, type UsageChat } from "./usageAnalytics";

const H = 3_600_000;
const DAY = 24 * H;
const at = (iso: string) => Date.parse(iso);

let n = 0;
const budget = (scope: BudgetScope, every: "day" | "week" | "month", unit: "usd" | "tokens", amount: number, zone = "UTC"): Budget => ({
  id: `b${++n}` as BudgetId,
  scope,
  period: { every, zone },
  limit: { unit, amount },
  createdAt: 0,
});

/** A chat as `GET /api/sessions` lists it: `usd` its recorded cost, `status` Hermes's cost status. */
function chat(profile: string, id: string, started: number, tokens: number, usd: number | null, more: { status?: string; model?: string; lineage?: string[] } = {}): UsageChat {
  const row = {
    id,
    title: `Chat ${id}`,
    source: "cli",
    started_at: started / 1000,
    model: more.model ?? "gpt-5",
    input_tokens: tokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    api_call_count: 1,
    cost_status: more.status ?? "estimated",
    estimated_cost_usd: usd,
    actual_cost_usd: null,
    ...(more.lineage && { _lineage_ids: more.lineage }),
  };
  return chatOfRow(profile, row, started)!.chat;
}

const facts = (chats: UsageChat[], more: Partial<SpendFacts> = {}): SpendFacts => ({
  from: 0,
  readAt: 0,
  profiles: ["default", "ops"],
  reads: [
    { profile: "default", state: "ok", read: chats.length },
    { profile: "ops", state: "ok", read: chats.length },
  ],
  chats,
  models: new Map(),
  projectChats: () => undefined,
  ...more,
});

const read = (r: BudgetReading): ReadReading => {
  if (r.state !== "read") throw new Error(`unreadable: ${JSON.stringify(r.why)}`);
  return r;
};

describe("windowOf", () => {
  const profile: BudgetScope = { kind: "profile", profile: "ops" };

  it("is the calendar day on the budget's clock, 23 hours long the day clocks go forward", () => {
    const w = windowOf(budget(profile, "day", "usd", 5, "Europe/London"), at("2026-03-29T12:00:00Z"));
    expect(w).toMatchObject({ kind: "calendar", key: "day:2026-03-29", from: at("2026-03-29T00:00:00Z"), to: at("2026-03-29T23:00:00Z") });
  });

  it("starts a week on Monday, whatever day it is, and across a year's end", () => {
    const sunday = windowOf(budget(profile, "week", "usd", 5), at("2027-01-03T20:00:00Z"));
    expect(sunday).toMatchObject({ key: "week:2026-12-28", from: at("2026-12-28T00:00:00Z"), to: at("2027-01-04T00:00:00Z") });
    const monday = windowOf(budget(profile, "week", "usd", 5), at("2026-11-16T00:00:00Z"));
    expect(monday.key).toBe("week:2026-11-16");
  });

  it("is the calendar month, on the zone's clock rather than UTC's", () => {
    // 03:00 UTC on 1 December is still 30 November in Chicago.
    const w = windowOf(budget(profile, "month", "usd", 5, "America/Chicago"), at("2026-12-01T03:00:00Z"));
    expect(w).toMatchObject({ key: "month:2026-11", from: at("2026-11-01T05:00:00Z"), to: at("2026-12-01T06:00:00Z") });
  });

  it("is the last 24 hours, 7 or 30 days for a model, keyed by the calendar period for alerts", () => {
    const now = at("2026-11-18T10:00:00Z");
    const w = windowOf(budget({ kind: "model", model: "gpt-5" }, "week", "usd", 5), now);
    expect(w).toMatchObject({ kind: "rolling", days: 7, from: now - 7 * DAY, key: "week:2026-11-16" });
  });
});

describe("readPlan", () => {
  it("reads nothing without budgets, and once from the earliest window for all of them", () => {
    const now = at("2026-11-18T10:00:00Z");
    expect(readPlan([], now)).toBeUndefined();
    const plan = readPlan([budget({ kind: "profile", profile: "ops" }, "day", "usd", 1), budget({ kind: "project", profile: "astra", project: "p" }, "month", "usd", 1)], now);
    expect(plan).toEqual({ from: at("2026-11-01T00:00:00Z"), profiles: ["ops", "astra"], modelDays: [] });
    expect(readPlan([budget({ kind: "model", model: "m" }, "week", "tokens", 1)], now)).toMatchObject({ profiles: "all", modelDays: [7] });
  });
});

describe("evaluate", () => {
  const now = at("2026-11-18T12:00:00Z");
  const today = at("2026-11-18T01:00:00Z");

  it("adds up a profile's chats started in the window, and lists them most first", () => {
    const chats = [
      chat("ops", "a", today, 1000, 1.5),
      chat("ops", "b", today + H, 2000, 3),
      chat("ops", "old", at("2026-11-17T23:00:00Z"), 9000, 9),
      chat("default", "other", today, 5000, 5),
    ];
    const r = read(evaluate([budget({ kind: "profile", profile: "ops" }, "day", "usd", 5)], facts(chats), now)[0]);
    expect(r.spent).toMatchObject({ counted: 4.5, share: 0.9, tokens: 3000 });
    expect(r.level).toBe(80);
    expect(r.top.basis).toBe("exact");
    expect(r.top.chats.map((t) => [t.chat.id, t.share])).toEqual([
      ["b", 3 / 4.5],
      ["a", 1.5 / 4.5],
    ]);
  });

  it("counts a server budget across every profile, and a project's by this computer's membership", () => {
    const chats = [chat("ops", "a", today, 1000, 1), chat("default", "b", today, 1000, 2), chat("ops", "c", today, 1000, 4)];
    const [server, project] = evaluate(
      [budget({ kind: "server" }, "day", "usd", 10), budget({ kind: "project", profile: "ops", project: "p1" }, "day", "usd", 10)],
      facts(chats, { projectChats: (p, id) => (p === "ops" && id === "p1" ? new Set(["c"]) : undefined) }),
      now,
    );
    expect(read(server).spent.counted).toBe(7);
    expect(read(project).spent.counted).toBe(4);
  });

  it("has no figure for a project that's gone, or when every profile in scope failed", () => {
    const [project] = evaluate([budget({ kind: "project", profile: "ops", project: "gone" }, "day", "usd", 1)], facts([]), now);
    const [failed] = evaluate([budget({ kind: "profile", profile: "ops" }, "day", "usd", 1)], facts([], { reads: [{ profile: "ops", state: "failed", read: 0, error: "HTTP 500" }] }), now);
    expect(project).toMatchObject({ state: "unreadable", why: { kind: "project-gone" } });
    expect(failed).toMatchObject({ state: "unreadable", why: { kind: "profile-failed", error: "HTTP 500" } });
  });

  it("says a server budget is short when one profile failed, and the unpriced tokens it counts as $0", () => {
    const chats = [chat("default", "a", today, 1000, 2), chat("default", "free", today, 7000, null, { status: "unknown" })];
    const r = read(
      evaluate(
        [budget({ kind: "server" }, "day", "usd", 10)],
        facts(chats, {
          reads: [
            { profile: "default", state: "ok", read: 2 },
            { profile: "ops", state: "failed", read: 0, error: "timed out" },
          ],
        }),
        now,
      )[0],
    );
    expect(r.spent.counted).toBe(2);
    expect(r.spent.tokens).toBe(8000);
    expect(r.spent.gaps).toEqual([{ kind: "profile-failed", profile: "ops", error: "timed out" }, { kind: "unpriced", tokens: 7000 }, { kind: "estimated" }]);
    expect(spentLabel(r.spent, r.budget.limit).short).toBe("~$2.00+ of $10.00");
    // The unpriced chat still shows, by its tokens.
    expect(r.top.chats.map((t) => t.chat.id)).toEqual(["a", "free"]);
  });

  it("counts tokens for a token budget, priced or not", () => {
    const chats = [chat("ops", "a", today, 400_000, null, { status: "unknown" }), chat("ops", "b", today, 500_000, 1)];
    const r = read(evaluate([budget({ kind: "profile", profile: "ops" }, "day", "tokens", 1_000_000)], facts(chats), now)[0]);
    expect(r.spent).toMatchObject({ counted: 900_000, gaps: [] });
    expect(r.level).toBe(80);
    expect(spentLabel(r.spent, r.budget.limit).short).toBe("900k tokens of 1M tokens");
  });

  it("takes a model budget from Hermes's per-model sums in every profile, and its top chats by last model", () => {
    const rows = (usd: number, tokens: number): ModelRead => ({ state: "ok", rows: [{ model: "gpt-5", provider: "openai", input: tokens, output: 0, cacheRead: 0, estimatedUsd: usd, sessions: 1 }] });
    const models = new Map<string, ModelRead>([
      [modelKey("default", 1), rows(2, 100)],
      [modelKey("ops", 1), rows(1, 50)],
    ]);
    const chats = [chat("ops", "a", now - 2 * H, 50, 1), chat("ops", "b", now - 2 * H, 50, 1, { model: "other" })];
    const r = read(evaluate([budget({ kind: "model", model: "gpt-5" }, "day", "usd", 6)], facts(chats, { models }), now)[0]);
    expect(r.spent).toMatchObject({ counted: 3, tokens: 150, gaps: [{ kind: "model-sums" }] });
    expect(r.forecast).toEqual({ kind: "none", why: "rolling" });
    expect(r.top).toMatchObject({ basis: "last-model", more: 0 });
    expect(r.top.chats.map((t) => t.chat.id)).toEqual(["a"]);
  });

  it("has no model figure on a Hermes without the per-model route", () => {
    const models = new Map<string, ModelRead>([
      [modelKey("default", 7), { state: "unsupported" }],
      [modelKey("ops", 7), { state: "unsupported" }],
    ]);
    expect(evaluate([budget({ kind: "model", model: "m" }, "week", "usd", 1)], facts([], { models }), now)[0]).toMatchObject({
      state: "unreadable",
      why: { kind: "models-unsupported" },
    });
  });
});

describe("forecastOf", () => {
  const b = budget({ kind: "profile", profile: "ops" }, "day", "usd", 10);
  const w = windowOf(b, at("2026-11-18T06:00:00Z"));
  const spent = (counted: number, short = false) => ({ unit: "usd" as const, counted, share: counted / 10, tokens: 0, gaps: short ? [{ kind: "segments-unread" as const, chats: 1 }] : [] });

  it("stretches the spending so far over the whole window at its pace, and says when it reaches the limit", () => {
    // A quarter of the day gone, $3 spent: $12 by midnight, $10 at 20:00.
    expect(forecastOf(spent(3, true), b.limit, w, at("2026-11-18T06:00:00Z"))).toEqual({ kind: "projected", total: 12, share: 1.2, atLeast: true, reachesAt: at("2026-11-18T20:00:00Z") });
    expect(forecastOf(spent(1), b.limit, w, at("2026-11-18T06:00:00Z"))).toEqual({ kind: "projected", total: 4, share: 0.4, atLeast: false });
  });

  it("refuses too early in the window and when nothing is spent, and says when the limit is already reached", () => {
    expect(forecastOf(spent(1), b.limit, w, at("2026-11-18T01:00:00Z"))).toEqual({ kind: "none", why: "too-early", from: at("2026-11-18T02:00:00Z") });
    expect(forecastOf(spent(0), b.limit, w, at("2026-11-18T06:00:00Z"))).toEqual({ kind: "none", why: "nothing-spent" });
    expect(forecastOf(spent(10), b.limit, w, at("2026-11-18T06:00:00Z"))).toMatchObject({ kind: "over", total: 40 });
  });
});

describe("dueAlert", () => {
  const now = at("2026-11-18T12:00:00Z");
  const b = budget({ kind: "profile", profile: "ops" }, "day", "usd", 10);
  const at$ = (usd: number) => evaluate([b], facts([chat("ops", "a", at("2026-11-18T01:00:00Z"), 10, usd)]), now)[0];

  it("is owed at 50, 80 and 100%, once each, and only the highest when it passes two at once", () => {
    const fifty = dueAlert(at$(5), undefined)!;
    expect(fifty.threshold).toBe(50);
    expect(dueAlert(at$(6), fifty.mark)).toBeUndefined();
    const eighty = dueAlert(at$(8.5), fifty.mark)!;
    expect(eighty.threshold).toBe(80);
    expect(dueAlert(at$(12), undefined)?.threshold).toBe(100);
    expect(dueAlert(at$(12), dueAlert(at$(12), eighty.mark)!.mark)).toBeUndefined();
    expect(dueAlert(at$(4), undefined)).toBeUndefined();
  });

  it("is owed again in a new period, or after the limit changed, and never for a reading without a figure", () => {
    const mark: FiredMark = { window: "day:2026-11-17" as WindowKey, terms: termsOf(b), fired: 100 };
    expect(dueAlert(at$(6), mark)?.threshold).toBe(50);
    expect(dueAlert(at$(6), { ...mark, window: "day:2026-11-18" as WindowKey, terms: "day UTC usd 20" })?.threshold).toBe(50);
    const gone = evaluate([budget({ kind: "project", profile: "ops", project: "x" }, "day", "usd", 1)], facts([]), now)[0];
    expect(dueAlert(gone, undefined)).toBeUndefined();
  });

  it("names the scope and the figure, never a chat", () => {
    const c = dueAlert(at$(8.5), undefined)!;
    expect(crossingNotice(c, () => undefined)).toEqual({ title: "Budget at 80%", body: "Profile ops has used about $8.50 of $10.00 today." });
    expect(JSON.stringify(crossingNotice(c, () => undefined))).not.toContain("Chat a");
  });
});

describe("draftOf", () => {
  const form = { scope: { kind: "server" } as BudgetScope, every: "week" as const, zone: "UTC", unit: "usd" as const, amount: "$1,250.50" };

  it("reads amounts as the owner types them, k and M for tokens", () => {
    expect(draftOf(form)).toEqual({ scope: { kind: "server" }, period: { every: "week", zone: "UTC" }, limit: { unit: "usd", amount: 1250.5 } });
    expect(draftOf({ ...form, unit: "tokens", amount: "2.5M" })).toMatchObject({ limit: { unit: "tokens", amount: 2_500_000 } });
  });

  it("refuses an amount that isn't above zero, and a scope without its name", () => {
    expect(draftOf({ ...form, amount: "0" })).toHaveProperty("error");
    expect(draftOf({ ...form, amount: "5k" })).toHaveProperty("error");
    expect(draftOf({ ...form, scope: { kind: "model", model: " " } })).toEqual({ error: "Pick a model." });
  });
});

describe("the saved form", () => {
  it("files a profile's budget on its shelf without its name, and reads it back under the name it is filed by", () => {
    const b = budget({ kind: "project", profile: "ops", project: "p1" }, "month", "tokens", 5e6);
    expect(shelfFor(b.scope)).toEqual({ profile: "ops" });
    const saved = { budgets: [savedOf(b)], fired: { [b.id]: { window: "month:2026-11", terms: termsOf(b), fired: 80 } } };
    expect(JSON.stringify(saved)).not.toContain('"ops"');
    // As after a rename moved the shelf: the budget comes back under the new name.
    const back = shelfOf(JSON.parse(JSON.stringify(saved)), { profile: "astra" });
    expect(back.budgets).toEqual([{ ...b, scope: { kind: "project", profile: "astra", project: "p1" } }]);
    expect(back.fired[b.id].fired).toBe(80);
  });

  it("drops what isn't a budget, or is on the wrong shelf, and says how many", () => {
    const server = savedOf(budget({ kind: "server" }, "day", "usd", 1));
    const raw = { budgets: [server, { ...server, id: "x", limit: { unit: "usd", amount: -1 } }, { ...server, id: "y", period: { every: "day", zone: "Mars/Base" } }], fired: { gone: {} } };
    expect(shelfOf(raw, "connection")).toMatchObject({ budgets: [{ id: server.id }], fired: {}, dropped: 2 });
    expect(shelfOf(raw, { profile: "ops" }).budgets).toEqual([]);
  });
});

describe("modelUsageOf", () => {
  it("reads Hermes's per-model rows, its estimate as the dollars", () => {
    const answer = { models: [{ model: "gpt-5", provider: "openai", input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, estimated_cost: 0.5, actual_cost: 0.4, sessions: 3 }, { provider: "x" }], totals: {} };
    expect(modelUsageOf(answer)).toEqual([{ model: "gpt-5", provider: "openai", input: 10, output: 5, cacheRead: 2, estimatedUsd: 0.5, sessions: 3 }]);
    expect(modelUsageOf({ detail: "Not Found" })).toBeUndefined();
  });
});

it("says the four things the issue asks the tab to say plainly", () => {
  expect(BUDGET_NOTES.join(" ")).toMatch(/only while it is running and connected.*day it started.*\$0.*lower bound/s);
});
