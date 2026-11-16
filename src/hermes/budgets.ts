// Budgets (#605, GLOSSARY.md "Budget", ADR 0190): a limit on what a server, a profile, a project or a model may spend
// per day, week or month, in dollars or tokens, kept on this computer per connection. This module is pure: no
// storage, no Hermes, no timers. Everything is a function of the budgets, the facts one check read, and `now`.
//
// Reading order: Budget (what the owner set) → BudgetWindow (the time it measures now) → SpendFacts (what was read)
// → BudgetReading (spent, forecast, top chats, level) → Crossing (an alert that is due, given what already fired).
//
// Spent comes from the stored chat totals Usage analytics adds up (usageAnalytics.ts, ADR 0026); a model budget's
// from Hermes's per-model sums (`GET /api/analytics/models`), which count each call under the model that made it.
// Nothing is multiplied by a price (ADR 0008).
import { knownZone } from "./schedule";
import { tokens as shortTokens, usd } from "./usage";
import {
  chatTotalShort,
  dayIn,
  dayStart,
  nextDate,
  recordedUsd,
  tallyCost,
  totalOf,
  type CostTally,
  type ProfileRead,
  type UsageChat,
} from "./usageAnalytics";
import { isObj } from "./values";

const DAY = 86_400_000;

// --- What the owner sets ------------------------------------------------------------------------------------------

export type BudgetId = string & { readonly __budget: unique symbol };

/** Scopes measured from chat rows: exact for a calendar window, and they name the chats behind the figure. */
export type ChatScope =
  | { kind: "server" } // every profile of the connection, as listed at each check
  | { kind: "profile"; profile: string }
  | { kind: "project"; profile: string; project: string }; // a project belongs to one profile (ADR 0131)

/** Measured from `GET /api/analytics/models`, every profile added up: each call under the model that made it. */
export type ModelScope = { kind: "model"; model: string };

export type BudgetScope = ChatScope | ModelScope;

export const EVERY = ["day", "week", "month"] as const;
export type Every = (typeof EVERY)[number];

/**
 * How often a budget starts again, and the clock it runs on. `zone` is fixed when the budget is made (this computer's
 * zone then), so a laptop that travels doesn't move a stored budget's periods or re-fire its alerts. A week starts on
 * Monday.
 */
export type BudgetPeriod = { every: Every; zone: string };

export const UNITS = ["usd", "tokens"] as const;
/** `amount` is finite and above zero: `draftOf` and `shelfOf` refuse anything else, so nothing divides by zero. */
export type Limit = { unit: (typeof UNITS)[number]; amount: number };

/**
 * A budget. Its scope never changes (a budget for another scope is another budget); its period and limit are its
 * terms, and editing them re-arms its alerts (`termsOf`). The scope decides what `period` means: a chat scope counts
 * the chats started this calendar day, week or month; a model scope counts the last 24 hours, 7 days or 30 days,
 * because Hermes's per-model sums only reach whole days back from now (`windowOf`).
 */
export type Budget = { id: BudgetId; scope: BudgetScope; period: BudgetPeriod; limit: Limit; createdAt: number };

/** What the form hands over. `draftOf` is the only way to make one, so a saved budget is always valid. */
export type BudgetDraft = Pick<Budget, "scope" | "period" | "limit"> & { id?: BudgetId };

