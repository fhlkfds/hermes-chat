import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { documentFormatOf, looksLike, zipUnpacked } from "./documents";
import { fakeZip } from "./fakeZip";

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

  it("counts what a zip unpacks to, and nothing from what isn't one", async () => {
    // What Python's zipfile sums for the same file.
    expect(await zipUnpacked(plan, 1e6)).toBe(2986);
    expect(await zipUnpacked(new TextEncoder().encode("PK\x03\x04 not really"), 1e6)).toBeUndefined();
    expect(await zipUnpacked(new Uint8Array(3), 1e6)).toBeUndefined();
    // A comment after the end record moves it; the sizes read the same.
    const commented = new Uint8Array([...plan.slice(0, -2), 5, 0, ...new TextEncoder().encode("hello")]);
    expect(await zipUnpacked(commented, 1e6)).toBe(2986);
  });

  it("stops unpacking past the limit, whatever the zip's directory says", async () => {
    const big = new Uint8Array(3000);
    expect(await zipUnpacked(await fakeZip([{ name: "a.xml", data: big }]), 2999)).toBe("over");
    expect(await zipUnpacked(await fakeZip([{ name: "a.xml", data: big, claims: 10 }]), 2999)).toBe("over");
    expect(await zipUnpacked(await fakeZip([{ name: "a.xml", data: big, claims: 10 }]), 3000)).toBe(3000);
    const half = big.slice(0, 2000);
    expect(await zipUnpacked(await fakeZip([{ name: "a.xml", data: half }, { name: "b.xml", data: half }]), 3999)).toBe("over");
  });
});
