import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { DocumentFormat } from "../hermes/documents";
import { sandboxedHtml } from "../hermes/preview";
import { errorText, formatBytes } from "../hermes/values";
import { Spinner } from "./bits";

/** The most pages of a PDF drawn, so a long one can't hold hundreds of page-sized images. */
const PDF_MAX_PAGES = 100;

/** How a Word document's HTML reads in its frame: a page-like column, its tables ruled. */
const DOCX_STYLE = `<style>
body { margin: 0; padding: 28px 32px 48px; font: 15px/1.6 system-ui, sans-serif; color: #1f2328; background: #fff; overflow-wrap: anywhere; }
main { max-width: 760px; margin: 0 auto; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; margin: 12px 0; }
td, th { border: 1px solid #d0d7de; padding: 4px 8px; vertical-align: top; }
td > p, th > p { margin: 0; }
</style>`;

type Drawn = { loading: true } | { error: string } | { done: true; pages?: number };

/** A PDF or Word file the Preview draws itself (ADR 0186), or why it couldn't. */
export function DocumentView({ format, bytes, name, size }: { format: DocumentFormat; bytes: Uint8Array; name: string; size: number }) {
  const [state, setState] = useState<Drawn>({ loading: true });
  const [html, setHtml] = useState<string>();
  const pages = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    let destroy = () => {};
    const failed = (e: unknown) => live && setState({ error: errorText(e) });
    import("./documentRender").then(async ({ openPdf, docxHtml }) => {
      if (format === "docx") {
        const body = await docxHtml(bytes);
        if (live) (setHtml(body), setState({ done: true }));
        return;
      }
      const task = openPdf(bytes);
      destroy = () => void task.destroy();
      if (!live) return destroy();
      const pdf = await task.promise;
      setState({ done: true, pages: pdf.numPages });
      const into = pages.current;
      for (let n = 1; n <= Math.min(pdf.numPages, PDF_MAX_PAGES) && live && into; n++) {
        const page = await pdf.getPage(n);
        const width = (into.clientWidth || 800) * (window.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `Page ${n} of ${pdf.numPages}`);
        into.append(canvas);
        await page.render({ canvas, viewport }).promise;
      }
    }).catch(failed);
    return () => {
      live = false;
      destroy();
    };
  }, [format, bytes]);

  if ("error" in state)
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">Couldn't show this document</div>
          <div>{state.error}</div>
        </div>
      </div>
    );
  const cut = "pages" in state && state.pages !== undefined && state.pages > PDF_MAX_PAGES;
  return (
    <div className="preview-text">
      <div className="preview-bar">
        <span className="preview-foot">
          {format === "pdf" ? "PDF" : "Word document"} · {formatBytes(size)}
          {"pages" in state && state.pages !== undefined && ` · ${state.pages} ${state.pages === 1 ? "page" : "pages"}`}
        </span>
        {cut && <span className="preview-truncated">Showing the first {PDF_MAX_PAGES} pages.</span>}
      </div>
      {"loading" in state && (
        <div className="preview-state" role="status">
          <Spinner /> Drawing {name.split("/").pop()}…
        </div>
      )}
      {format === "pdf" ? (
        <div className="preview-pdf" ref={pages} />
      ) : (
        html !== undefined && (
          <iframe className="preview-frame doc" title={`Rendered ${name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={sandboxedHtml(DOCX_STYLE + html)} />
        )
      )}
    </div>
  );
}