/** A number the owner typed: digits with optional separators, `$`, and a `k` or `M` for tokens. */
function amountOf(text: string, unit: Limit["unit"]): number | undefined {
  const m = /^\$?\s*([\d,_ ]*\.?\d+)\s*([kKmM]?)$/.exec(text.trim());
  if (!m || (m[2] && unit === "usd")) return undefined;
  const n = Number(m[1].replace(/[,_ ]/g, "")) * (m[2] ? (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function draftOf(form: { scope: BudgetScope; every: Every; zone: string; unit: Limit["unit"]; amount: string; id?: BudgetId }): BudgetDraft | { error: string } {
  const { scope } = form;
  if ((scope.kind === "profile" || scope.kind === "project") && !scope.profile.trim()) return { error: "Pick a profile." };
  if (scope.kind === "project" && !scope.project) return { error: "Pick a project." };
  if (scope.kind === "model" && !scope.model.trim()) return { error: "Pick a model." };
  if (!knownZone(form.zone)) return { error: "This computer's time zone isn't one the app knows." };
  const amount = amountOf(form.amount, form.unit);
  if (amount === undefined) return { error: form.unit === "usd" ? "Type a dollar amount above zero." : "Type a number of tokens above zero, such as 500k or 2M." };
  return {
    scope: scope.kind === "model" ? { kind: "model", model: scope.model.trim() } : scope,
    period: { every: form.every, zone: form.zone },
    limit: { unit: form.unit, amount: form.unit === "tokens" ? Math.round(amount) : amount },
    ...(form.id && { id: form.id }),
  };
}

// --- Period → window ----------------------------------------------------------------------------------------------

/** Names one calendar day, week or month on a budget's clock: `day:2026-11-16`, `week:2026-11-16` (its Monday), `month:2026-11`. */
export type WindowKey = string & { readonly __window: unique symbol };

/**
 * The time a budget measures at `now`. The kind follows the scope, never the caller:
 * - `calendar` (chat scopes): from the start of today, this week or this month on the budget's clock to the start of
 *   the next, DST-aware (`dayStart`), so a 23- or 25-hour day is the day it is.
 * - `rolling` (model scope): the last 1, 7 or 30 × 24 hours, which is how Hermes's per-model sums cut (`started_at >
 *   now − days·86400`). The tab says "last 7 days", not "this week".
 * `key` is the calendar day, week or month `now` is in for both kinds: alerts are counted against it, so a rolling
 * budget still over a threshold is announced again once each new period.
 */
export type BudgetWindow =
  | { kind: "calendar"; every: Every; key: WindowKey; from: number; to: number }
  | { kind: "rolling"; every: Every; key: WindowKey; days: RollingDays; from: number; to: number };

export type RollingDays = 1 | 7 | 30;
export const ROLLING_DAYS: Record<Every, RollingDays> = { day: 1, week: 7, month: 30 };

/** A date `n` days after `date` (both `yyyy-mm-dd`). */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The instant `date` starts on `zone`'s clock; UTC's for a zone the app doesn't know (stored budgets are checked). */
const startOf = (date: string, zone: string) => dayStart(date, zone) ?? dayStart(date, "UTC")!;

/** The calendar day, week or month `now` is in, on `zone`'s clock. */
function calendarOf(every: Every, zone: string, now: number): { key: WindowKey; from: number; to: number } {
  const today = dayIn(zone, now);
  if (every === "day") return { key: `day:${today}` as WindowKey, from: startOf(today, zone), to: startOf(nextDate(today), zone) };
  if (every === "week") {
    const [y, m, d] = today.split("-").map(Number);
    const monday = addDays(today, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
    return { key: `week:${monday}` as WindowKey, from: startOf(monday, zone), to: startOf(addDays(monday, 7), zone) };
  }
  const first = `${today.slice(0, 7)}-01`;
  const [y, m] = first.split("-").map(Number);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { key: `month:${today.slice(0, 7)}` as WindowKey, from: startOf(first, zone), to: startOf(next, zone) };
}

export function windowOf(budget: Pick<Budget, "scope" | "period">, now: number): BudgetWindow {
  const { every, zone } = budget.period;
  const cal = calendarOf(every, zone, now);
  if (budget.scope.kind !== "model") return { kind: "calendar", every, ...cal };
  const days = ROLLING_DAYS[every];
  return { kind: "rolling", every, key: cal.key, days, from: now - days * DAY, to: now + 1 };
}

/**
 * What one check must read for `budgets` at `now`: the earliest instant any window starts at, the profiles whose
 * chats to read (`all` when a server or model budget is among them), and the day counts to ask the models route for.
 * Undefined with no budgets: then nothing is read at all.
 */
export type ReadPlan = { from: number; profiles: "all" | string[]; modelDays: RollingDays[] };

export function readPlan(budgets: readonly Budget[], now: number): ReadPlan | undefined {
  if (!budgets.length) return undefined;
  const windows = budgets.map((b) => windowOf(b, now));
  const all = budgets.some((b) => b.scope.kind === "server" || b.scope.kind === "model");
  const named = [...new Set(budgets.flatMap((b) => (b.scope.kind === "profile" || b.scope.kind === "project" ? [b.scope.profile] : [])))];
  const modelDays = [...new Set(windows.flatMap((w) => (w.kind === "rolling" ? [w.days] : [])))].sort((a, b) => a - b);
  return { from: Math.min(...windows.map((w) => w.from)), profiles: all ? "all" : named, modelDays };
}

// --- What was read ------------------------------------------------------------------------------------------------

/** One `/api/analytics/models` row, parsed (`modelUsageOf`). No cache-write count: Hermes sends none. */
export type ModelUsage = { model: string; provider: string; input: number; output: number; cacheRead: number; estimatedUsd: number; sessions: number };

/** How one profile's per-model sums came back for one day count. */
export type ModelRead = { state: "ok"; rows: readonly ModelUsage[] } | { state: "unsupported" } | { state: "failed"; error: string };

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * The rows of a `GET /api/analytics/models` answer, or undefined for an answer of another shape. `estimated_cost`
 * sums every call Hermes priced, the provider's own figures included (`actual_cost` is the provider's part of it,
 * usage.ts `costOf`), so it is the dollars. Unpriced calls add $0, with no flag.
 */
export function modelUsageOf(v: unknown): ModelUsage[] | undefined {
  if (!isObj(v) || !Array.isArray(v.models)) return undefined;
  return v.models.flatMap((r): ModelUsage[] =>
    isObj(r) && typeof r.model === "string" && r.model
      ? [
          {
            model: r.model,
            provider: typeof r.provider === "string" ? r.provider : "",
            input: count(r.input_tokens),
            output: count(r.output_tokens),
            cacheRead: count(r.cache_read_tokens),
            estimatedUsd: count(r.estimated_cost),
            sessions: count(r.sessions),
          },
        ]
      : [],
  );
}

/**
 * Everything one check read. Built only by the watch (budgetWatch.ts); `evaluate` trusts it. `profiles`: every profile
 * of the connection, as listed. `chats`: every chat started at or after `from` in the profiles read, once each.
 * `models`: `modelKey(profile, days)` → that read.
 */
export type SpendFacts = {
  from: number;
  readAt: number;
  profiles: readonly string[];
  reads: readonly ProfileRead[];
  chats: readonly UsageChat[];
  models: ReadonlyMap<string, ModelRead>;
  /** The chat ids filed in a project of a profile, as this computer keeps them (ADR 0131); undefined when it's gone. */
  projectChats: (profile: string, project: string) => ReadonlySet<string> | undefined;
};

export const modelKey = (profile: string, days: RollingDays) => `${profile}\n${days}`;

// --- Spent: an amount that carries its honesty -------------------------------------------------------------------

/** One reason the counted amount is short of, or not exactly, the truth. The tab says each one in words. */
export type Gap =
  | { kind: "profile-failed"; profile: string; error: string } // none of its chats are counted
  | { kind: "profile-capped"; profile: string } // past 5,000 chats: the window's oldest aren't counted
  | { kind: "segments-unread"; chats: number } // compressed chats short of a segment
  | { kind: "unpriced"; tokens: number } // dollars: Hermes recorded no cost, so they count as $0
  | { kind: "partly-priced"; chats: number } // dollars: the latest call couldn't be priced
  | { kind: "estimated" } // dollars: some of it is Hermes's estimate, not the provider's figure
  | { kind: "tokens-unreported"; chats: number } // tokens: a count Hermes didn't send
  | { kind: "model-sums" }; // model scope: Hermes's per-model sums, with no cost status, no cache writes, helper tasks and subagent runs included

/** Gaps that make the true figure higher than the counted one. `estimated` and `model-sums` only make it inexact. */
const SHORT: ReadonlySet<Gap["kind"]> = new Set(["profile-failed", "profile-capped", "segments-unread", "unpriced", "partly-priced", "tokens-unreported"]);
export const isShort = (gaps: readonly Gap[]) => gaps.some((g) => SHORT.has(g.kind));

/**
 * What a budget has spent in its window. `counted`, in the limit's unit, is what the limit is compared with; it is a
 * lower bound of the provider's bill, short by `gaps`. `tokens` is always filled, so a dollar budget on a model Hermes
 * can't price still shows its usage (and the tab offers a token budget when `gaps` has `unpriced`). The tab draws a
 * Spent through `spentLabel`, never from `counted` alone.
 */
export type Spent = {
  unit: Limit["unit"];
  counted: number;
  /** counted / limit, not capped (1.3 is 130%). */
  share: number;
  tokens: number;
  /** Chat scopes: the cost by how Hermes got it (usageAnalytics.ts `tallyCost`). */
  cost?: CostTally;
  gaps: readonly Gap[];
};

/** An amount in a limit's unit, in a few characters. */
export const amountLabel = (n: number, unit: Limit["unit"]) => (unit === "usd" ? usd(n) : `${shortTokens(Math.round(n))} tokens`);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function gapText(g: Gap): string {
  switch (g.kind) {
    case "profile-failed":
      return `The ${g.profile} profile couldn't be read, so none of its chats are counted: ${g.error}`;
    case "profile-capped":
      return `The ${g.profile} profile has more chats than the app reads at once (5,000), so the oldest of this period aren't counted.`;
    case "segments-unread":
      return `${plural(g.chats, "chat")} Hermes compressed couldn't be read in full, so ${g.chats === 1 ? "it counts" : "they count"} short.`;
    case "unpriced":
      return `Hermes had no price for ${shortTokens(g.tokens)} tokens, so they count as $0 here. A token budget would count them.`;
    case "partly-priced":
      return `${plural(g.chats, "chat")} had a call Hermes couldn't price, so ${g.chats === 1 ? "it cost" : "they cost"} at least what is shown.`;
    case "estimated":
      return "Part of it is Hermes's own estimate, so the provider's bill may differ.";
    case "tokens-unreported":
      return `Hermes didn't send every token count for ${plural(g.chats, "chat")}, so ${g.chats === 1 ? "it counts" : "they count"} short.`;
    case "model-sums":
      return "From Hermes's per-model sums: they include helper tasks and subagent runs, have no cache writes, and count a model Hermes can't price as $0.";
  }
}

/** `~$4.20+ of $10.00`, with `tallyLabel`'s `~` (some of it estimated) and `+` (the truth is higher), and every gap in a sentence. */
export function spentLabel(spent: Spent, limit: Limit): { short: string; detail: string[] } {
  const approx = spent.gaps.some((g) => g.kind === "estimated") ? "~" : "";
  const plus = isShort(spent.gaps) ? "+" : "";
  return { short: `${approx}${amountLabel(spent.counted, spent.unit)}${plus} of ${amountLabel(limit.amount, limit.unit)}`, detail: spent.gaps.map(gapText) };
}

// --- Forecast -----------------------------------------------------------------------------------------------------

/**
 * Where a calendar window's spending is heading: what was counted so far, stretched over the whole window at the
 * pace since it opened (`counted / elapsed share`). That is the only pace Hermes's figures support: a chat's whole cost
 * counts at the instant it started, so a "last few hours" rate would miss an older chat that is spending now.
 * `atLeast` carries the spent figure's shortness through. It refuses rather than guess: `too-early` before
 * `MIN_ELAPSED` of the window has passed, `rolling` for a model budget (its window has no end to project to), and
 * `nothing-spent`. `over`: the limit is already reached; `total` is still the projection.
 */
export type Forecast =
  | { kind: "projected"; total: number; share: number; atLeast: boolean; /** When the limit is reached at this pace, within the window. */ reachesAt?: number }
  | { kind: "over"; total: number; share: number; atLeast: boolean }
  | { kind: "none"; why: "too-early" | "rolling" | "nothing-spent"; /** `too-early`: when one starts. */ from?: number };

/** day: 2 h, week: 12 h, month: 2 days. */
export const MIN_ELAPSED: Record<Every, number> = { day: 2 * 3_600_000, week: 12 * 3_600_000, month: 2 * DAY };

export function forecastOf(spent: Spent, limit: Limit, window: BudgetWindow, now: number): Forecast {
  if (window.kind === "rolling") return { kind: "none", why: "rolling" };
  const elapsed = now - window.from;
  if (elapsed < MIN_ELAPSED[window.every]) return { kind: "none", why: "too-early", from: window.from + MIN_ELAPSED[window.every] };
  if (spent.counted <= 0) return { kind: "none", why: "nothing-spent" };
  const total = (spent.counted * (window.to - window.from)) / elapsed;
  const atLeast = isShort(spent.gaps);
  const share = total / limit.amount;
  if (spent.counted >= limit.amount) return { kind: "over", total, share, atLeast };
  const reachesAt = window.from + (limit.amount / spent.counted) * elapsed;
  return { kind: "projected", total, share, atLeast, ...(reachesAt < window.to && { reachesAt }) };
}

// --- Top chats ----------------------------------------------------------------------------------------------------

export type TopChat = { chat: UsageChat; counted: number; /** Of the budget's counted amount; 0 when it counted nothing. */ share: number };

/**
 * The chats behind a budget, most first in the budget's unit (then by tokens), sorted here: no Hermes read sorts by
 * cost. `exact`: these chats are what was counted. `last-model` (model scope): chat rows name only a chat's last model,
 * so these are the window's chats that ended on it; one that switched may be missing or shown whole. The tab says so.
 */
export type TopChats = { basis: "exact" | "last-model"; chats: readonly TopChat[]; /** Chats with usage not listed. */ more: number };
export const TOP_CHATS = 5;

const chatAmount = (c: UsageChat, unit: Limit["unit"]) => (unit === "usd" ? recordedUsd(tallyCost([c])) : totalOf(c.counts));

function topOf(chats: readonly UsageChat[], unit: Limit["unit"], counted: number, basis: TopChats["basis"]): TopChats {
  const ranked = chats
    .map((chat) => ({ chat, counted: chatAmount(chat, unit), tokens: totalOf(chat.counts) }))
    .filter((t) => t.counted > 0 || t.tokens > 0)
    .sort((a, b) => b.counted - a.counted || b.tokens - a.tokens || b.chat.startedAt - a.chat.startedAt);
  return {
    basis,
    chats: ranked.slice(0, TOP_CHATS).map(({ chat, counted: n }) => ({ chat, counted: n, share: counted > 0 ? n / counted : 0 })),
    more: Math.max(0, ranked.length - TOP_CHATS),
  };
}

// --- A budget, evaluated ------------------------------------------------------------------------------------------

export const THRESHOLDS = [50, 80, 100] as const;
export type Threshold = (typeof THRESHOLDS)[number];

/** Why a budget has no figure at all. */
export type Unreadable = { kind: "profile-failed"; error: string } | { kind: "models-unsupported" } | { kind: "models-failed"; error: string } | { kind: "project-gone" };

/**
 * One budget at one instant. `unreadable`: nothing to stand on (every profile in scope failed, the models route is
 * missing, the project is gone), so no figure is shown and no alert can come of it. A figure with gaps is `read`: it
 * is a lower bound, and a lower bound past a threshold is truly past it.
 */
export type BudgetReading =
  | { state: "read"; budget: Budget; window: BudgetWindow; spent: Spent; forecast: Forecast; top: TopChats; level?: Threshold }
  | { state: "unreadable"; budget: Budget; window: BudgetWindow; why: Unreadable };

export type ReadReading = Extract<BudgetReading, { state: "read" }>;

/** The highest threshold `counted` has reached against `limit`. */
function levelOf(counted: number, limit: Limit): Threshold | undefined {
  return [...THRESHOLDS].reverse().find((t) => counted * 100 >= limit.amount * t);
}

const inWindow = (c: UsageChat, w: BudgetWindow) => c.startedAt >= w.from && c.startedAt < w.to;

/** The gaps the reads of `profiles` leave, or why there is no figure: every one of them failed. */
function readGaps(facts: SpendFacts, profiles: readonly string[]): Gap[] | Unreadable {
  const reads = profiles.map((p) => facts.reads.find((r) => r.profile === p));
  const failed = reads.filter((r): r is ProfileRead => r?.state === "failed");
  if (profiles.length && failed.length === profiles.length) return { kind: "profile-failed", error: failed[0].error ?? "It couldn't be read." };
  return reads.flatMap((r): Gap[] =>
    r?.state === "failed" ? [{ kind: "profile-failed", profile: r.profile, error: r.error ?? "It couldn't be read." }] : r?.state === "capped" ? [{ kind: "profile-capped", profile: r.profile }] : [],
  );
}

function chatReading(budget: Budget & { scope: ChatScope }, w: BudgetWindow, facts: SpendFacts, now: number): BudgetReading {
  const { scope, limit } = budget;
  const profiles = scope.kind === "server" ? facts.profiles : [scope.profile];
  const gapsOrWhy = readGaps(facts, profiles);
  if (!Array.isArray(gapsOrWhy)) return { state: "unreadable", budget, window: w, why: gapsOrWhy };
  let member: ((c: UsageChat) => boolean) | undefined;
  if (scope.kind === "project") {
    const ids = facts.projectChats(scope.profile, scope.project);
    if (!ids) return { state: "unreadable", budget, window: w, why: { kind: "project-gone" } };
    member = (c) => c.ids.some((id) => ids.has(id));
  }
  const chats = facts.chats.filter((c) => profiles.includes(c.profile) && inWindow(c, w) && (!member || member(c)));
  const tokens = chats.reduce((n, c) => n + totalOf(c.counts), 0);
  const gaps: Gap[] = [...gapsOrWhy];
  const unread = chats.filter((c) => c.missing > 0).length;
  if (unread) gaps.push({ kind: "segments-unread", chats: unread });
  let counted = tokens;
  let cost: CostTally | undefined;
  if (limit.unit === "usd") {
    cost = tallyCost(chats);
    counted = recordedUsd(cost);
    if (cost.kinds.unknown.tokens > 0) gaps.push({ kind: "unpriced", tokens: cost.kinds.unknown.tokens });
    if (cost.kinds.partial.chats > 0) gaps.push({ kind: "partly-priced", chats: cost.kinds.partial.chats });
    if (cost.kinds.estimated.chats + cost.kinds.partial.chats > 0) gaps.push({ kind: "estimated" });
  } else {
    const unreported = chats.filter((c) => c.missing === 0 && chatTotalShort(c)).length;
    if (unreported) gaps.push({ kind: "tokens-unreported", chats: unreported });
  }
  const spent: Spent = { unit: limit.unit, counted, share: counted / limit.amount, tokens, ...(cost && { cost }), gaps };
  const level = levelOf(counted, limit);
  return { state: "read", budget, window: w, spent, forecast: forecastOf(spent, limit, w, now), top: topOf(chats, limit.unit, counted, "exact"), ...(level && { level }) };
}

function modelReading(budget: Budget & { scope: ModelScope }, w: Extract<BudgetWindow, { kind: "rolling" }>, facts: SpendFacts, now: number): BudgetReading {
  const { scope, limit } = budget;
  const reads = facts.profiles.map((p) => ({ profile: p, read: facts.models.get(modelKey(p, w.days)) ?? ({ state: "failed", error: "Not read yet." } as const) }));
  const ok = reads.filter((r) => r.read.state === "ok");
  if (!ok.length) {
    const failed = reads.find((r) => r.read.state === "failed")?.read;
    return { state: "unreadable", budget, window: w, why: failed?.state === "failed" ? { kind: "models-failed", error: failed.error } : { kind: "models-unsupported" } };
  }
  let usdSum = 0;
  let tokens = 0;
  let unpriced = 0;
  for (const r of ok)
    for (const row of r.read.state === "ok" ? r.read.rows : [])
      if (row.model === scope.model) {
        const t = row.input + row.cacheRead + row.output;
        usdSum += row.estimatedUsd;
        tokens += t;
        if (row.estimatedUsd === 0) unpriced += t;
      }
  const gaps: Gap[] = reads.flatMap((r): Gap[] => (r.read.state === "failed" ? [{ kind: "profile-failed", profile: r.profile, error: r.read.error }] : []));
  if (limit.unit === "usd" && unpriced > 0) gaps.push({ kind: "unpriced", tokens: unpriced });
  gaps.push({ kind: "model-sums" });
  const counted = limit.unit === "usd" ? usdSum : tokens;
  const spent: Spent = { unit: limit.unit, counted, share: counted / limit.amount, tokens, gaps };
  const chats = facts.chats.filter((c) => c.model === scope.model && inWindow(c, w));
  const level = levelOf(counted, limit);
  return { state: "read", budget, window: w, spent, forecast: forecastOf(spent, limit, w, now), top: topOf(chats, limit.unit, counted, "last-model"), ...(level && { level }) };
}

/** Every budget's reading from one check's facts. Pure: the same inputs give the same readings. */
export function evaluate(budgets: readonly Budget[], facts: SpendFacts, now: number): BudgetReading[] {
  return budgets.map((budget) => {
    const w = windowOf(budget, now);
    return budget.scope.kind === "model"
      ? modelReading(budget as Budget & { scope: ModelScope }, w as Extract<BudgetWindow, { kind: "rolling" }>, facts, now)
      : chatReading(budget as Budget & { scope: ChatScope }, w, facts, now);
  });
}

// --- Alerts -------------------------------------------------------------------------------------------------------

/** A budget's terms as one string (`week Europe/London usd 50`): a mark made under other terms doesn't apply. */
export const termsOf = (budget: Pick<Budget, "period" | "limit">): string => `${budget.period.every} ${budget.period.zone} ${budget.limit.unit} ${budget.limit.amount}`;

/**
 * The highest threshold already announced for a budget, in which window, under which terms. Kept beside the budget
 * (budgetWatch.ts). Nobody resets it: a mark whose window or terms isn't the reading's doesn't apply, so a new period
 * and an edited limit re-arm by themselves.
 */
export type FiredMark = { window: WindowKey; terms: string; fired: Threshold };

/** An alert that is due: the highest threshold newly reached, standing for any lower ones passed with it. */
export type Crossing = { reading: ReadReading; threshold: Threshold; mark: FiredMark };

/** The threshold a mark has announced for `reading`'s window and terms; 0 when it is of another. */
export const firedFor = (reading: BudgetReading, mark: FiredMark | undefined): Threshold | 0 =>
  mark && mark.window === reading.window.key && mark.terms === termsOf(reading.budget) ? mark.fired : 0;

/**
 * The alert a reading is owed, or none, and the mark that records it. One per check at most: a budget found at 85%
 * says 80% once. An `unreadable` reading is owed nothing. A budget made or edited while already past a threshold is
 * owed that threshold: it is true, and the owner asked to hear it. Pure; the watch claims the mark, then notifies.
 */
export function dueAlert(reading: BudgetReading, mark: FiredMark | undefined): Crossing | undefined {
  if (reading.state !== "read" || !reading.level || reading.level <= firedFor(reading, mark)) return undefined;
  return { reading, threshold: reading.level, mark: { window: reading.window.key, terms: termsOf(reading.budget), fired: reading.level } };
}

/** "Profile astra", "Project Website in astra", "Model gpt-5", "This server". */
export function scopeLabel(scope: BudgetScope, projectName: (profile: string, project: string) => string | undefined): string {
  switch (scope.kind) {
    case "server":
      return "This server";
    case "profile":
      return `Profile ${scope.profile}`;
    case "project":
      return `Project ${projectName(scope.profile, scope.project) ?? "(gone)"} in ${scope.profile}`;
    case "model":
      return `Model ${scope.model}`;
  }
}

/** "today", "this week", "in the last 7 days". */
export function windowLabel(w: BudgetWindow): string {
  if (w.kind === "rolling") return w.days === 1 ? "in the last 24 hours" : `in the last ${w.days} days`;
  return w.every === "day" ? "today" : `this ${w.every}`;
}

/**
 * What the notification says: the budget's scope (a name the owner picked) and how far it got, never a chat's
 * title or messages (transport.ts `NOTICES`). "Budget at 80%" / "Profile astra has used about $40.12 of $50.00 this week."
 */
export function crossingNotice(c: Crossing, projectName: (profile: string, project: string) => string | undefined): { title: string; body: string } {
  const { budget, spent, window } = c.reading;
  // In words, as the tab's `~` and `+` would be: short beats estimated, since the truth is higher either way.
  const least = isShort(spent.gaps) ? "at least " : spent.gaps.some((g) => g.kind === "estimated") ? "about " : "";
  return {
    title: c.threshold === 100 ? "Budget reached" : `Budget at ${c.threshold}%`,
    body: `${scopeLabel(budget.scope, projectName)} has used ${least}${amountLabel(spent.counted, spent.unit)} of ${amountLabel(budget.limit.amount, budget.limit.unit)} ${windowLabel(window)}.`,
  };
}

// --- The tab's plain words: one list, so the tab and its test can't drift ------------------------------------------

export const BUDGET_NOTES = [
  "The app checks budgets only while it is running and connected to this server.",
  "Hermes counts a chat's whole cost on the day it started, so a long chat's later spending lands on its first day.",
  "A model Hermes can't price counts as $0 in a dollar budget. Its tokens still show, and a token budget counts them.",
  "These are Hermes's own figures, a lower bound of the provider's bill.",
] as const;

// --- Saved form (parsed at the storage boundary only) ------------------------------------------------------------

/**
 * A budget as saved. It doesn't hold its profile: a profile or project budget is filed under its profile's scope
 * (`connectionScope(c, profile)`), a server or model budget under the connection's (`connectionScope(c)`), and
 * `shelfOf` fills the profile in from where it was found. So renaming or deleting a profile moves or drops its
 * budgets and their marks through the existing `SCOPED_DOCS` walk (ADR 0156), with no code that knows of budgets.
 */
export type SavedScope = { kind: "server" } | { kind: "profile" } | { kind: "project"; project: string } | { kind: "model"; model: string };
export type SavedBudget = Omit<Budget, "scope"> & { scope: SavedScope };
export type Shelf = { budgets: SavedBudget[]; fired: Record<string, FiredMark> };

export type ShelfName = { profile: string } | "connection";

/** Where a budget is filed: its profile's shelf, or the connection's. */
export const shelfFor = (scope: BudgetScope): ShelfName => (scope.kind === "profile" || scope.kind === "project" ? { profile: scope.profile } : "connection");

/** A budget as saved on its shelf. */
export function savedOf(b: Budget): SavedBudget {
  const scope: SavedScope = b.scope.kind === "profile" ? { kind: "profile" } : b.scope.kind === "project" ? { kind: "project", project: b.scope.project } : b.scope;
  return { ...b, scope };
}

function scopeOn(s: unknown, shelf: ShelfName): BudgetScope | undefined {
  if (!isObj(s)) return undefined;
  if (shelf === "connection") {
    if (s.kind === "server") return { kind: "server" };
    if (s.kind === "model" && typeof s.model === "string" && s.model) return { kind: "model", model: s.model };
    return undefined;
  }
  if (s.kind === "profile") return { kind: "profile", profile: shelf.profile };
  if (s.kind === "project" && typeof s.project === "string" && s.project) return { kind: "project", profile: shelf.profile, project: s.project };
  return undefined;
}

function budgetOn(v: unknown, shelf: ShelfName): Budget | undefined {
  if (!isObj(v) || typeof v.id !== "string" || !v.id || !isObj(v.period) || !isObj(v.limit)) return undefined;
  const scope = scopeOn(v.scope, shelf);
  const { every, zone } = v.period;
  const { unit, amount } = v.limit;
  if (!scope || !EVERY.includes(every as Every) || typeof zone !== "string" || !knownZone(zone)) return undefined;
  if (!UNITS.includes(unit as Limit["unit"]) || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return undefined;
  const createdAt = typeof v.createdAt === "number" && Number.isFinite(v.createdAt) ? v.createdAt : 0;
  return { id: v.id as BudgetId, scope, period: { every: every as Every, zone }, limit: { unit: unit as Limit["unit"], amount }, createdAt };
}

function markOf(v: unknown): FiredMark | undefined {
  if (!isObj(v) || typeof v.window !== "string" || typeof v.terms !== "string" || !THRESHOLDS.includes(v.fired as Threshold)) return undefined;
  return { window: v.window as WindowKey, terms: v.terms, fired: v.fired as Threshold };
}

/** The budgets and marks on one shelf, from saved JSON. Drops any entry that isn't valid or is filed on the wrong shelf, and counts it. */
export function shelfOf(v: unknown, shelf: ShelfName): { budgets: Budget[]; fired: Record<string, FiredMark>; dropped: number } {
  const raw = isObj(v) && Array.isArray(v.budgets) ? v.budgets : [];
  const budgets = raw.flatMap((b) => budgetOn(b, shelf) ?? []);
  const ids = new Set(budgets.map((b) => b.id as string));
  const fired: Record<string, FiredMark> = {};
  if (isObj(v) && isObj(v.fired))
    for (const [id, m] of Object.entries(v.fired)) {
      const mark = ids.has(id) ? markOf(m) : undefined;
      if (mark) fired[id] = mark;
    }
  return { budgets, fired, dropped: raw.length - budgets.length };
}
