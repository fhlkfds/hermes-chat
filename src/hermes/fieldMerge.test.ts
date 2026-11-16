// The conflict rule of a field save (fieldMerge.ts, ADR 0188), without a transport: what is written, what is left
// alone because it changed elsewhere, and where a dialog's base may move after a save.
import { describe, expect, it } from "vitest";
import { allSaved, editsOf, plan, rebase, settle, type Same } from "./fieldMerge";

type Look = { title: string; color: string | null; pinned: boolean };
const SAME: Same<Look> = {
  title: (a, b) => a.trim() === b.trim(),
  color: (a, b) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase(),
  pinned: (a, b) => a === b,
};
const shown: Look = { title: "Scribe", color: "#112233", pinned: false };

describe("the edits a form holds", () => {
  it("are the fields whose input differs from what the owner was shown, by the family's own equality", () => {
    expect(editsOf(shown, { title: " Scribe ", color: "#112233".toUpperCase(), pinned: false }, SAME)).toEqual({});
    expect(editsOf(shown, { title: "Writer", color: null, pinned: false }, SAME)).toEqual({
      title: { from: "Scribe", to: "Writer" },
      color: { from: "#112233", to: null },
    });
  });
});

describe("the conflict rule, for one edited field", () => {
  const edits = { title: { from: "Scribe", to: "Writer" } };

  it("writes the field when Hermes still has what the owner was shown", () => {
    expect(plan(edits, shown, SAME)).toEqual({ write: { title: "Writer" }, settled: {} });
  });

  it("sends nothing and counts it saved when Hermes already has what the owner asked for", () => {
    expect(plan(edits, { ...shown, title: "Writer" }, SAME)).toEqual({ write: {}, settled: { title: { kind: "saved" } } });
  });

  it("sends nothing and reports Hermes's value when Hermes has anything else", () => {
    expect(plan(edits, { ...shown, title: "Quill" }, SAME)).toEqual({ write: {}, settled: { title: { kind: "changedElsewhere", theirs: "Quill" } } });
  });

  it("never looks at a field the owner didn't change", () => {
    expect(plan(edits, { title: "Scribe", color: "#ffffff", pinned: true }, SAME)).toEqual({ write: { title: "Writer" }, settled: {} });
  });

  it("can't conflict on a switch: Hermes has either what was shown or what was asked for", () => {
    const pin = { pinned: { from: false, to: true } };
    expect(plan(pin, shown, SAME)).toEqual({ write: { pinned: true }, settled: {} });
    expect(plan(pin, { ...shown, pinned: true }, SAME)).toEqual({ write: {}, settled: { pinned: { kind: "saved" } } });
  });
});

describe("settling a save against what Hermes has afterwards", () => {
  const edits = { title: { from: "Scribe", to: "Writer" } };
  const lost = { kind: "failed", failure: { kind: "lost", message: "no answer" } } as const;

  it("counts a write whose answer was lost as saved once Hermes has it", () => {
    expect(settle({ title: lost }, edits, { ...shown, title: "Writer" }, SAME)).toEqual({ title: { kind: "saved" } });
    expect(settle({ title: lost }, edits, shown, SAME)).toEqual({ title: lost });
  });

  it("shows Hermes's value in place of a saved one somebody wrote over", () => {
    expect(settle({ title: { kind: "saved" } }, edits, { ...shown, title: "Ink" }, SAME)).toEqual({ title: { kind: "changedElsewhere", theirs: "Ink" } });
    expect(settle({ title: { kind: "saved" } }, edits, { ...shown, title: "Writer" }, SAME)).toEqual({ title: { kind: "saved" } });
  });

  it("judges a field Hermes respells by what it keeps, and still shows a real change made after the write", () => {
    const sameWord = { title: (a: string, b: string) => a.replace(/^custom:/, "").toLowerCase() === b.toLowerCase() };
    expect(settle({ title: { kind: "saved" } }, edits, { ...shown, title: "custom:writer" }, SAME, sameWord)).toEqual({ title: { kind: "saved" } });
    expect(settle({ title: { kind: "saved" } }, edits, { ...shown, title: "custom:quill" }, SAME, sameWord)).toEqual({ title: { kind: "changedElsewhere", theirs: "custom:quill" } });
  });

  it("leaves a refusal as it is, and every outcome when nothing was read back", () => {
    const refused = { kind: "failed", failure: { kind: "refused", status: 400, detail: "no" } } as const;
    expect(settle({ title: refused }, edits, { ...shown, title: "Writer" }, SAME)).toEqual({ title: refused });
    expect(settle({ title: { kind: "saved" } }, edits, undefined, SAME)).toEqual({ title: { kind: "saved" } });
    expect(settle({ title: { kind: "saved" } }, edits, { color: null }, SAME)).toEqual({ title: { kind: "saved" } });
  });
});

describe("a dialog's base after a save", () => {
  const form: Look = { title: "Writer", color: "#445566", pinned: false };

  it("moves the base only to values the owner was shown", () => {
    const next = rebase(shown, form, {
      fields: { title: { kind: "changedElsewhere", theirs: "Quill" }, color: { kind: "failed", failure: { kind: "lost", message: "no answer" } } },
      now: { title: "Ink", color: "#000000", pinned: true },
    });
    // The conflict note showed "Quill", so that is the base, and the owner's text stays. Hermes's later "Ink" was
    // never shown, so the next Save still finds it changed.
    expect(next.base.title).toBe("Quill");
    expect(next.form.title).toBe("Writer");
    // A failed field showed nothing newer: neither moves.
    expect(next.base.color).toBe("#112233");
    expect(next.form.color).toBe("#445566");
    // A field left alone shows what Hermes has now.
    expect(next.base.pinned).toBe(true);
    expect(next.form.pinned).toBe(true);
  });

  it("shows Hermes's value in a saved field, and keeps the owner's own when nothing was read back", () => {
    expect(rebase(shown, form, { fields: { title: { kind: "saved" } }, now: { title: "Writer ", color: "#112233", pinned: false } })).toEqual({
      base: { title: "Writer ", color: "#112233", pinned: false },
      form: { title: "Writer ", color: "#112233", pinned: false },
    });
    expect(rebase(shown, form, { fields: { title: { kind: "saved" } } })).toEqual({ base: { ...shown, title: "Writer" }, form });
  });

  it("makes a second Save with nothing new on the server write nothing", () => {
    const now: Look = { title: "Writer", color: "#445566", pinned: false };
    const first = plan(editsOf(shown, form, SAME), shown, SAME);
    expect(first.write).toEqual({ title: "Writer", color: "#445566" });
    const next = rebase(shown, form, { fields: { title: { kind: "saved" }, color: { kind: "saved" } }, now });
    expect(editsOf(next.base, next.form, SAME)).toEqual({});
  });
});

describe("whether a save is done", () => {
  it("needs every edit saved; a conflict is not saved", () => {
    expect(allSaved<Look>({ fields: {} })).toBe(true);
    expect(allSaved<Look>({ fields: { title: { kind: "saved" }, pinned: { kind: "saved" } } })).toBe(true);
    expect(allSaved<Look>({ fields: { title: { kind: "saved" }, color: { kind: "changedElsewhere", theirs: null } } })).toBe(false);
  });
});
