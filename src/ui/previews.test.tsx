import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Attachment } from "../hermes/model";
import { AttachmentChip, Previews } from "./previews";

const img = (path: string): Attachment => ({ path, name: path.split("/").pop()!, size: 9, kind: "image" });
const file = (path: string): Attachment => ({ ...img(path), kind: "file" });
const rack = img("/home/liam/Pictures/rack.png");
// Where PR #9 saves a pasted screenshot: previews go by path, so it is staged like any other image.
const pasted = img("/home/liam/.cache/net.l0cky12.hermes-chat/pasted/a1/Pasted image 14.03.22.png");

/** Previews over an in-memory disk: `disk` maps a path to its bytes, or to the error reading it gives. */
function setUp(disk: Record<string, string | Error>) {
  const live = new Set<string>();
  const reads: string[] = [];
  let n = 0;
  let changes = 0;
  // Each read waits until `land()`, so tests can unstage an image while it is being read.
  let landing: (() => void)[] = [];
  const previews = new Previews(
    (path) => {
      reads.push(path);
      return new Promise((resolve, reject) =>
        landing.push(() => {
          const d = disk[path] ?? new Error("No such file or directory (os error 2)");
          if (d instanceof Error) reject(d);
          else resolve(new Blob([d]));
        }),
      );
    },
    () => changes++,
    {
      createObjectURL: () => {
        const url = `blob:preview-${++n}`;
        live.add(url);
        return url;
      },
      revokeObjectURL: (url) => void live.delete(url),
    },
  );
  const land = async () => {
    const pending = landing;
    landing = [];
    pending.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 0));
  };
  return { previews, live, reads, land, changes: () => changes };
}

describe("Image previews in the composer", () => {
  it("reads a thumbnail for each staged image, including a pasted one, and none for other files", async () => {
    const { previews, live, reads, land, changes } = setUp({ [rack.path]: "\x89PNG", [pasted.path]: "\x89PNG" });
    previews.sync([rack, file("/home/liam/notes.txt"), pasted]);
    await land();

    expect(reads).toEqual([rack.path, pasted.path]);
    expect(previews.get(rack.path)).toEqual({ url: "blob:preview-1" });
    expect(previews.get(pasted.path)).toEqual({ url: "blob:preview-2" });
    expect(previews.get("/home/liam/notes.txt")).toBeUndefined();
    expect(live.size).toBe(2);
    expect(changes()).toBe(2);
  });

  it("reads each image once, however often the staged list changes", async () => {
    const { previews, reads, land } = setUp({ [rack.path]: "\x89PNG" });
    previews.sync([rack]);
    previews.sync([rack]);
    await land();
    previews.sync([rack, file("/tmp/a.txt")]);
    await land();
    expect(reads).toEqual([rack.path]);
  });

  it("gives a missing, unreadable or oversized image a reason instead of a thumbnail, and still previews the rest", async () => {
    const big = img("/home/liam/big.png");
    const secret = img("/home/liam/id_rsa.png");
    const { previews, live, land } = setUp({
      [rack.path]: "\x89PNG",
      [big.path]: new Error("it's 26.0 MB now, over the 25 MB limit"),
      [secret.path]: new Error("it isn't an image"),
    });
    previews.sync([img("/home/liam/gone.png"), big, secret, rack]);
    await land();

    expect(previews.get("/home/liam/gone.png")).toEqual({ error: "No such file or directory (os error 2)" });
    expect(previews.get(big.path)).toEqual({ error: "it's 26.0 MB now, over the 25 MB limit" });
    expect(previews.get(secret.path)).toEqual({ error: "it isn't an image" });
    expect(previews.get(rack.path)).toEqual({ url: "blob:preview-1" });
    expect(live.size).toBe(1);
  });

  it("releases a thumbnail when its image is removed", async () => {
    const { previews, live, land } = setUp({ [rack.path]: "\x89PNG", [pasted.path]: "\x89PNG" });
    previews.sync([rack, pasted]);
    await land();
    previews.sync([pasted]);

    expect(previews.get(rack.path)).toBeUndefined();
    expect([...live]).toEqual(["blob:preview-2"]);
  });

  it("releases every thumbnail when the message is sent", async () => {
    const { previews, live, land } = setUp({ [rack.path]: "\x89PNG", [pasted.path]: "\x89PNG" });
    previews.sync([rack, pasted]);
    await land();
    previews.sync([]);
    expect(live.size).toBe(0);
  });

  it("reads a replaced image afresh, releasing the old thumbnail", async () => {
    const disk: Record<string, string> = { [rack.path]: "\x89PNG old" };
    const { previews, live, reads, land } = setUp(disk);
    previews.sync([rack]);
    await land();
    previews.sync([]);
    disk[rack.path] = "\x89PNG new";
    previews.sync([rack]);
    await land();

    expect(reads).toEqual([rack.path, rack.path]);
    expect(previews.get(rack.path)).toEqual({ url: "blob:preview-2" });
    expect([...live]).toEqual(["blob:preview-2"]);
  });

  it("releases a thumbnail that finishes reading after its image was removed or swapped", async () => {
    const { previews, live, land, changes } = setUp({ [rack.path]: "\x89PNG", [pasted.path]: "\x89PNG" });
    previews.sync([rack, pasted]);
    previews.sync([pasted]);
    previews.sync([rack, pasted]);
    await land();

    // The first read of rack landed after it was unstaged; only the second one's URL is kept.
    expect(live.size).toBe(2);
    expect(previews.get(rack.path)).toEqual({ url: expect.stringMatching(/^blob:/) });
    expect(changes()).toBe(2);
  });

  it("releases every thumbnail on unmount, including ones still being read", async () => {
    const { previews, live, land, changes } = setUp({ [rack.path]: "\x89PNG", [pasted.path]: "\x89PNG" });
    previews.sync([rack]);
    await land();
    previews.sync([rack, pasted]);
    previews.dispose();
    await land();

    expect(live.size).toBe(0);
    expect(changes()).toBe(1);
  });
});

describe("Attachment chips", () => {
  const html = (el: React.ReactElement) => renderToStaticMarkup(el);

  it("shows the thumbnail with the image's name and size", () => {
    const out = html(<AttachmentChip file={rack} preview={{ url: "blob:preview-1" }} onRemove={() => {}} />);
    expect(out).toContain('<img class="chip-thumb" src="blob:preview-1" alt=""/>');
    expect(out).toContain("rack.png");
    expect(out).toContain("9 B");
    expect(out).toContain('title="Remove"');
  });

  it("falls back to a paperclip and says why when there is no preview", () => {
    const out = html(<AttachmentChip file={rack} preview={{ error: "No such file or directory (os error 2)" }} onRemove={() => {}} />);
    expect(out).not.toContain("<img");
    expect(out).toContain("lucide-paperclip");
    expect(out).toContain(`title="${rack.path}\nNo preview: No such file or directory (os error 2)"`);
  });

  it("shows a paperclip while the thumbnail is read, and for files that aren't images", () => {
    for (const f of [rack, file("/home/liam/notes.txt")]) {
      const out = html(<AttachmentChip file={f} onRemove={() => {}} />);
      expect(out).not.toContain("<img");
      expect(out).toContain("lucide-paperclip");
      expect(out).toContain(`title="${f.path}"`);
    }
  });
});
