// Renders the real ChatPane with a synthetic chat and times opening, streaming, find-in-chat and scrolling.
// `run.mjs` drives it in headless Chromium; `window.bench` can also be called by hand from devtools.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../src/styles.css";
import type { Chat, Item } from "../src/hermes/model";
import { ChatPane } from "../src/ui/ChatPane";
import { makeChat, makeReply } from "./fixture";

const root = createRoot(document.getElementById("root")!);
let setChat: (c: Chat) => void = () => {};

function Host({ initial }: { initial: Chat }) {
  const [chat, set] = useState(initial);
  setChat = set;
  return (
    <div className="app">
      <main className="main">
        <ChatPane
          chat={chat}
          status="connected"
          draft=""
          onDraft={() => {}}
          onRetry={() => {}}
          onEdit={() => {}}
          onDismiss={() => {}}
          onAttach={async () => ({ attachments: [], refused: [] })}
          onSend={() => {}}
          onStop={() => {}}
          onAnswer={() => {}}
        />
      </main>
    </div>
  );
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const painted = async () => {
  await frame();
  await frame();
  return performance.now();
};
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r1(q(0.5)), p95: r1(q(0.95)), max: r1(s[s.length - 1]), total: Math.round(s.reduce((a, b) => a + b, 0)) };
};
const transcript = () => document.querySelector<HTMLElement>(".transcript")!;

let current: Chat;
// A fresh key each open, so a chat opened twice mounts afresh, as App remounts ChatPane for each chat.
let opened = 0;

/** Opens a chat of `turns` turns. `commitMs`: render, commit and the layout it forces; `paintMs`: until painted. */
async function open(turns: number) {
  root.render(<></>);
  await painted();
  current = makeChat(turns);
  const t0 = performance.now();
  flushSync(() => root.render(<Host key={++opened} initial={current} />));
  const t1 = performance.now();
  const t2 = await painted();
  return { turns, items: current.items.length, chars: current.items.reduce((n, i) => n + ("text" in i ? i.text.length : 0), 0), nodes: document.getElementsByTagName("*").length, commitMs: Math.round(t1 - t0), paintMs: Math.round(t2 - t0) };
}

/**
 * Streams a reply into the open chat the way Hermes does: a user message, then `message.delta`s of a few characters,
 * one per frame, each a new Chat as `applyEvent` makes it. `updateMs`: each delta's render, commit and forced layout.
 */
async function stream(chunk = 4) {
  const reply = makeReply();
  let items: Item[] = [...current.items, { kind: "user", id: "u-live", text: "Stream something." }];
  flushSync(() => setChat({ ...current, items, running: true }));
  await painted();
  const update: number[] = [];
  const frames: number[] = [];
  let last = performance.now();
  for (let i = 0; i < reply.length; i += chunk) {
    const prev = items[items.length - 1];
    const text = reply.slice(i, i + chunk);
    items = [...items];
    if (prev.kind === "assistant") items[items.length - 1] = { ...prev, text: prev.text + text };
    else items.push({ kind: "assistant", id: "a-live", text });
    const t0 = performance.now();
    flushSync(() => setChat({ ...current, items, running: true }));
    update.push(performance.now() - t0);
    const now = await frame();
    frames.push(now - last);
    last = now;
  }
  const bottom = transcript().scrollHeight - transcript().scrollTop - transcript().clientHeight;
  flushSync(() => setChat({ ...current, items, running: false }));
  await painted();
  return { deltas: update.length, updateMs: stats(update), frameMs: stats(frames), stuckToBottom: bottom < 2 };
}

/**
 * Types `query` into the find bar a key every 150 ms. `keyMs`: from each keystroke to the next frame, so how long typing
 * is held up. `resultsMs`: from the last keystroke until its marks and count are on screen. Then steps to the next match.
 */
async function find(query: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
  await painted();
  const input = document.querySelector<HTMLInputElement>(".find input")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const keyMs: number[] = [];
  let t0 = 0;
  for (let i = 1; i <= query.length; i++) {
    t0 = performance.now();
    setValue.call(input, query.slice(0, i));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    keyMs.push(Math.round((await frame()) - t0));
    if (i < query.length) while (performance.now() - t0 < 150) await frame();
  }
  const shown = () => {
    const marks = [...document.querySelectorAll(".transcript mark.hit")];
    return marks.length > 0 && marks.every((m) => m.textContent!.toLowerCase() === query) && document.querySelector(".find-count")!.textContent!.endsWith(`of ${marks.length}`);
  };
  while (!shown() && performance.now() - t0 < 30_000) await frame();
  const resultsMs = Math.round(performance.now() - t0);
  const count = document.querySelector(".find-count")!.textContent;
  const t2 = performance.now();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await painted();
  const stepMs = Math.round(performance.now() - t2);
  const after = document.querySelector(".find-count")!.textContent;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await painted();
  return { query, count, after, keyMs, resultsMs, stepMs };
}

/** Scrolls from the top to the bottom, `px` per frame, up to 400 frames. */
async function scroll(px = 120) {
  const el = transcript();
  el.scrollTop = 0;
  await painted();
  const frames: number[] = [];
  let last = performance.now();
  for (let i = 0; i < 400 && el.scrollTop + el.clientHeight < el.scrollHeight - 1; i++) {
    el.scrollTop += px;
    const now = await frame();
    frames.push(now - last);
    last = now;
  }
  el.scrollTop = el.scrollHeight;
  return { frameMs: stats(frames), over20ms: frames.filter((f) => f > 20).length };
}

Object.assign(window, { bench: { open, stream, find, scroll } });
