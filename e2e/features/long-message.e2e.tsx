import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import type { FakeHermes } from "../../src/hermes/fakeHermes";
import { boot, shot, sessionOfPrompt } from "../harness";

const HASHES = `Hashes: SHA256=${"7E3A0C91B5D4F268".repeat(6)},IMPHASH=${"C0FFEE00".repeat(6)}`;
const PROMPT = ["ALERT REPORT", "Severity: Level 12", "Image: C:\\Program Files\\Example\\app.exe", HASHES, "Signed: true"].join("\n");
const HASH_300 = "9f3c2a7e5b1d8046".repeat(19).slice(0, 300);

const rect = (el: Element) => el.getBoundingClientRect();
const inApp = <T extends Element>(css: string) => document.querySelector("iframe")!.contentDocument!.querySelector<T>(css)!;

async function sendAndReply(app: Awaited<ReturnType<typeof boot>>["app"], server: FakeHermes, prompt: string, reply: string) {
  await app.getByPlaceholder("Message Hermes").fill(prompt);
  await userEvent.keyboard("{Enter}");
  const session = await sessionOfPrompt(server, prompt);
  server.event(session, "message.start");
  server.event(session, "message.complete", { text: reply, status: "complete" });
  await expect.element(app.getByText(reply)).toBeVisible();
}

it("keeps a message with a long unbroken line inside the chat column, scrolling sideways on its own", async () => {
  const { app, server } = await boot();
  const composer = app.getByPlaceholder("Message Hermes");
  await composer.fill(PROMPT);
  await userEvent.keyboard("{Enter}");
  await sessionOfPrompt(server, PROMPT);
  await expect.element(app.getByText("ALERT REPORT", { exact: false }).first()).toBeVisible();

  const bubble = inApp<HTMLElement>(".msg.user .bubble-text");
  const column = inApp<HTMLElement>(".transcript-inner");
  const transcript = inApp<HTMLElement>(".transcript");
  const padding = parseFloat(column.ownerDocument.defaultView!.getComputedStyle(column).paddingLeft);
  await shot("long-message");

  expect(rect(bubble).left, "the bubble starts inside the chat column").toBeGreaterThanOrEqual(rect(column).left + padding - 0.5);
  expect(rect(bubble).right, "the bubble ends inside the chat column").toBeLessThanOrEqual(rect(column).right - padding + 0.5);
  expect(bubble.scrollWidth, "the long line scrolls inside the bubble").toBeGreaterThan(bubble.clientWidth);
  expect(transcript.scrollWidth, "the transcript itself never scrolls sideways").toBeLessThanOrEqual(transcript.clientWidth);

  bubble.scrollLeft = bubble.scrollWidth;
  await expect.poll(() => bubble.scrollLeft, { message: "the bubble scrolls to the end of the line" }).toBeGreaterThan(0);
  await shot("long-message-scrolled");
});

it("lines a bubble holding a 300-character hash up with the reply's left edge", async () => {
  const { app, server } = await boot();
  await sendAndReply(app, server, `Is this the build I signed? ${HASH_300}`, "Yes, that hash matches the signed build.");

  const bubble = inApp<HTMLElement>(".msg.user .bubble-text");
  const reply = inApp<HTMLElement>(".msg.assistant");
  await shot("hash-and-reply");

  expect(Math.abs(rect(bubble).left - rect(reply).left), "the bubble's left edge sits on the reply's left edge (±1px)").toBeLessThanOrEqual(1);
  expect(Math.abs(rect(bubble).right - rect(reply).right), "the bubble's right edge sits on the reply's right edge (±1px)").toBeLessThanOrEqual(1);
  expect(bubble.scrollWidth, "the hash scrolls sideways inside the bubble").toBeGreaterThan(bubble.clientWidth);
});

it("keeps a short message right-aligned and only as wide as its text", async () => {
  const { app, server } = await boot();
  await sendAndReply(app, server, "Is the blog up?", "Yes, it's serving pages again.");

  const bubble = inApp<HTMLElement>(".msg.user .bubble-text");
  const reply = inApp<HTMLElement>(".msg.assistant");
  const text = bubble.ownerDocument.createRange();
  text.selectNodeContents(bubble);
  const style = bubble.ownerDocument.defaultView!.getComputedStyle(bubble);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  await shot("short-and-reply");

  expect(Math.abs(rect(bubble).right - rect(reply).right), "the bubble ends at the reply's right edge (±1px)").toBeLessThanOrEqual(1);
  expect(Math.abs(rect(bubble).width - (text.getBoundingClientRect().width + padding)), "the bubble is as wide as its text plus padding (±1px)").toBeLessThanOrEqual(1);
  expect(rect(bubble).width, "the bubble is far narrower than the reply").toBeLessThan(rect(reply).width / 2);
});
