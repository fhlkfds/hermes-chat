// The budget watch (budgetWatch.ts, ADR 0187): one read serves every budget, each threshold is announced once per
// period however many windows check, an edit re-arms, and the budgets follow a profile's rename on this computer.
import { describe, expect, it, vi } from "vitest";
import { BUDGETS_KEY, BudgetWatch, BudgetWatches, budgetShelves, type BudgetIo, type WatchDeps } from "./budgetWatch";
import { draftOf, type BudgetDraft, type BudgetScope } from "./budgets";
import { renameProfileLocally } from "./profileLocalData";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const NOW = Date.parse("2026-11-18T12:00:00Z");
const connection = { id: "c1", mode: "url" as const, url: "http://hermes", username: "liam" } as never;

/** Hermes with chats in profile `ops` costing what `spent` holds now, all started this morning. */
function hermes(spent: { usd: number }) {
  const page = vi.fn(async (profile: string) => ({
    rows:
      profile === "ops"
        ? [{ id: "a", title: "Nightly loop", source: "cron", started_at: (NOW - 3_600_000) / 1000, model: "gpt-5", input_tokens: 1000, output_tokens: 10, api_call_count: 1, cost_status: "estimated", estimated_cost_usd: spent.usd }]
        : [],
    total: profile === "ops" ? 1 : 0,
  }));
  const models = vi.fn(async () => ({ models: [] }));
  const io: BudgetIo = { page, session: vi.fn(), hermesTotals: vi.fn(), models };
  return { io, page, models };
}

function deps(io: BudgetIo, storage: Storage, notify = vi.fn(async () => {})): WatchDeps & { notify: typeof notify } {
  return {
    io,
    shelves: budgetShelves(storage, connection),
    notify,
    open: () => () => {},
    connected: () => true,
    watchStatus: () => () => {},
    listProfiles: async () => ["default", "ops"],
    projects: () => ({ chats: {}, known: [] }),
    now: () => NOW,
  };
}

const draft = (amount: string, scope: BudgetScope = { kind: "profile", profile: "ops" }) =>
  draftOf({ scope, every: "day", zone: "UTC", unit: "usd", amount }) as BudgetDraft;

describe("BudgetWatch", () => {
  it("reads nothing while there are no budgets", async () => {
    const { io, page } = hermes({ usd: 1 });
    const w = new BudgetWatch(deps(io, memoryStorage()));
    await w.check({ force: true });
    expect(page).not.toHaveBeenCalled();
    expect(w.getSnapshot()).toMatchObject({ readings: [], state: "idle" });
  });

  it("announces 50, 80 and 100% once each as spending climbs, naming the profile and never the chat", async () => {
    const spent = { usd: 2 };
    const { io } = hermes(spent);
    const d = deps(io, memoryStorage());
    const w = new BudgetWatch(d);
    await w.save(draft("10"));
    expect(d.notify).not.toHaveBeenCalled();
    for (const usd of [5.5, 6, 8.2, 8.3, 11, 12]) {
      spent.usd = usd;
      await w.check({ force: true });
    }
    expect(d.notify.mock.calls.map((c) => (c as unknown as [{ title: string; body: string }])[0])).toEqual([
      { title: "Budget at 50%", body: "Profile ops has used about $5.50 of $10.00 today." },
      { title: "Budget at 80%", body: "Profile ops has used about $8.20 of $10.00 today." },
      { title: "Budget reached", body: "Profile ops has used about $11.00 of $10.00 today." },
    ]);
    expect(JSON.stringify(d.notify.mock.calls)).not.toContain("Nightly loop");
    const [r] = w.getSnapshot().readings;
    expect(r).toMatchObject({ state: "read", level: 100, top: { chats: [{ chat: { id: "a" } }] } });
  });

  it("announces a threshold once when two windows check the same budget", async () => {
    const storage = memoryStorage();
    const { io } = hermes({ usd: 9 });
    const one = deps(io, storage);
    const two = deps(io, storage);
    await new BudgetWatch(one).save(draft("10"));
    await new BudgetWatch(two).check({ force: true });
    expect(one.notify.mock.calls.length + two.notify.mock.calls.length).toBe(1);
  });

  it("announces again after the limit is edited, and forgets a removed budget's mark with it", async () => {
    const storage = memoryStorage();
    const { io } = hermes({ usd: 6 });
    const d = deps(io, storage);
    const w = new BudgetWatch(d);
    await w.save(draft("10"));
    const [b] = w.getSnapshot().budgets;
    await w.save({ ...draft("7"), id: b.id });
    expect(d.notify.mock.calls.map((c) => (c as unknown as [{ title: string }])[0].title)).toEqual(["Budget at 50%", "Budget at 80%"]);
    w.remove(b.id);
    expect(w.getSnapshot().budgets).toEqual([]);
    expect(JSON.parse(storage.getItem(BUDGETS_KEY)!).scopes).toEqual({});
  });

  it("checks as soon as the connection comes back", async () => {
    const { io, page } = hermes({ usd: 1 });
    let up = false;
    let tell = () => {};
    const w = new BudgetWatch({ ...deps(io, memoryStorage()), connected: () => up, watchStatus: (fn) => ((tell = fn), () => {}) });
    await w.save(draft("10"));
    expect(w.getSnapshot().state).toBe("disconnected");
    w.start();
    up = true;
    tell();
    await vi.waitFor(() => expect(page).toHaveBeenCalled());
    w.stop();
  });
});

describe("budgetShelves", () => {
  it("keeps a profile's budget under the profile, so a rename on this computer carries it and its marks", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const { io } = hermes({ usd: 6 });
    const w = new BudgetWatch(deps(io, storage));
    await w.save(draft("10"));
    await w.save(draft("100", { kind: "server" }));
    await renameProfileLocally(connection, "ops", "astra", { storage });
    const back = budgetShelves(storage, connection).load();
    expect(back.budgets.map((b) => b.scope)).toEqual(expect.arrayContaining([{ kind: "profile", profile: "astra" }, { kind: "server" }]));
    expect(Object.values(back.fired).map((m) => m.fired)).toEqual([50]);
    vi.unstubAllGlobals();
  });
});

describe("BudgetWatches", () => {
  it("starts a watch per live connection and stops it when the connection goes", () => {
    const { io } = hermes({ usd: 0 });
    const ws = new BudgetWatches(() => deps(io, memoryStorage()));
    ws.sync(["c1", "c2"]);
    const first = ws.of("c1");
    expect(first && ws.of("c2")).toBeTruthy();
    ws.sync(["c2"]);
    expect(ws.of("c1")).toBeUndefined();
  });
});
