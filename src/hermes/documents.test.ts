import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { documentFormatOf, looksLike, zipUnpackedSize } from "./documents";

const plan = new Uint8Array(readFileSync("src/ui/fixtures/plan.docx"));

describe("Document formats", () => {
  it("knows a PDF or Word file by its name, or else its type", () => {
    expect(documentFormatOf("/srv/Report.PDF")).toBe("pdf");
    expect(documentFormatOf("plan.docx")).toBe("docx");
    expect(documentFormatOf("download", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(documentFormatOf("old.doc")).toBeUndefined();
    expect(documentFormatOf("pdf")).toBeUndefined();
  });

  it("checks the first bytes", () => {
    expect(looksLike("docx", plan)).toBe(true);
    expect(looksLike("pdf", plan)).toBe(false);
  });

  it("reads what a zip says it unpacks to, and nothing from what isn't one", () => {
    // What Python's zipfile sums for the same file.
    expect(zipUnpackedSize(plan)).toBe(2986);
    expect(zipUnpackedSize(new TextEncoder().encode("PK\x03\x04 not really"))).toBeUndefined();
    expect(zipUnpackedSize(new Uint8Array(3))).toBeUndefined();
    // A comment after the end record moves it; the sizes read the same.
    const commented = new Uint8Array([...plan.slice(0, -2), 5, 0, ...new TextEncoder().encode("hello")]);
    expect(zipUnpackedSize(commented)).toBe(2986);
  });
});
