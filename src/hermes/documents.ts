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
 * What a zip archive says its files unpack to, in all, from its central directory; undefined when it isn't a zip this
 * can read (no end record, or a Zip64 archive, whose sizes are elsewhere).
 */
export function zipUnpackedSize(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  // The end record is the last 22 bytes, unless a comment of up to 64 KB follows it.
  while (end >= Math.max(0, bytes.length - 22 - 0xffff) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 22 - 0xffff) return undefined;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return undefined;
    const size = view.getUint32(at + 24, true);
    if (size === 0xffffffff) return undefined;
    total += size;
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return total;
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
