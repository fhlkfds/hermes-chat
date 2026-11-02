import { describe, expect, it } from "vitest";
import { filePaths } from "./clipboard";

describe("Files copied in a file manager", () => {
  it("reads their local paths from the uri-list, decoded", () => {
    expect(filePaths("file:///home/liam/Pictures/rack.png\r\nfile:///home/liam/notes/disk%20report.txt\r\n")).toEqual([
      "/home/liam/Pictures/rack.png",
      "/home/liam/notes/disk report.txt",
    ]);
  });

  it("skips comments, web links and files on other hosts", () => {
    expect(filePaths("# copied\nhttps://example.com/a.png\nfile://nas/share/b.png\nfile://localhost/tmp/c.png")).toEqual(["/tmp/c.png"]);
  });

  it("finds nothing in an empty clipboard", () => {
    expect(filePaths("")).toEqual([]);
  });
});
