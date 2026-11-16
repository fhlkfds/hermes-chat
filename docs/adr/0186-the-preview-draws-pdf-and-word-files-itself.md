# The Preview draws PDF and Word files itself

> **Accepted.** The formats are the table in `src/hermes/documents.ts`. `src/hermes/preview.ts` reads them (`readServerFile`, `hostFileView`, `readLocalFile`), `src/hermes/remoteFiles.ts` reads them for Server files (`previewSupport`, `parseRead`), and Rust reads a picked one (`PickedFiles::read_document`, `preview_read_local_document`). `src/ui/DocumentView.tsx` draws them, with the libraries loaded on first use from `src/ui/documentRender.ts`, and `pdfjsAssets` in `vite.config.ts` puts pdf.js's own files in the app. Tested in `src/hermes/documents.test.ts`, `src/hermes/preview.test.ts`, `src/hermes/remoteFiles.test.ts`, `src/ui/previewPane.test.tsx`, `e2e/features/preview-documents.e2e.tsx` and `src-tauri/tests/transport.rs`.

The owner opened a Word file in the Preview and got "No preview for this file. The preview can't show application/vnd.openxmlformats-officedocument.wordprocessingml.document files." A PDF said the same. Hermes makes these files for the owner (reports, letters, exported plans), and the Preview showed only text, Markdown, HTML and images. The owner asked to see documents and pictures there without leaving the app.

## Decisions

- **A PDF is drawn page by page with pdf.js.** Each page is a canvas as wide as the pane, labelled "Page n of m". At most the first 100 pages are drawn, and the bar above says so. WebKitGTK, the Linux webview, has no PDF viewer of its own, so a frame pointed at the file would stay blank there. pdf.js reads its image decoders (JPEG 2000 and JBIG2, which scanners use), the standard fonts a PDF names without embedding, CMaps and ICC profiles by file name from folders, so the app carries them at `/pdfjs/`: about 4 MB, loaded only by a PDF that needs them.
- **A Word file (`.docx`) is converted to HTML by mammoth** and shown in the same frame an HTML file renders in: every sandbox flag off and a policy that loads nothing from the network (`sandboxedHtml`). Pictures in the document come inline as `data:` URLs, which that policy allows. mammoth never opens files the document links to. A Word file is a zip, and a small zip can unpack to gigabytes. Before mammoth opens it, the Preview unpacks each file in it as a stream and counts the bytes, and stops at 100 MB, since a zip's own directory can understate its sizes. One past that isn't opened.
- **A file is taken as a document by its extension, or else by the type Hermes or the Server files listing gives.** Its first bytes must then match (`%PDF-` for a PDF, a zip header for a Word file), or the Preview says the file is named like a PDF or a Word document but isn't one. mammoth also refuses a zip that isn't a Word document, which shows as "Couldn't show this document".
- **The bytes come whole, up to 25 MB.** A Server file is read through `GET /api/fs/read-data-url`, which Hermes serves for any file within its own limit, so a document makes one request and never the `read-text` one. A file on the dashboard's machine is read through `GET /api/files/read`, as an image is. A file picked on this computer is read by Rust from the handle the Open dialog kept (ADR 0129's rule: the webview never names a path), and Rust checks its first bytes too.
- **The libraries load only when a document opens.** pdf.js, its worker and mammoth are about 2 MB, which the app doesn't parse at start.
- **The Server files screen shows documents the same way**, since its preview reads through the same route.

## Considered options

- **A frame pointed at the PDF.** WebView2 on Windows draws it, and WebKitGTK shows nothing.
- **Opening documents in the owner's default app.** It leaves the app, and for a Server file it needs the file downloaded first. Download already does that.
- **Rendering Word files to HTML on the server.** Hermes has no route for it.
- **Other office formats now** (`.xlsx`, `.pptx`, `.odt`, legacy `.doc`). No small, well-kept browser library reads them safely: the maintained SheetJS build isn't on npm, and the npm one has open advisories. They still say "No preview for this file".

## Consequences

- A PDF's text can't be selected or searched in the pane. Each page is a picture of the page.
- A PDF that names a font it doesn't embed, other than the standard PDF fonts pdf.js carries, is drawn with this computer's fonts, which can differ from the original.
- A Word document shows its text, headings, lists, tables and pictures, but not its page layout, headers, footers or exact fonts.
- A Word file is unpacked twice, once to count and once by mammoth. mammoth's conversion runs on the page's thread and can't be stopped part way: closing the Preview drops its result.
