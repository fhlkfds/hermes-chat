// Tags and Saved filters kept on this computer (tags.ts, ADR 0026): ids that survive renames, names compared without
// case, one write per change, and each connection and profile kept apart.
import { describe, expect, it } from "vitest";
import { TAGS_KEY, TagsStore, previewBulk } from "./tags";
import { projectScope } from "./projectLinks";

const conn = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
const DEFAULT = projectScope(conn, "default");
const WORK = projectScope(conn, "work");

/** A Storage double; `full` makes every write fail, as a full localStorage does. */
function memory() {
  const data = new Map<string, string>();
  return {
    full: false,
    writes: 0,
    getItem: (k: string) => data.get(k) ?? null,
    setItem(k: string, v: string) {
      if (this.full) throw new Error("The quota has been exceeded.");
      this.writes++;
      data.set(k, v);
    },
  };
}

const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};

describe("Tags", () => {
  it("creates, renames and deletes a tag by its id, keeping the chats it is on through a rename", () => {
    const store = new TagsStore(memory(), DEFAULT, ids());
    const tag = store.createTag("  Work   stuff ");
    expect(tag).toEqual({ id: "id1", name: "Work stuff" });
    store.setTag(["a", "b"], tag.id, true);

    store.renameTag(tag.id, "Job");
    expect(store.getSnapshot().tags).toEqual([{ id: "id1", name: "Job" }]);
    expect(store.tagsOf("a")).toEqual(["id1"]);

    store.deleteTag(tag.id);
    expect(store.getSnapshot()).toMatchObject({ tags: [], chats: {} });
  });

  it("refuses a name another tag has, whatever its case or Unicode form, but lets a tag change its own case", () => {
    const store = new TagsStore(memory(), DEFAULT, ids());
    const ete = store.createTag("Été");
    expect(() => store.createTag("été")).toThrow('There\'s already a tag called "Été".');
    // The same letters, decomposed: E + combining acute.
    expect(() => store.createTag("Été")).toThrow("already a tag");
    expect(() => store.createTag("   ")).toThrow("Give the tag a name.");
    expect(() => store.createTag("x".repeat(41))).toThrow("40 characters");
    store.renameTag(ete.id, "ÉTÉ");
    expect(store.getSnapshot().tags[0].name).toBe("ÉTÉ");
    const other = store.createTag("Ete");
    expect(() => store.renameTag(other.id, "été")).toThrow("already a tag");
  });

  it("keeps emoji and other scripts, and refuses characters that reorder text", () => {
    const store = new TagsStore(memory(), DEFAULT, ids());
    for (const name of ["🚀 launch", "👩‍💻 dev", "日本語", "Ελληνικά"]) store.createTag(name);
    expect(store.getSnapshot().tags.map((t) => t.name)).toEqual(["🚀 launch", "👩‍💻 dev", "日本語", "Ελληνικά"]);
    expect(() => store.createTag("evil‮gnp")).toThrow("can't have");
    // 40 emoji count as 40 characters, not 80 UTF-16 units.
    expect(store.createTag("🙂".repeat(40)).name).toHaveLength(80);
  });

  it("is still there for a new store on the same computer, and kept apart for each profile", () => {
    const storage = memory();
    const a = new TagsStore(storage, DEFAULT, ids());
    a.setTag(["chat1"], a.createTag("Backups").id, true);
    a.saveFilter("Backup chats", { tags: ["id1"], text: "restic" });

    const again = new TagsStore(storage, DEFAULT);
    expect(again.getSnapshot()).toEqual({
      tags: [{ id: "id1", name: "Backups" }],
      chats: { chat1: ["id1"] },
      filters: [{ id: "id2", name: "Backup chats", filter: { text: "restic", tags: ["id1"] } }],
    });
    const work = new TagsStore(storage, WORK, ids());
    expect(work.getSnapshot()).toMatchObject({ tags: [], chats: {}, filters: [] });
    // The same name is fine in another profile, and changing it there leaves this one alone.
    work.createTag("Backups");
    work.deleteTag("id1");
    expect(new TagsStore(storage, DEFAULT).getSnapshot().tags).toEqual([{ id: "id1", name: "Backups" }]);
  });

  it("keeps another window's change when it writes its own", () => {
    const storage = memory();
    const one = new TagsStore(storage, DEFAULT, () => "t1");
    const two = new TagsStore(storage, DEFAULT, () => "t2");
    one.createTag("One");
    two.createTag("Two");
    one.reread();
    expect(one.getSnapshot().tags.map((t) => t.name)).toEqual(["One", "Two"]);
  });

  it("ignores a stored document it can't read, and tags a stored chat has that no longer exist", () => {
    const storage = memory();
    storage.setItem(TAGS_KEY, "{not json");
    expect(new TagsStore(storage, DEFAULT).getSnapshot().tags).toEqual([]);
    storage.setItem(TAGS_KEY, JSON.stringify({ v: 1, scopes: { [DEFAULT]: { tags: [{ id: "a", name: "A" }, { id: "b", name: "a" }], chats: { c: ["a", "gone"] } } } }));
    expect(new TagsStore(storage, DEFAULT).getSnapshot()).toEqual({ tags: [{ id: "a", name: "A" }], chats: { c: ["a"] }, filters: [] });
  });
});

