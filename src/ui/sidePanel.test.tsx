// @vitest-environment jsdom
// The side panel's shell (SidePanel.tsx, ADR 0033): a tab is made when first opened and kept, so what runs in it
// survives the owner going to another tab or closing the panel; a tab with something running says so.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidePanel, type PanelTab } from "./SidePanel";

afterEach(cleanup);

const mounts: string[] = [];
const unmounts: string[] = [];
function Probe({ name, shown }: { name: string; shown: boolean }) {
  useEffect(() => {
    mounts.push(name);
    return () => void unmounts.push(name);
  }, [name]);
  return <p>{`${name} ${shown ? "shown" : "hidden"}`}</p>;
}

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [tab, setTab] = useState<PanelTab>("preview");
  const [shown, setShown] = useState(true);
  return (
    <>
      <button onClick={() => setShown((s) => !s)}>toggle</button>
      <SidePanel
        tab={tab}
        onTab={setTab}
        shown={shown}
        overlay={false}
        width={480}
        maxWidth={900}
        onResize={() => {}}
        onHide={() => {}}
        onClose={onClose}
        running={{ terminal: true }}
        tabs={{
          preview: (s) => <Probe name="preview" shown={s} />,
          terminal: (s) => <Probe name="terminal" shown={s} />,
          files: (s) => <Probe name="files" shown={s} />,
          screen: (s) => <Probe name="screen" shown={s} />,
        }}
      />
    </>
  );
}

describe("The side panel", () => {
  it("makes each tab when first opened and keeps it, hidden, while another tab or nothing is shown", () => {
    mounts.length = unmounts.length = 0;
    render(<Harness />);
    expect(mounts).toEqual(["preview"]);
    fireEvent.click(screen.getByRole("tab", { name: /Terminal/ }));
    expect(mounts).toEqual(["preview", "terminal"]);
    expect(screen.getByText("terminal shown")).toBeTruthy();
    expect(screen.getByText("preview hidden")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Screen/ }));
    fireEvent.click(screen.getByText("toggle"));
    expect(screen.getByText("screen hidden")).toBeTruthy();
    expect(document.querySelector("aside")!.hasAttribute("hidden")).toBe(true);
    expect(unmounts).toEqual([]);
    expect(screen.queryByText(/^files/)).toBeNull();
  });

  it("marks a tab with something running, and closes on Escape", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    expect(screen.getByRole("tab", { name: /Terminal/ }).querySelector(".run-dot")).not.toBeNull();
    expect(screen.getByRole("tab", { name: /Files/ }).querySelector(".run-dot")).toBeNull();
    fireEvent.keyDown(screen.getByRole("tab", { name: /Files/ }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
