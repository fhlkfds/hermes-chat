// The editor's text handling (textEdit.ts): what can be edited, byte-exact round trips, the diff and the merge.
import { describe, expect, it } from "vitest";
import { EDIT_MAX_BYTES, MINE_MARK, SPLIT_MARK, THEIRS_MARK, decodeForEdit, diffLines, encodeEdit, hunks, merge3, revisionOf } from "./textEdit";

const enc = (s: string) => new TextEncoder().encode(s);
const roundTrip = (s: string) => {
  const d = decodeForEdit(enc(s));
  if ("why" in d) throw new Error(d.why);
  return encodeEdit(d.text, d.eol, d.bom);
};

describe("which files can be edited", () => {
  it("round-trips LF, CRLF, a byte order mark and no final newline byte for byte", () => {
    for (const s of ["a\nb\n", "a\r\nb\r\n", "﻿café\r\nx", "no newline", "", "﻿"]) expect(roundTrip(s)).toBe(s);
    expect(decodeForEdit(enc("a\r\nb\r\n"))).toEqual({ text: "a\nb\n", eol: "\r\n", bom: false });
  });

  it("refuses what an edit would quietly change", () => {
    const why = (b: Uint8Array) => (decodeForEdit(b) as { why?: string }).why;
    expect(why(enc("a\r\nb\nc"))).toMatch(/mixes Windows/);
    expect(why(enc("a\rb"))).toMatch(/old Mac/);
    expect(why(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toMatch(/isn't UTF-8/);
    expect(why(Uint8Array.from([1, 0, 2]))).toMatch(/binary/);
    expect(why(new Uint8Array(EDIT_MAX_BYTES + 1).fill(65))).toMatch(/over 1 MB/);
  });

  it("names a revision by the bytes' SHA-256", async () => {
    expect(await revisionOf(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("diff", () => {
  const apply = (a: string[], ops: ReturnType<typeof diffLines>) => {
    const out: string[] = [];
    let i = 0;
    for (const o of ops) {
      if (o.op === "same") expect(o.text).toBe(a[i++]), out.push(o.text);
      else if (o.op === "del") expect(o.text).toBe(a[i++]);
      else out.push(o.text);
    }
    return out;
  };

  it("finds a minimal line diff that turns one text into the other", () => {
    const a = "a b c a b b a".split(" ");
    const b = "c b a b a c".split(" ");
    const ops = diffLines(a, b);
    expect(apply(a, ops)).toEqual(b);
    expect(ops.filter((o) => o.op !== "same")).toHaveLength(5);
    for (let seed = 1; seed < 200; seed++) {
      const rnd = (n: number) => Array.from({ length: (seed * 7) % n }, (_, i) => "xyz"[(seed * (i + 3)) % 3]);
      const x = rnd(13);
      const y = rnd(11).reverse();
      expect(apply(x, diffLines(x, y))).toEqual(y);
    }
  });

  it("shows changes with three lines of context, joining nearby ones", () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const b = [...a];
    b[1] = "changed 2";
    b[4] = "changed 5";
    b[16] = "changed 17";
    const h = hunks(diffLines(a, b));
    expect(h.map((x) => [x.oldStart, x.newStart, x.lines.length])).toEqual([
      [1, 1, 10],
      [14, 14, 8],
    ]);
  });
});

describe("merge", () => {
  const base = "one\ntwo\nthree\nfour\nfive\nsix\n";

  it("takes both sides' changes when they don't touch", () => {
    const mine = base.replace("two", "TWO");
    const theirs = base.replace("five", "FIVE");
    expect(merge3(base, mine, theirs)).toEqual({ text: "one\nTWO\nthree\nfour\nFIVE\nsix\n", conflicts: 0 });
    expect(merge3(base, mine, mine)).toEqual({ text: mine, conflicts: 0 });
    expect(merge3(base, base, theirs).text).toBe(theirs);
  });

  it("marks a stretch both sides changed differently, keeping both", () => {
    const got = merge3(base, base.replace("three", "mine"), base.replace("three", "theirs"));
    expect(got.conflicts).toBe(1);
    expect(got.text).toBe(`one\ntwo\n${MINE_MARK}\nmine\n${SPLIT_MARK}\ntheirs\n${THEIRS_MARK}\nfour\nfive\nsix\n`);
  });

  it("keeps lines both sides added at the end", () => {
    const got = merge3("a\n", "a\nmine\n", "a\ntheirs\n");
    expect(got.conflicts).toBe(1);
    expect(got.text).toContain("mine");
    expect(got.text).toContain("theirs");
  });

  it("never takes a deleted line and a blank one, or a lost final newline, as the same change", () => {
    expect(merge3("a\nb", "a", "a\n").conflicts).toBe(1);
    expect(merge3("a\nb\nc\n", "a\nc\n", "a\n\nc\n").conflicts).toBe(1);
    expect(merge3("a\n", "a", "a")).toEqual({ text: "a", conflicts: 0 });
  });

  it("never drops either side's change, checked across many small edits", () => {
    const words = ["x", "y", "", "z"];
    for (let seed = 1; seed < 400; seed++) {
      const r = (n: number) => (seed * 7919 + n * 104729) % 9973;
      const base = Array.from({ length: 6 }, (_, i) => words[r(i) % 4]);
      const edit = (k: number) => base.map((l, i) => (r(i + k) % 5 === 0 ? `${k}:${i}` : l)).filter((_, i) => r(i + k * 3) % 7 !== 0);
      const mine = edit(11).join("\n");
      const theirs = edit(23).join("\n");
      const got = merge3(base.join("\n"), mine, theirs);
      if (!got.conflicts) {
        // Each side's own lines are all there.
        for (const line of [...mine.split("\n"), ...theirs.split("\n")].filter((l) => l.includes(":"))) expect(got.text.split("\n")).toContain(line);
      }
      expect(merge3(base.join("\n"), mine, mine)).toEqual({ text: mine, conflicts: 0 });
    }
  });

  it("merges a file of 150,000 lines without running out of stack", () => {
    const base = Array.from({ length: 150_000 }, (_, i) => `l${i}`);
    const mine = [...base];
    mine[10] = "mine";
    const theirs = [...base];
    theirs[149_000] = "theirs";
    const got = merge3(base.join("\n"), mine.join("\n"), theirs.join("\n"));
    expect(got.conflicts).toBe(0);
    expect(got.text.split("\n")[10]).toBe("mine");
    expect(got.text.split("\n")[149_000]).toBe("theirs");
  });
});
