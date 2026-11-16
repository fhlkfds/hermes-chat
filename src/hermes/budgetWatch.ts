// The budget watch (ADR 0188): one per live connection. It is the only thing that reads Hermes for budgets, the only
// writer of the connection's budgets and their fired marks, and the one place a crossing turns into a notification.
// The Budgets tab holds no copy of any of it: it subscribes to the board and asks the watch to change things.
//
// A check reads every chat started since the earliest window any budget needs (usageAnalytics.ts `collectUsage`), and
// Hermes's per-model sums for each day count a model budget needs, then hands them to the pure `evaluate`
// (budgets.ts). It runs every `CHECK_MS` while connected, when the connection comes back, when a budget is saved, and
// when the tab asks; with no budgets it reads nothing.
import type { Notify, NoticeActions } from "./transport";
import { collectUsage, type UsageIo } from "./usageAnalytics";
import {
  crossingNotice,
  dueAlert,
  evaluate,
  modelKey,
  modelUsageOf,
  readPlan,
  savedOf,
  shelfFor,
  shelfOf,
  type Budget,
  type BudgetDraft,
  type BudgetId,
  type BudgetReading,
  type FiredMark,
  type ModelRead,
  type ShelfName,
  type SpendFacts,
} from "./budgets";
import { connectionScope, scopeParts, type ScopeSource } from "./connections";
import type { Project } from "./projects";
import type { ChatUsage } from "./usage";
import { statusOf } from "./pipe";
import { errorText, isObj } from "./values";

/** The document budgets and their marks are kept in: `{v, scopes: {[connectionScope]: Shelf}}` (profileLocalData.ts `SCOPED_DOCS`). */
export const BUDGETS_KEY = "hermes-chat.budgets";
const BUDGETS_VERSION = 1;

/** How often a live connection's budgets are checked. */
export const CHECK_MS = 5 * 60_000;
/** A check younger than this answers the tab opening instead of a new read. */
export const FRESH_MS = 30_000;

/** Finished compression segments kept across checks, at most. */
const FINISHED_KEPT = 5_000;

/** `UsageIo` and the one read budgets add: `GET /api/analytics/models?days=&profile=` (transport.ts `usageIo`). */
export type BudgetIo = UsageIo & { models(profile: string, days: number): Promise<unknown> };

/** This computer's storage refused a change to the budgets (full, say): nothing of it was kept. */
export class BudgetStorageError extends Error {
  constructor() {
    super("This computer's storage refused the change, so it wasn't kept. Free some space and try again.");
  }
}

/** One connection's budgets and fired marks on this computer. Changes throw `BudgetStorageError` when not kept. */
export type BudgetShelves = {
  /** Every budget and mark of the connection, from every shelf, as stored now. */
  load(): { budgets: Budget[]; fired: Record<string, FiredMark> };
  /**
   * Records `mark` for budget `id` unless a mark already there covers it, reading the stored document first. False
   * when a stored mark covers it, or the budget is gone: then nothing is announced. Claim precedes notify, so an
   * alert fires at most once across reloads and relaunches.
   */
  claim(id: BudgetId, mark: FiredMark): boolean;
  save(budget: Budget): void;
  remove(id: BudgetId): void;
};

type Doc = { v: number; scopes: Record<string, unknown> };

