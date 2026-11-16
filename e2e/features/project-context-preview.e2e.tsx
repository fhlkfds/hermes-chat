import { expect, it } from "vitest";
import { page, type Locator } from "vitest/browser";
import { boot, shot } from "../harness";
import planDocx from "../../src/ui/fixtures/plan.docx?url";
import reportPdf from "../../src/ui/fixtures/report.pdf?url";

const DIR = "/srv/budget/context";
const LONG_PAGE = `<!doctype html>\n<html>\n<body>\n${Array.from({ length: 200 }, (_, i) => `<p>Line ${i + 1} of the budget page.</p>`).join("\n")}\n</body>\n</html>\n`;

const latin1 = async (url: string) => String.fromCharCode(...new Uint8Array(await (await fetch(url)).arrayBuffer()));

const DIALOG_BORDER_SLACK = 2;
const SUBPIXEL = 0.5;

const box = (l: Locator) => l.element().getBoundingClientRect();

async function previewContextFile(name: string) {
  const [docx, pdf] = await Promise.all([latin1(planDocx), latin1(reportPdf)]);
  const { app } = await boot({
    seed: (s) => {
      s.projects.default = [
        {
          id: "p_budget",
          slug: "budget-tracker",
          name: "Budget Tracker",
          primary_path: "/srv/budget",
          archived: false,
          created_at: 1,
          folders: [{ path: "/srv/budget", label: null, is_primary: true, added_at: 1 }],
        },
      ];
      s.serverDirs = new Set(["/srv", "/srv/budget"]);
      s.managedFiles.nodes = {
        "/srv/budget": { dir: true },
        [`${DIR}/plan.docx`]: { bytes: docx },
        [`${DIR}/report.pdf`]: { bytes: pdf },
        [`${DIR}/budget.html`]: { text: LONG_PAGE },
      };
    },
    commands: { context_read_text: () => null, context_git_exclude: () => "none" },
  });
  await app.getByRole("button", { name: "All chats" }).click();
  await app.getByRole("option", { name: /Budget Tracker/ }).click();
  await app.getByTitle("Project settings for Budget Tracker").click();
  await app.getByRole("region", { name: "Context" }).getByTitle(`Preview ${DIR}/${name}`).click();
  return { app, dialog: app.getByRole("dialog", { name: `Preview of ${name}` }) };
}

function reachesBottom(what: string, area: DOMRect, dialog: DOMRect) {
  const message = `the bottom edge of ${what}, against the dialog's at ${dialog.bottom}`;
  expect(area.bottom, message).toBeGreaterThanOrEqual(dialog.bottom - DIALOG_BORDER_SLACK);
  expect(area.bottom, message).toBeLessThanOrEqual(dialog.bottom + SUBPIXEL);
}

async function docxFillsDialog(dialog: Locator) {
  const bar = dialog.getByText(/^Word document · /);
  const frame = dialog.getByTitle(/^Rendered .*plan\.docx$/);
  await expect.element(frame).toBeVisible();
  const d = box(dialog);
  const under = bar.element().parentElement!.getBoundingClientRect();
  const f = box(frame);
  expect(f.height, "the Word document's height, against the space under its bar").toBeGreaterThanOrEqual(d.bottom - under.bottom - DIALOG_BORDER_SLACK);
  expect(f.top, "the Word document's top edge, against its bar's bottom").toBeCloseTo(under.bottom, 0);
  reachesBottom("the Word document", f, d);
}

it("shows a Word document from the Context card filling the dialog, before and after the window is resized", async () => {
  await page.viewport(1280, 820);
  const { dialog } = await previewContextFile("plan.docx");
  await docxFillsDialog(dialog);
  await shot("docx");

  await page.viewport(900, 600);
  await expect.poll(() => box(dialog).height, { message: "the dialog's height in the smaller window" }).toBeLessThan(600);
  await docxFillsDialog(dialog);
});

it("shows a PDF from the Context card inside the dialog, scrolling through its pages", async () => {
  await page.viewport(1280, 820);
  const { dialog } = await previewContextFile("report.pdf");
  const last = dialog.getByRole("img", { name: "Page 2 of 2" });
  await expect.element(last).toBeVisible();
  const pages = last.element().closest(".preview-pdf") as HTMLElement;
  reachesBottom("the PDF's pages", pages.getBoundingClientRect(), box(dialog));
  expect(pages.scrollHeight, "the height of the PDF's two pages, against the room shown").toBeGreaterThan(pages.clientHeight);
});

it("shows a long HTML file from the Context card inside the dialog, scrolling through its text", async () => {
  await page.viewport(1280, 820);
  const { dialog } = await previewContextFile("budget.html");
  const text = dialog.getByText(/Line 200 of the budget page/);
  await expect.element(text).toBeInTheDocument();
  const body = text.element().parentElement!;
  reachesBottom("the file's text", body.getBoundingClientRect(), box(dialog));
  expect(body.scrollHeight, "the height of the file's text, against the room shown").toBeGreaterThan(body.clientHeight);
});
