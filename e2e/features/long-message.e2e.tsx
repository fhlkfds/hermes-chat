import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { boot, shot, sessionOfPrompt } from "../harness";

const HASHES = `Hashes: SHA256=${"7E3A0C91B5D4F268".repeat(6)},IMPHASH=${"C0FFEE00".repeat(6)}`;
const PROMPT = ["ALERT REPORT", "Severity: Level 12", "Image: C:\\Program Files\\Example\\app.exe", HASHES, "Signed: true"].join("\n");

const rect = (el: Element) => el.getBoundingClientRect();
const inApp = <T extends Element>(css: string) => document.querySelector("iframe")!.contentDocument!.querySelector<T>(css)!;

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