/** The shelves of connection `c` in `storage`'s budgets document. A storage that can't be written keeps nothing. */
export function budgetShelves(storage: Pick<Storage, "getItem" | "setItem">, c: ScopeSource): BudgetShelves {
  const parts = scopeParts(c);
  const scopeOf = (shelf: ShelfName) => (shelf === "connection" ? connectionScope(c) : connectionScope(c, shelf.profile));
  const read = (): Doc => {
    try {
      const v: unknown = JSON.parse(storage.getItem(BUDGETS_KEY) ?? "null");
      if (isObj(v) && isObj(v.scopes)) return { ...v, v: Number(v.v) || BUDGETS_VERSION, scopes: v.scopes };
    } catch {
      // Unreadable: start empty.
    }
    return { v: BUDGETS_VERSION, scopes: {} };
  };
  /** This connection's shelves: the scope, and which shelf it is. */
  const shelves = (doc: Doc) =>
    Object.keys(doc.scopes).flatMap((scope): { scope: string; shelf: ShelfName }[] => {
      let v: unknown;
      try {
        v = JSON.parse(scope);
      } catch {
        return [];
      }
      if (!Array.isArray(v) || !parts.every((p, i) => v[i] === p)) return [];
      if (v.length === parts.length) return [{ scope, shelf: "connection" }];
      return v.length === parts.length + 1 && typeof v[parts.length] === "string" ? [{ scope, shelf: { profile: v[parts.length] } }] : [];
    });
  const write = (doc: Doc) => {
    try {
      storage.setItem(BUDGETS_KEY, JSON.stringify({ ...doc, v: Math.max(BUDGETS_VERSION, doc.v) }));
    } catch {
      throw new BudgetStorageError();
    }
  };
  /** Changes one shelf's saved form, keeping fields a newer app wrote, and drops it when empty. */
  const change = (doc: Doc, scope: string, fn: (s: { budgets: unknown[]; fired: Record<string, unknown> }) => { budgets: unknown[]; fired: Record<string, unknown> }) => {
    const prior = isObj(doc.scopes[scope]) ? (doc.scopes[scope] as Record<string, unknown>) : {};
    const next = fn({ budgets: Array.isArray(prior.budgets) ? prior.budgets : [], fired: isObj(prior.fired) ? prior.fired : {} });
    const scopes = { ...doc.scopes };
    if (next.budgets.length) scopes[scope] = { ...prior, ...next };
    else delete scopes[scope];
    write({ ...doc, scopes });
  };
  const idOf = (b: unknown) => (isObj(b) ? b.id : undefined);
  const load = () => {
    const doc = read();
    const out = { budgets: [] as Budget[], fired: {} as Record<string, FiredMark> };
    for (const { scope, shelf } of shelves(doc)) {
      const s = shelfOf(doc.scopes[scope], shelf);
      out.budgets.push(...s.budgets);
      Object.assign(out.fired, s.fired);
    }
    out.budgets.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  };
  const shelfHolding = (doc: Doc, id: BudgetId) =>
    shelves(doc).find(({ scope }) => {
      const s = doc.scopes[scope];
      return isObj(s) && Array.isArray(s.budgets) && s.budgets.some((b) => idOf(b) === id);
    });
  return {
    load,
    claim(id, mark) {
      const doc = read();
      const at = shelfHolding(doc, id);
      if (!at) return false;
      const s = shelfOf(doc.scopes[at.scope], at.shelf);
      const was = s.fired[id];
      if (was && was.window === mark.window && was.terms === mark.terms && was.fired >= mark.fired) return false;
      change(doc, at.scope, (shelf) => ({ ...shelf, fired: { ...shelf.fired, [id]: mark } }));
      return true;
    },
    save(budget) {
      const doc = read();
      const scope = scopeOf(shelfFor(budget.scope));
      // An edit keeps the budget's place on its shelf; a budget is never on two shelves.
      const old = shelfHolding(doc, budget.id);
      if (old && old.scope !== scope) change(doc, old.scope, (s) => ({ ...s, budgets: s.budgets.filter((b) => idOf(b) !== budget.id) }));
      change(read(), scope, (s) => {
        const at = s.budgets.findIndex((b) => idOf(b) === budget.id);
        const budgets = [...s.budgets];
        if (at < 0) budgets.push(savedOf(budget));
        else budgets[at] = savedOf(budget);
        return { ...s, budgets };
      });
    },
    remove(id) {
      const doc = read();
      const at = shelfHolding(doc, id);
      if (!at) return;
      change(doc, at.scope, (s) => {
        const { [id]: _gone, ...fired } = s.fired;
        return { budgets: s.budgets.filter((b) => idOf(b) !== id), fired };
      });
    },
  };
}

export type WatchDeps = {
  io: BudgetIo;
  shelves: BudgetShelves;
  /** `notifyFor(connection)`: names the server when several connections are live. */
  notify: Notify;
  /** What a budget notification's click does: open Usage → Budgets on this connection. */
  open: (id: BudgetId) => NoticeActions["open"];
  connected: () => boolean;
  /** Calls `fn` on each change of the connection's state, so a check runs as soon as it is back. */
  watchStatus: (fn: () => void) => () => void;
  listProfiles: () => Promise<string[]>;
  /** A profile's projects as this computer files them (ADR 0131): which chats are in each, and the projects known. */
  projects: (profile: string) => { chats: Readonly<Record<string, readonly string[]>>; known: readonly Project[] };
  now?: () => number;
};

