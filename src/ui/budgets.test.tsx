// @vitest-environment jsdom
// Usage → Budgets (Budgets.tsx, ADR 0187): adding a budget, and what a budget shows: spent with its caveats, the
// forecast, the top chats, and the four things the tab must say plainly. Hermes is a fixture behind the budget watch.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetWatch, budgetShelves, type BudgetIo, type WatchDeps } from "../hermes/budgetWatch";
import { BUDGET_NOTES, type BudgetId } from "../hermes/budgets";
import { UsageAnalytics } from "./UsageAnalytics";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const connection = { id: "c1", mode: "url" as const, url: "http://hermes", username: "liam" } as never;

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const chat = (id: string, title: string, usd: number | null, tokens: number) => ({
  id,
  title,
  source: "cli",
  started_at: (NOW - 3_600_000) / 1000,
  model: "gpt-5",
  input_tokens: tokens,
  output_tokens: 0,
  api_call_count: 1,
  cost_status: usd === null ? "unknown" : "estimated",
  estimated_cost_usd: usd,
});

function setup(rows: Record<string, unknown>[], { ops = [], projects = () => ({ chats: {}, known: [] }) }: { ops?: Record<string, unknown>[]; projects?: WatchDeps["projects"] } = {}) {
  const of = (profile: string) => (profile === "default" ? rows : profile === "ops" ? ops : []);
  const io: BudgetIo = {
    page: async (profile) => ({ rows: of(profile), total: of(profile).length }),
    session: vi.fn(),
    hermesTotals: vi.fn(),
    models: async () => ({ models: [] }),
  };
  const notify = vi.fn(async () => {});
  const watch = new BudgetWatch({
    io,
    shelves: budgetShelves(localStorage, connection),
    notify,
    open: () => () => {},
    connected: () => true,
    watchStatus: () => () => {},
    listProfiles: async () => ["default", "ops"],
    projects,
    now: () => NOW,
  });
  const onOpenChat = vi.fn();
  render(
    <UsageAnalytics
      budgets={watch}
      budgetZone="UTC"
      io={io}
      profile="default"
      listProfiles={async () => ["default", "ops"]}
      projects={[]}
      projectChats={{}}
      connected
      onOpenChat={onOpenChat}
      saveCsv={vi.fn()}
      onClose={vi.fn()}
      now={() => NOW}
    />,
  );
  return { notify, onOpenChat };
}

