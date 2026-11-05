// @vitest-environment jsdom
// Settings' row layout (#174, ADR 0059): a row's longer help folds behind an (i) button that never joins the control's
// name, and opens by itself while Settings is searched.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SettingNote, SettingRow, SettingsSearching, SettingsSection } from "./SettingRows";

afterEach(cleanup);

function Tray({ searching = false }: { searching?: boolean }) {
  return (
    <SettingsSearching.Provider value={searching}>
      <SettingsSection title="Tray" intro="Where the window goes." more="Section help.">
        <SettingRow
          name="Close to tray"
          nameId="close-label"
          hint="Hides the window instead of quitting."
          hintId="close-hint"
          more="Quit in the tray menu always exits."
          control={<button role="switch" aria-checked={false} aria-labelledby="close-label" aria-describedby="close-hint" />}
        >
          {false}
        </SettingRow>
        <SettingNote tone="warn" role="status">
          No tray here.
        </SettingNote>
      </SettingsSection>
    </SettingsSearching.Provider>
  );
}

describe("SettingRow and SettingsSection", () => {
  it("names the control by the row's name alone, and describes it by the hint", () => {
    render(<Tray />);
    const toggle = screen.getByRole("switch", { name: "Close to tray" });
    expect(toggle.getAttribute("aria-describedby")).toBe("close-hint");
    expect(document.getElementById("close-hint")!.textContent).toBe("Hides the window instead of quitting.");
    // The heading's name is its title alone, without its (i); the section is a landmark only when given an id to name it by.
    expect(screen.getByRole("heading", { name: "Tray", level: 2 })).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("No tray here.");
  });

  it("folds the longer help behind the (i) button until it is pressed", async () => {
    render(<Tray />);
    const about = screen.getByRole("button", { name: "About Close to tray" });
    const help = document.getElementById(about.getAttribute("aria-controls")!)!;
    expect(about.getAttribute("aria-expanded")).toBe("false");
    expect(help.hidden).toBe(true);
    expect(help.textContent).toBe("Quit in the tray menu always exits.");
    await userEvent.click(about);
    expect(about.getAttribute("aria-expanded")).toBe("true");
    expect(help.hidden).toBe(false);
    await userEvent.click(about);
    expect(help.hidden).toBe(true);
    // The section's own (i) folds its help the same way.
    const section = screen.getByRole("button", { name: "About Tray" });
    expect(document.getElementById(section.getAttribute("aria-controls")!)!.hidden).toBe(true);
  });

  it("shows every folded help while Settings is searched, and folds it again after", async () => {
    const { rerender } = render(<Tray searching />);
    for (const name of ["About Close to tray", "About Tray"]) {
      const about = screen.getByRole("button", { name });
      expect(about.getAttribute("aria-expanded")).toBe("true");
      expect(document.getElementById(about.getAttribute("aria-controls")!)!.hidden).toBe(false);
    }
    // A press while searching changes nothing that shows afterwards.
    await userEvent.click(screen.getByRole("button", { name: "About Close to tray" }));
    rerender(<Tray />);
    expect(screen.getByRole("button", { name: "About Close to tray" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("names a section by its heading when given the heading's id", () => {
    render(
      <SettingsSection title="Connections" titleId="conn-title">
        <SettingRow name="Home" />
      </SettingsSection>,
    );
    expect(screen.getByRole("region", { name: "Connections" }).querySelector("h2")!.id).toBe("conn-title");
  });

  it("leaves out the (i), the hint and the space under the row when there are none", () => {
    render(
      <SettingsSection title="On launch">
        <SettingRow name="Reopen last chat" control={<button>Go</button>} />
      </SettingsSection>,
    );
    expect(screen.queryByRole("button", { name: /^About/ })).toBeNull();
    expect(document.querySelector(".set-hint, .set-sub, .set-more, .set-intro")).toBeNull();
  });
});
