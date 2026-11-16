import { expect, it } from "vitest";
import { boot, shot } from "../harness";
import planDocx from "../../src/ui/fixtures/plan.docx?url";
import reportPdf from "../../src/ui/fixtures/report.pdf?url";

/** A fixture's bytes as the fake server keeps a file: one character per byte. */
const latin1 = async (url: string) => String.fromCharCode(...new Uint8Array(await (await fetch(url)).arrayBuffer()));

async function openInPreview(path: string) {
  const [docx, pdf] = await Promise.all([latin1(planDocx), latin1(reportPdf)]);
  const { app } = await boot({
    seed: (s) => {
      s.serverFiles = { "/home/owner/plan.docx": docx, "/home/owner/report.pdf": pdf };
    },
  });
  await app.getByRole("button", { name: "Open the side panel" }).click();
  await app.getByRole("button", { name: "Preview" }).click();
  await app.getByRole("textbox", { name: "Address" }).fill(path);
  await app.getByRole("textbox", { name: "Address" }).element().closest("form")!.requestSubmit();
  return app;
}

it("draws each page of a PDF from the server", async () => {
  const app = await openInPreview("/home/owner/report.pdf");
  await expect.element(app.getByRole("img", { name: "Page 2 of 2" })).toBeVisible();
  await expect.element(app.getByText("PDF · 981 B · 2 pages")).toBeVisible();
  const page = app.getByRole("img", { name: "Page 1 of 2" }).element() as HTMLCanvasElement;
  const pixels = page.getContext("2d")!.getImageData(0, 0, page.width, page.height).data;
  let inked = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128) inked++;
  expect(inked, "dark pixels of the page's text").toBeGreaterThan(500);
  await shot("pdf");
});

it("shows a Word document from the server", async () => {
  const app = await openInPreview("/home/owner/plan.docx");
  const frame = app.getByTitle("Rendered /home/owner/plan.docx");
  await expect.element(frame).toBeVisible();
  const doc = frame.element().getAttribute("srcdoc")!;
  expect(doc).toContain("<h1>Quarterly plan</h1>");
  expect(doc.match(/<tr>/g)).toHaveLength(4);
  await shot("docx");
});
