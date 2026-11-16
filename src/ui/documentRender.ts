// The libraries that draw a document (ADR 0186), loaded only when one is opened: about 2 MB the app otherwise skips.
import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth/mammoth.browser.js";

GlobalWorkerOptions.workerSrc = workerUrl;

/** A copy of `bytes` the library may take: pdf.js moves its buffer to the worker, which would empty the view's own. */
const copy = (bytes: Uint8Array) => bytes.slice().buffer;

/** A PDF being parsed in pdf.js's worker. The caller destroys the task, which ends the worker. */
export const openPdf = (bytes: Uint8Array): PDFDocumentLoadingTask => getDocument({ data: copy(bytes) });

/**
 * A Word document's body as HTML, its pictures inline as `data:` URLs. mammoth never reads files the document links to
 * (`externalFileAccess` is off by default), and the HTML goes in a sandboxed frame (`sandboxedHtml`).
 */
export const docxHtml = async (bytes: Uint8Array): Promise<string> => (await mammoth.convertToHtml({ arrayBuffer: copy(bytes) })).value;
