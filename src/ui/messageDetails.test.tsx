// @vitest-environment jsdom
// Message details (Settings, Appearance): what shows under each message at each level. Off shows nothing; Date shows
// when each message was stored; Date and tokens adds a reply's token line; Date, tokens and time adds how long the
// reply took and its Run button.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, Item } from "../hermes/model";
import { ScreenshotDesk, type ScreenshotApi } from "../hermes/screenshots";
import { getUIPrefs, setUIPrefs, type MessageDetails } from "../hermes/uiPrefs";
import { appearanceStore } from "./appearance";
import { AppearanceSettings } from "./AppearanceSettings";
import { storedTime } from "./bits";
import { ChatPane } from "./ChatPane";

const noScreenshots: ScreenshotApi = { capture: () => Promise.reject(new Error("no screenshots in this test")), discard: async () => {} };

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const ASKED = 1_763_000_000_000;
const ANSWERED = ASKED + 60_000;
const usage = { prompt: 61394, input: 1234, cache: 60160, output: 1006, reasoning: 183, calls: 3, ms: 12_400 };
const items: Item[] = [
  { kind: "user", id: "u", text: "Disk?", at: ASKED },
  { kind: "assistant", id: "a", text: "82% used.", at: ANSWERED, usage },
  { kind: "user", id: "u2", text: "And now?" },
  { kind: "error", id: "e", text: "Rate limited", usage: { ...usage, output: 0 } },
];
const chat: Chat = { id: "c", runtimeId: "rt", title: "Disk", source: "app", settled: false, updatedAt: 0, items };

function pane() {
  render(
    <ChatPane
      chat={chat}
      status="connected"
      draft="" draftKey="draft" screenshots={new ScreenshotDesk(noScreenshots)}
      onDraft={() => {}}
      onDraftStep={() => undefined}
      onRetry={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
      onAttach={async () => ({ attachments: [], refused: [] })}
      onSend={() => {}}
      onStop={() => {}}
      onAnswer={() => {}}
      onQuestion={() => {}}
      onRun={() => {}}
    />,
  );
}

/** What shows under the messages: the dates, the token lines' text, and how many Run buttons. */
const details = () => ({
  dates: [storedTime(ASKED), storedTime(ANSWERED)].filter((d) => screen.queryByText(d)),
  tokens: screen.queryAllByRole("button", { name: /for this reply:/ }).map((b) => b.textContent),
  runs: screen.queryAllByRole("button", { name: "Run" }).length,
});

describe("Message details", () => {
  it("shows the date, tokens, time and Run by default, as before the setting", () => {
    pane();
    expect(details()).toEqual({
      dates: [storedTime(ASKED), storedTime(ANSWERED)],
      tokens: ["1.2k in · 60.2k cache · 1k out · 12.4 s", "1.2k in · 60.2k cache · 0 out · 12.4 s"],
      runs: 2,
    });
  });

  it.each<[MessageDetails, ReturnType<typeof details>]>([
    ["off", { dates: [], tokens: [], runs: 0 }],
    ["date", { dates: [storedTime(ASKED), storedTime(ANSWERED)], tokens: [], runs: 0 }],
    ["tokens", { dates: [storedTime(ASKED), storedTime(ANSWERED)], tokens: ["1.2k in · 60.2k cache · 1k out", "1.2k in · 60.2k cache · 0 out"], runs: 0 }],
  ])("at %s shows only what that level adds up to", (level, shown) => {
    setUIPrefs({ messageDetails: level });
    pane();
    expect(details()).toEqual(shown);
  });

  it("leaves the time out of a reply's breakdown and its name too when time isn't shown", async () => {
    setUIPrefs({ messageDetails: "tokens" });
    pane();
    const line = screen.getByRole("button", { name: "Tokens for this reply: 1.2k in, 60.2k cache, 1k out. Show breakdown" });
    await userEvent.click(line);
    const table = document.getElementById(line.getAttribute("aria-controls")!)!;
    expect(within(table).queryByText("Time")).toBeNull();
  });

  it("changes an open chat as soon as it's picked in Settings, and keeps the pick", async () => {
    pane();
    const settings = render(<AppearanceSettings store={appearanceStore(new Map() as unknown as Storage, document.createElement("html"))} listFonts={async () => ({ all: [], mono: [] })} />);
    const pick = within(settings.container).getByRole("combobox", { name: "Message details" });
    expect([...pick.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Off", "Date", "Date and tokens", "Date, tokens and time"]);
    expect((pick as HTMLSelectElement).value).toBe("time");

    await userEvent.selectOptions(pick, "Date");
    expect(details()).toEqual({ dates: [storedTime(ASKED), storedTime(ANSWERED)], tokens: [], runs: 0 });
    expect(getUIPrefs().messageDetails).toBe("date");

    act(() => void setUIPrefs({ messageDetails: "time" }));
    expect((pick as HTMLSelectElement).value).toBe("time");
    expect(details().runs).toBe(2);
  });
});
