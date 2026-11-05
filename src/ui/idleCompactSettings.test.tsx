// @vitest-environment jsdom
// Settings → Model → Idle compaction on screen: off by default, saved on this computer as it is changed, and shown on
// the Model tab whether or not Hermes is reachable.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_PREFS_KEY, getUIPrefs } from "../hermes/uiPrefs";
import { IdleCompactSettings } from "./IdleCompactSettings";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const select = (name: string) => screen.getByRole<HTMLSelectElement>("combobox", { name });

describe("Idle compaction settings", () => {
  it("starts off, with the mark and idle time waiting until it's on", () => {
    render(<IdleCompactSettings />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Idle compaction");
    expect(screen.getByRole("switch", { name: "Compact idle chats" }).getAttribute("aria-checked")).toBe("false");
    expect(select("Idle compaction context fullness").disabled).toBe(true);
    expect(select("Idle compaction context fullness").value).toBe("70");
    expect(select("Idle compaction idle time").value).toBe("15");
  });

  it("keeps each change on this computer as it is made", async () => {
    const user = userEvent.setup();
    render(<IdleCompactSettings />);
    await user.click(screen.getByRole("switch", { name: "Compact idle chats" }));
    expect(screen.getByRole("switch", { name: "Compact idle chats" }).getAttribute("aria-checked")).toBe("true");
    await user.selectOptions(select("Idle compaction context fullness"), "85");
    await user.selectOptions(select("Idle compaction idle time"), "60");
    expect(getUIPrefs().idleCompact).toEqual({ enabled: true, percent: 85, idleMinutes: 60 });
    expect(JSON.parse(localStorage.getItem(UI_PREFS_KEY)!).idleCompact).toEqual({ enabled: true, percent: 85, idleMinutes: 60 });
    expect(screen.getByRole("option", { name: "1 hour" })).toBeTruthy();
  });

  it("offers a mark a newer app or a hand edit stored, and drops one that makes no sense", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, idleCompact: { enabled: true, percent: 65, idleMinutes: 0 } }));
    render(<IdleCompactSettings />);
    expect(select("Idle compaction context fullness").value).toBe("65");
    expect(screen.getByRole("option", { name: "65% full" })).toBeTruthy();
    expect(select("Idle compaction idle time").value).toBe("15");
  });
});
