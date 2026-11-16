// The document formats the Preview draws itself (ADR 0186): a PDF page by page with pdf.js, a Word file converted to
// HTML by mammoth. Each is known by its name or type and checked by its first bytes, since both come from files the
// owner didn't make.

export type DocumentFormat = "pdf" | "docx";

const FORMATS: Record<DocumentFormat, { extension: string; mime: string; magic: number[]; what: string }> = {
  pdf: { extension: "pdf", mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46, 0x2d], what: "a PDF" },
  // A .docx is a zip archive; mammoth says so when the archive inside isn't a Word document.
  docx: {
    extension: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    magic: [0x50, 0x4b, 0x03, 0x04],
    what: "a Word document",
  },
};

/** The most of a document the Preview reads: Hermes's own limit for a file it previews as an image. */
export const DOCUMENT_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

const formats = Object.keys(FORMATS) as DocumentFormat[];

/** The document format a file is, by its extension or else its type. */
export function documentFormatOf(name: string, mime?: string): DocumentFormat | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  return formats.find((f) => FORMATS[f].extension === ext) ?? formats.find((f) => FORMATS[f].mime === mime?.toLowerCase());
}

/** Whether `bytes` start the way a file of `format` does. */
export const looksLike = (format: DocumentFormat, bytes: Uint8Array) => FORMATS[format].magic.every((b, i) => bytes[i] === b);

/** Why bytes named as `format` can't be shown as it. */
export const notA = (format: DocumentFormat) => `This file is named like ${FORMATS[format].what}, but its bytes aren't one.`;

/** The most a Word file may unpack to before mammoth opens it: a small zip can unpack to gigabytes. */
export const DOCX_UNPACKED_MAX_BYTES = 100 * 1024 * 1024;

/**
 * What a zip archive's files unpack to, in all, counted by unpacking them, since its directory's sizes can lie: the
 * number, or `over` as soon as it passes `max`, or undefined when it isn't a zip this can read (no end record, a
 * directory that doesn't end where the end record says, Zip64, or a method other than stored or deflated, which a
 * Word file never uses). Each file is the bytes the zip's directory points at, as mammoth's unzip reads them.
 */
export async function zipUnpacked(bytes: Uint8Array, max: number): Promise<number | "over" | undefined> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  let end = bytes.length - 22;
  // The end record is the last 22 bytes, unless a comment of up to 64 KB follows it.
  while (end >= Math.max(0, bytes.length - 22 - 0xffff) && u32(end) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 22 - 0xffff) return undefined;
  let at = u32(end + 16);
  // mammoth's unzip moves every offset by however far the directory's offset and size miss the end record.
  if (at + u32(end + 12) !== end) return undefined;
  let total = 0;
  // Every entry up to the end record, not the count the end record gives, since mammoth's unzip reads them all.
  for (; at + 46 <= end && u32(at) === 0x02014b50; at += 46 + u16(at + 28) + u16(at + 30) + u16(at + 32)) {
    const [method, packed, local] = [u16(at + 10), u32(at + 20), u32(at + 42)];
    if (local + 30 > bytes.length || u32(local) !== 0x04034b50) return undefined;
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    const data = bytes.subarray(start, start + packed);
    if (method === 0) total += data.length;
    else if (method !== 8) return undefined;
    else {
      const source = new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (c) => (c.enqueue(data.slice()), c.close()) });
      const reader = source.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
      try {
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
          total += r.value.length;
          if (total > max) return "over";
        }
      } catch {
        return undefined;
      } finally {
        void reader.cancel().catch(() => {});
      }
    }
    if (total > max) return "over";
  }
  return at === end ? total : undefined;
}

/** The bytes of a base64 `data:` URL, or undefined when it isn't one. */
export function dataUrlBytes(url: string): Uint8Array | undefined {
  const m = /^data:[^,]*;base64,/.exec(url);
  if (!m) return undefined;
  try {
    return Uint8Array.from(atob(url.slice(m[0].length)), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}