describe("A bulk tag edit", () => {
  it("previews which chats change, and applies only those, in one write", () => {
    const storage = memory();
    const store = new TagsStore(storage, DEFAULT, ids());
    const tag = store.createTag("Infra");
    store.setTag(["b"], tag.id, true);

    const add = previewBulk(store.getSnapshot(), ["a", "b", "c", "a"], tag.id, true);
    expect(add).toMatchObject({ change: ["a", "c"], unchanged: ["b"] });
    const before = storage.writes;
    store.applyBulk(add);
    expect(storage.writes).toBe(before + 1);
    expect(["a", "b", "c"].map(store.tagsOf)).toEqual([[tag.id], [tag.id], [tag.id]]);

    const remove = previewBulk(store.getSnapshot(), ["a", "z"], tag.id, false);
    expect(remove).toMatchObject({ change: ["a"], unchanged: ["z"] });
    store.applyBulk(remove);
    expect(store.getSnapshot().chats).toEqual({ b: [tag.id], c: [tag.id] });
  });

  it("changes nothing when it can't be saved, rather than some of the chats", () => {
    const storage = memory();
    const store = new TagsStore(storage, DEFAULT, ids());
    const tag = store.createTag("Infra");
    const stored = storage.getItem(TAGS_KEY);
    const snapshot = store.getSnapshot();

    storage.full = true;
    expect(() => store.applyBulk(previewBulk(snapshot, ["a", "b", "c"], tag.id, true))).toThrow("Couldn't save on this computer, so nothing changed");
    expect(store.getSnapshot()).toBe(snapshot);
    expect(storage.getItem(TAGS_KEY)).toBe(stored);
  });

  it("is refused if the tag was deleted after the preview", () => {
    const storage = memory();
    const store = new TagsStore(storage, DEFAULT, ids());
    const tag = store.createTag("Infra");
    const preview = previewBulk(store.getSnapshot(), ["a"], tag.id, true);
    new TagsStore(storage, DEFAULT).deleteTag(tag.id);
    expect(() => store.applyBulk(preview)).toThrow("That tag was deleted.");
    expect(store.getSnapshot().tags).toEqual([]);
    expect(store.getSnapshot().chats).toEqual({});
  });
});

describe("Saved filters", () => {
  it("refuses a name another saved filter has, and keeps a deleted tag's id so the filter can say so", () => {
    const store = new TagsStore(memory(), DEFAULT, ids());
    const tag = store.createTag("Infra");
    store.saveFilter("Infra this month", { tags: [tag.id], from: "2026-10-01", text: "  " });
    expect(() => store.saveFilter("INFRA THIS MONTH", {})).toThrow('already a saved filter called "Infra this month"');
    store.deleteTag(tag.id);
    expect(store.getSnapshot().filters[0].filter).toEqual({ tags: [tag.id], from: "2026-10-01" });
    store.deleteFilter("id2");
    expect(store.getSnapshot().filters).toEqual([]);
  });
});
