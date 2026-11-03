// @vitest-environment jsdom
// The shared modal hook under StrictMode, which the app renders in: React sets a dialog's effects up, cleans them up
// and sets them up again while it stays open. Focus must stay in the dialog, and still go back to the opener once
// it closes. TagManager, the upload dialog and the file editor all use this hook.
import { StrictMode, useRef, useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useModal } from "./modal";

afterEach(cleanup);

function Dialog({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  return (
    <div ref={box} role="dialog" aria-label="Dialog" onKeyDown={(e) => (keys(e), e.key === "Escape" && onClose())}>
      <input autoFocus aria-label="Name" />
      <button>Done</button>
    </div>
  );
}

function Page() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && <Dialog onClose={() => setOpen(false)} />}
    </>
  );
}

describe("A modal dialog under StrictMode", () => {
  it("keeps focus inside while open, and gives it back to the opener when closed", async () => {
    render(
      <StrictMode>
        <Page />
      </StrictMode>,
    );
    const user = userEvent.setup();
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
