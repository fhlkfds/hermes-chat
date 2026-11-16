// @vitest-environment jsdom
// The Graph view's link reads (issue #604, ADR 0179): no more than four out at once, one per card, and a card whose
// counts change while its read is out, or whose read was out at a Refresh or a remount, is read again.
import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BoardTask, TaskDetail } from "../hermes/kanban";
import { WorkGraph } from "./WorkGraph";

afterEach(cleanup);

const card = (id: string, children: number, status = "todo"): BoardTask => ({
  id,
  title: id,
  body: "",
  assignee: "",
  status,
  priority: 0,
  comments: 0,
  links: { parents: 0, children },
});

/** A `loadTask` whose answers the test hands out one at a time, newest first for a card asked twice. */
function held() {
  const asked: string[] = [];
  const waiting: { id: string; answer: () => void }[] = [];
  const loadTask = (id: string) =>
    new Promise<TaskDetail>((done) => {
      asked.push(id);
      waiting.push({ id, answer: () => done({ task: card(id, 1), comments: [], links: { parents: [], children: id === "a" ? ["b"] : [] }, linked: [] }) });
    });
  const answer = async (id: string) => {
    const i = waiting.findLastIndex((w) => w.id === id);
    const [w] = waiting.splice(i, 1);
    await act(async () => w.answer());
  };
  return { asked, loadTask, answer };
}

describe("the Graph view's link reads", () => {
  it("reads each linked card once, at most four at a time", async () => {
    const api = held();
    const tasks = ["a", "b", "c", "d", "e", "f"].map((id) => card(id, 1));
    render(<WorkGraph tasks={tasks} api={api} refreshed={0} onOpen={() => {}} />);
    expect(api.asked).toEqual(["a", "b", "c", "d"]);
    await api.answer("a");
    expect(api.asked).toEqual(["a", "b", "c", "d", "e"]);
    await api.answer("b");
    await api.answer("c");
    expect(api.asked).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("reads a card again when its counts change while its read is out", async () => {
    const api = held();
    const { rerender } = render(<WorkGraph tasks={[card("a", 1)]} api={api} refreshed={0} onOpen={() => {}} />);
    expect(api.asked).toEqual(["a"]);
    rerender(<WorkGraph tasks={[card("a", 2)]} api={api} refreshed={0} onOpen={() => {}} />);
    expect(api.asked).toEqual(["a"]);
    await api.answer("a");
    expect(api.asked).toEqual(["a", "a"]);
    await api.answer("a");
    expect(api.asked).toEqual(["a", "a"]);
  });

  it("asks again for a read that was out when React remounted the view, as StrictMode does", async () => {
    const api = held();
    render(
      <StrictMode>
        <WorkGraph tasks={[card("a", 1), card("b", 0)]} api={api} refreshed={0} onOpen={() => {}} />
      </StrictMode>,
    );
    expect(api.asked.at(-1)).toBe("a");
    await api.answer("a");
    expect(document.querySelectorAll("[data-edge]")).toHaveLength(1);
  });

  it("asks again for reads that were out when the owner pressed Refresh", async () => {
    const api = held();
    const tasks = [card("a", 1), card("b", 0)];
    const { rerender } = render(<WorkGraph tasks={tasks} api={api} refreshed={0} onOpen={() => {}} />);
    expect(api.asked).toEqual(["a"]);
    rerender(<WorkGraph tasks={tasks} api={api} refreshed={1} onOpen={() => {}} />);
    expect(api.asked).toEqual(["a", "a"]);
    await api.answer("a");
    expect(document.querySelectorAll("[data-edge]")).toHaveLength(1);
  });
});