/** What the tab shows. `readAt`: when the readings' facts were read; none before the first check. */
export type BudgetBoard = {
  budgets: readonly Budget[];
  readings: readonly BudgetReading[];
  readAt?: number;
  state: "idle" | "reading" | "disconnected" | { failed: string };
};

export class BudgetWatch {
  private board: BudgetBoard;
  private listeners = new Set<() => void>();
  private running?: Promise<void>;
  private rerun = false;
  private timer?: ReturnType<typeof setInterval>;
  private unwatch?: () => void;
  private wasConnected = false;
  private stopped = false;
  /**
   * The marks this watch announced, kept here too: when storage refuses one, the threshold is still announced only
   * once while the app runs.
   */
  private told = new Map<string, FiredMark>();
  /** Finished compression segments read by earlier checks (usageAnalytics.ts `collectUsage` `finished`). */
  private finished = new Map<string, ChatUsage | undefined>();
  private now: () => number;

  constructor(private deps: WatchDeps) {
    this.now = deps.now ?? Date.now;
    this.board = { budgets: deps.shelves.load().budgets, readings: [], state: "idle" };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getSnapshot = (): BudgetBoard => this.board;

  private publish(change: Partial<BudgetBoard>) {
    this.board = { ...this.board, ...change };
    this.listeners.forEach((fn) => fn());
  }

  /** The stored budgets, with readings kept only for those still there. */
  private reload() {
    const { budgets } = this.deps.shelves.load();
    const ids = new Set(budgets.map((b) => b.id));
    this.publish({ budgets, readings: this.board.readings.filter((r) => ids.has(r.budget.id)) });
  }

  /**
   * Saves a new or edited budget, then checks at once so its reading (and any alert it is owed) follows: the save is
   * done when this returns, and the promise is the check. Throws `BudgetStorageError`, before any check, when this
   * computer's storage refuses it.
   */
  save(draft: BudgetDraft): Promise<void> {
    const old = draft.id ? this.board.budgets.find((b) => b.id === draft.id) : undefined;
    // A budget's scope never changes: an edit changes its terms only.
    const budget: Budget = old ? { ...old, period: draft.period, limit: draft.limit } : { ...draft, id: crypto.randomUUID() as BudgetId, createdAt: this.now() };
    this.deps.shelves.save(budget);
    this.reload();
    return this.check({ force: true });
  }

  /** Throws `BudgetStorageError` when this computer's storage refuses the change. */
  remove(id: BudgetId): void {
    this.deps.shelves.remove(id);
    this.reload();
  }

  /**
   * Checks now: the tab opening (a check younger than `FRESH_MS` answers it) or Refresh (`force`). Joins a check in
   * flight, running once more after it when forced. Never throws: a failure shows in the board's state.
   */
  check(opts: { force?: boolean } = {}): Promise<void> {
    if (this.running) {
      if (opts.force) this.rerun = true;
      return this.running;
    }
    if (!opts.force && this.board.readAt !== undefined && this.now() - this.board.readAt < FRESH_MS) return Promise.resolve();
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.once();
        } while (this.rerun && !this.stopped);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async once() {
    const { io, shelves, connected, listProfiles } = this.deps;
    if (!connected()) return this.publish({ state: "disconnected" });
    const { budgets } = shelves.load();
    const now = this.now();
    const plan = readPlan(budgets, now);
    if (!plan) return this.publish({ budgets, readings: [], state: "idle" });
    this.publish({ budgets, state: "reading" });
    try {
      let all: string[];
      try {
        all = await listProfiles();
      } catch (e) {
        if (plan.profiles === "all") throw e;
        all = plan.profiles;
      }
      const profiles = plan.profiles === "all" ? all : plan.profiles;
      // A long session's earlier periods leave segments no check needs again: start over past a bound.
      if (this.finished.size > FINISHED_KEPT) this.finished.clear();
      const data = await collectUsage(io, profiles, { from: plan.from, to: now + 1 }, { finished: this.finished, now: this.now });
      const models = new Map<string, ModelRead>();
      for (const days of plan.modelDays)
        for (const p of all) {
          let read: ModelRead;
          try {
            const rows = modelUsageOf(await io.models(p, days));
            read = rows ? { state: "ok", rows } : { state: "unsupported" };
          } catch (e) {
            read = statusOf(e) === 404 ? { state: "unsupported" } : { state: "failed", error: errorText(e) };
          }
          models.set(modelKey(p, days), read);
        }
      if (this.stopped) return;
      const facts: SpendFacts = {
        from: plan.from,
        readAt: now,
        profiles: all,
        reads: data.profiles,
        chats: data.chats,
        models,
        projectChats: (profile, project) => {
          const { chats, known } = this.deps.projects(profile);
          return chats[project] || known.some((p) => p.id === project) ? new Set(chats[project] ?? []) : undefined;
        },
      };
      // Budgets saved or removed while Hermes was read are evaluated as they are now; a save also asks for a rerun.
      const current = shelves.load().budgets;
      const readings = evaluate(current, facts, now);
      const fired = shelves.load().fired;
      for (const r of readings) {
        const due = dueAlert(r, fired[r.budget.id]);
        if (!due || !dueAlert(r, this.told.get(r.budget.id))) continue;
        try {
          if (!shelves.claim(r.budget.id, due.mark)) continue;
        } catch {
          // Storage refused the mark: `told` keeps it for this run, so the alert still goes out once.
        }
        this.told.set(r.budget.id, due.mark);
        void this.deps.notify(crossingNotice(due, this.projectName), { open: this.deps.open(r.budget.id) }).catch(() => {});
      }
      this.publish({ budgets: current, readings, readAt: now, state: "idle" });
    } catch (e) {
      if (!this.stopped) this.publish({ state: { failed: errorText(e) } });
    }
  }

  /** A project's name, from the projects this computer knows for its profile. */
  projectName = (profile: string, project: string) => this.deps.projects(profile).known.find((p) => p.id === project)?.name;

  /** Checks now and every `CHECK_MS`, and as soon as the connection comes back. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    this.wasConnected = this.deps.connected();
    this.unwatch = this.deps.watchStatus(() => {
      const now = this.deps.connected();
      if (now && !this.wasConnected) void this.check({ force: true });
      if (!now && this.wasConnected) this.publish({ state: "disconnected" });
      this.wasConnected = now;
    });
    void this.check();
  }

  /** Stops checking: the connection closed or was removed. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.unwatch?.();
    this.listeners.clear();
  }
}

/** The watches of the live connections, kept in step with them (App.tsx syncs it from `LiveConnections`). */
export class BudgetWatches {
  private watches = new Map<string, { watch: BudgetWatch; instance: object }>();
  private listeners = new Set<() => void>();

  constructor(private make: (connectionId: string) => WatchDeps | undefined) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  /**
   * Starts a watch for each live connection that has none, and stops those whose connection went. `instance`: the
   * connection's `Hermes`; a connection opened again with another (signed in afresh) gets a new watch.
   */
  sync(live: readonly { id: string; instance: object }[]): void {
    let changed = false;
    for (const [id, w] of this.watches)
      if (!live.some((l) => l.id === id && l.instance === w.instance)) {
        w.watch.stop();
        this.watches.delete(id);
        changed = true;
      }
    for (const { id, instance } of live) {
      if (this.watches.has(id)) continue;
      const deps = this.make(id);
      if (!deps) continue;
      const watch = new BudgetWatch(deps);
      this.watches.set(id, { watch, instance });
      watch.start();
      changed = true;
    }
    if (changed) this.listeners.forEach((fn) => fn());
  }

  of(connectionId: string): BudgetWatch | undefined {
    return this.watches.get(connectionId)?.watch;
  }
}

/**
 * Where a budget notification's click goes: the screen showing that connection opens Usage → Budgets. A background
 * connection's notification makes it the one shown first (`switchTo`), and Budgets opens once it shows.
 */
export class BudgetOpener {
  private shown = new Map<string, () => void>();
  private awaiting?: string;
  /** Makes live connection `id` the one shown; set by the screen that can. */
  switchTo?: (id: string) => void;

  /** The screen showing connection `id` opens Budgets with `open`, until the returned function is called. */
  showing(id: string, open: () => void): () => void {
    this.shown.set(id, open);
    if (this.awaiting === id) {
      this.awaiting = undefined;
      open();
    }
    return () => void (this.shown.get(id) === open && this.shown.delete(id));
  }

  open(id: string): void {
    const shown = this.shown.get(id);
    if (shown) return shown();
    this.awaiting = id;
    this.switchTo?.(id);
  }

  /** The switch to `id` didn't happen (the owner kept an unsaved edit, or the connection went): Budgets won't open later. */
  cancel(id: string): void {
    if (this.awaiting === id) this.awaiting = undefined;
  }
}