describe("Usage → Budgets", () => {
  it("adds a budget and shows what it spent, where it is heading and the chats behind it", async () => {
    const { notify, onOpenChat } = setup([chat("a", "Nightly loop", 6, 60_000), chat("b", "Quick fix", 1.5, 9_000), chat("c", "Local model", null, 400_000)]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Budgets" }));
    expect(screen.getByText("No budgets yet. Add one to set a daily, weekly or monthly limit.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add budget" }));
    await user.type(screen.getByRole("textbox", { name: "Limit" }), "10");
    await user.click(within(screen.getByRole("form", { name: "New budget" })).getByRole("button", { name: "Add budget" }));

    const card = await screen.findByRole("article", { name: "Profile default, daily budget" });
    await waitFor(() => expect(within(card).getByText("~$7.50+ of $10.00")).toBeTruthy());
    expect(within(card).getByRole("meter").getAttribute("aria-valuenow")).toBe("75");
    // Half the day gone at noon UTC: $7.50 so far is $15.00 by midnight, the limit at 16:00.
    expect(within(card).getByText(/^At this pace, at least \$15\.00 by the end of the day \(150% of the limit\), reaching the limit about/)).toBeTruthy();
    expect(within(card).getByText(/Hermes had no price for 400k tokens, so they count as \$0 here/)).toBeTruthy();
    const top = within(card).getAllByRole("listitem").filter((li) => li.closest(".budget-top"));
    expect(top.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^Nightly loop.*\$6\.00 · 80%$/),
      expect.stringMatching(/^Quick fix.*\$1\.50 · 20%$/),
      expect.stringMatching(/^Local model.*\$0\.00$/),
    ]);
    await user.click(within(card).getByRole("button", { name: "Nightly loop" }));
    expect(onOpenChat).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    // Already past 50% when made: the owner hears it once.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ title: "Budget at 50%", body: "Profile default has used at least $7.50 of $10.00 today." }, expect.anything());

    // The unpriced chat's tokens: a token budget for the same profile is one click away.
    await user.click(within(card).getByRole("button", { name: "Add a token budget for this" }));
    expect((screen.getByRole("combobox", { name: "In" }) as HTMLSelectElement).value).toBe("tokens");
  });

  it("says there is nothing priced to forecast from, rather than nothing spent, when Hermes priced none of it", async () => {
    setup([chat("c", "Local model", null, 400_000)]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Budgets" }));
    await user.click(screen.getByRole("button", { name: "Add budget" }));
    await user.type(screen.getByRole("textbox", { name: "Limit" }), "10");
    await user.click(within(screen.getByRole("form", { name: "New budget" })).getByRole("button", { name: "Add budget" }));
    const card = await screen.findByRole("article", { name: "Profile default, daily budget" });
    await waitFor(() => expect(within(card).getByText("Nothing Hermes could price yet, so no forecast.")).toBeTruthy());
    expect(within(card).getByText("$0.00+ of $10.00")).toBeTruthy();
  });

  it("makes the token budget for another profile's project in that profile", async () => {
    budgetShelves(localStorage, connection).save({
      id: "p" as BudgetId,
      scope: { kind: "project", profile: "ops", project: "web" },
      period: { every: "day", zone: "UTC" },
      limit: { unit: "usd", amount: 10 },
      createdAt: 0,
    });
    setup([], {
      ops: [chat("x", "Site build", null, 50_000)],
      projects: (p) => ({
        chats: Object.fromEntries(p === "ops" ? [["web", ["x"]]] : []),
        known: p === "ops" ? [{ id: "web", name: "Website", folders: [], archived: false }] : [],
      }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Budgets" }));
    const card = await screen.findByRole("article", { name: "Project Website in ops, daily budget" });
    await user.click(await within(card).findByRole("button", { name: "Add a token budget for this" }));
    expect((screen.getByRole("combobox", { name: "Project in ops" }) as HTMLSelectElement).value).toBe("web");
    await user.type(screen.getByRole("textbox", { name: "Limit" }), "1M");
    await user.click(within(screen.getByRole("form", { name: "New budget" })).getByRole("button", { name: "Add budget" }));
    await waitFor(() => expect(budgetShelves(localStorage, connection).load().budgets).toHaveLength(2));
    expect(budgetShelves(localStorage, connection).load().budgets[1]).toMatchObject({ scope: { kind: "project", profile: "ops", project: "web" }, limit: { unit: "tokens", amount: 1_000_000 } });
  });

  it("says plainly when it checks, how Hermes counts, and that its figures are a lower bound", async () => {
    setup([]);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Budgets" }));
    for (const note of BUDGET_NOTES) expect(screen.getByText(note)).toBeTruthy();
  });

  it("edits a budget's limit and removes it", async () => {
    setup([chat("a", "Nightly loop", 6, 60_000)]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Budgets" }));
    await user.click(screen.getByRole("button", { name: "Add budget" }));
    await user.type(screen.getByRole("textbox", { name: "Limit" }), "100");
    await user.click(within(screen.getByRole("form", { name: "New budget" })).getByRole("button", { name: "Add budget" }));
    const card = await screen.findByRole("article", { name: "Profile default, daily budget" });
    await waitFor(() => expect(within(card).getByText("~$6.00 of $100.00")).toBeTruthy());
    await user.click(within(card).getByRole("button", { name: "Edit budget" }));
    const limit = screen.getByRole("textbox", { name: "Limit" });
    await user.clear(limit);
    await user.type(limit, "8");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(card).getByText("~$6.00 of $8.00")).toBeTruthy());
    await user.click(within(card).getByRole("button", { name: "Remove budget" }));
    expect(screen.queryByRole("article")).toBeNull();
  });
});
