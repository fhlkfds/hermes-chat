// Templates as data: the placeholder format (missing values, literal braces, Unicode, multiline), what Insert does to a
// draft, saving checks, the export file, and imports of malformed files and taken names.
import { describe, expect, it } from "vitest";
import {
  BODY_MAX,
  EXPORT_FORMAT,
  TEMPLATES_MAX,
  exportFile,
  fieldsOf,
  freeName,
  insertInto,
  offeredHere,
  problemOf,
  readImport,
  render,
  toTemplates,
  unscope,
  type Template,
} from "./templates";

const t = (name: string, extra: Partial<Template> = {}): Template => ({ id: `id-${name}`, name, description: "", body: "Hi", ...extra });
let n = 0;
const ids = () => `new-${++n}`;

describe("The placeholder format", () => {
  it("finds required, optional, default and multiline blanks, once each, in order", () => {
    expect(fieldsOf("ssh {host} -p {port=22} {flags?}\n{notes...?}\n{host} again")).toEqual([
      { name: "host", required: true, multiline: false },
      { name: "port", required: false, default: "22", multiline: false },
      { name: "flags", required: false, multiline: false },
      { name: "notes", required: false, multiline: true },
    ]);
  });

  it("makes a blank optional if any use of it is, and takes the first default", () => {
    expect(fieldsOf("{a} {a=x} {a=y} {b...} {b}")).toEqual([
      { name: "a", required: false, default: "x", multiline: false },
      { name: "b", required: true, multiline: true },
    ]);
  });

  it("fills values in, leaving a missing required blank as {name} and reporting it", () => {
    const r = render("Restart {service} on {host}{note?}.", { service: "nginx" });
    expect(r.text).toBe("Restart nginx on {host}.");
    expect(r.missing).toEqual(["host"]);
    expect(r.segments).toEqual([
      { text: "Restart " },
      { text: "nginx", field: "service" },
      { text: " on " },
      { text: "{host}", field: "host", missing: true },
      { text: "." },
    ]);
  });

  it("treats a whitespace-only value as blank: the default for an optional, missing for a required", () => {
    expect(render("{a=x}|{b}", { a: "  ", b: " \n" })).toMatchObject({ text: "x|{b}", missing: ["b"] });
    expect(render("[{a?}]", { a: "" }).text).toBe("[]");
  });

  it("keeps literal braces: \\{ escapes, and any brace that isn't a blank stays as written", () => {
    const body = String.raw`\{host} {"a": {"b": 1}} {{ jinja }} $\{HOME} {a,b} {1..3} { spaced } {x`;
    expect(fieldsOf(body)).toEqual([]);
    expect(render(body, {}).text).toBe('{host} {"a": {"b": 1}} {{ jinja }} ${HOME} {a,b} {1..3} { spaced } {x');
  });

  it("leaves a blank touching another brace alone: compact Jinja, Handlebars and CI expressions", () => {
    const body = "{{host}} ${{ secrets.X }} ${{env}} {{{x}}} {a}} {{b} {c}";
    expect(fieldsOf(body).map((f) => f.name)).toEqual(["c"]);
    expect(render(body, { c: "C" }).text).toBe("{{host}} ${{ secrets.X }} ${{env}} {{{x}}} {a}} {{b} C");
    expect(render("{x}{y}", { x: "1", y: "2" }).text).toBe("12");
  });

  it("treats names like constructor and __proto__ as plain names, never inherited properties", () => {
    const body = "{constructor} {__proto__} {toString} {hasOwnProperty?}";
    expect(render(body, {})).toMatchObject({ text: "{constructor} {__proto__} {toString} ", missing: ["constructor", "__proto__", "toString"] });
    const values = JSON.parse('{"constructor": "a", "__proto__": "b", "toString": "c"}');
    expect(render(body, values)).toMatchObject({ text: "a b c ", missing: [] });
  });

  it("inserts values verbatim and once: a value holding {other} or \\{ is not expanded", () => {
    expect(render("{a} {b}", { a: "{b}", b: String.raw`\{c}` }).text).toBe(String.raw`{b} \{c}`);
  });

  it("handles Unicode names and values", () => {
    expect(fieldsOf("{café} {名前} {ñ_1-x}").map((f) => f.name)).toEqual(["café", "名前", "ñ_1-x"]);
    expect(render("Héllo {名前} 👋 {café}", { 名前: "世界", café: "☕ crème" }).text).toBe("Héllo 世界 👋 ☕ crème");
  });

  it("puts multiline values in whole, newlines and indentation kept", () => {
    const log = "line 1\n  line 2\n\tline 3\n";
    expect(render("Explain this log:\n```\n{log...}```\nThanks", { log }).text).toBe(`Explain this log:\n\`\`\`\n${log}\`\`\`\nThanks`);
  });

  it("doesn't let a default cross a line or hold a }", () => {
    expect(fieldsOf("{a=one\ntwo}")).toEqual([]);
    expect(render("{a=x}y}", {}).text).toBe("xy}");
  });
});

describe("Insert", () => {
  it("replaces the draft, or adds after it with one blank line", () => {
    expect(insertInto("old", "new", "replace")).toBe("new");
    expect(insertInto("old\n\n  ", "new", "append")).toBe("old\n\nnew");
    expect(insertInto("  ", "new", "append")).toBe("new");
  });
});

describe("Saving a template", () => {
  it("refuses a missing name or body, too-long fields, and a name taken in any case", () => {
    const others = [t("Restart service")];
    expect(problemOf({ name: " ", description: "", body: "x" }, others)).toMatch(/name/);
    expect(problemOf({ name: "a", description: "", body: " \n" }, others)).toMatch(/message/);
    expect(problemOf({ name: "a", description: "", body: "x".repeat(BODY_MAX + 1) }, others)).toMatch(/under/);
    expect(problemOf({ name: "  restart SERVICE ", description: "", body: "x" }, others)).toMatch(/already a template/);
    expect(problemOf({ name: "Restart", description: "", body: "x" }, others)).toBeUndefined();
  });

  it("finds a free name for a duplicate", () => {
    expect(freeName("Deploy", [t("deploy"), t("Deploy (2)")])).toBe("Deploy (3)");
    expect(freeName("New", [t("deploy")])).toBe("New");
  });
});

describe("Stored templates", () => {
  it("keeps only valid ones, one per id and name", () => {
    const got = toTemplates([
      t("A"),
      { ...t("B"), id: "id-A" },
      t("a"),
      { id: "x", name: "No body", body: "" },
      "junk",
      { ...t("C"), description: 5, project: { scope: "s" } },
    ]);
    expect(got).toEqual([t("A"), { ...t("C"), description: "" }]);
    expect(toTemplates("nope")).toBeUndefined();
  });

  it("offers a scoped template only with its project, in its connection and profile", () => {
    const scoped = t("A", { project: { scope: "s1", id: "p1", name: "Infra" } });
    expect(offeredHere(t("B"), "s1", [])).toBe(true);
    expect(offeredHere(scoped, "s1", ["p1"])).toBe(true);
    expect(offeredHere(scoped, "s1", ["p2"])).toBe(false);
    expect(offeredHere(scoped, "s2", ["p1"])).toBe(false);
  });

  it("keeps a deleted project's templates, offered in every chat", () => {
    const list = [t("A", { project: { scope: "s1", id: "p1", name: "Infra" } }), t("B", { project: { scope: "s2", id: "p1", name: "Other" } })];
    expect(unscope(list, "s1", "p1")).toEqual([t("A"), list[1]]);
  });
});

describe("Export and import", () => {
  it("exports name, description and body only: no ids or projects", () => {
    const doc = JSON.parse(exportFile([t("A", { description: "d", project: { scope: '["ssh","me@box","me","default"]', id: "p", name: "P" } })]));
    expect(doc).toEqual({ format: EXPORT_FORMAT, version: 1, templates: [{ name: "A", description: "d", body: "Hi" }] });
  });

  it("round-trips, giving new ids and renaming names already taken", () => {
    const file = exportFile([t("Deploy"), t("Backup")]);
    const got = readImport(file, [t("deploy")], ids);
    expect(got.added.map((a) => a.name)).toEqual(["Deploy (2)", "Backup"]);
    expect(got.added.every((a) => a.id.startsWith("new-"))).toBe(true);
    expect(got.renamed).toEqual([{ from: "Deploy", to: "Deploy (2)" }]);
  });

  it("renames duplicates inside one file too", () => {
    const got = readImport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, templates: [{ name: "X", body: "1" }, { name: "x", body: "2" }] }), [], ids);
    expect(got.added.map((a) => a.name)).toEqual(["X", "x (2)"]);
  });

  it("skips malformed entries and counts them, and never takes a project from the file", () => {
    const file = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 1,
      templates: [{ name: "Ok", body: "fine", project: { scope: "s", id: "p", name: "P" } }, { name: "", body: "x" }, { name: "No body" }, 7, null, { name: "y".repeat(500), body: "x" }, { name: "Long", body: "x", description: "d".repeat(301) }, { name: "Odd", body: "x", description: 5 }],
    });
    const got = readImport(file, [], ids);
    expect(got.added).toEqual([{ id: expect.any(String), name: "Ok", description: "", body: "fine" }]);
    expect(got.skipped).toBe(7);
  });

  it("refuses files that aren't an export, or come from a newer version", () => {
    expect(() => readImport("{not json", [])).toThrow(/isn't JSON/);
    expect(() => readImport("[]", [])).toThrow(/isn't a Hermes Chat templates export/);
    expect(() => readImport(JSON.stringify({ format: "other", templates: [] }), [])).toThrow(/isn't a Hermes Chat/);
    expect(() => readImport(JSON.stringify({ format: EXPORT_FORMAT, templates: [] }), [])).toThrow(/no version/);
    expect(() => readImport(JSON.stringify({ format: EXPORT_FORMAT, version: 2, templates: [] }), [])).toThrow(/newer version/);
  });

  it("stops at the most kept", () => {
    const existing = Array.from({ length: TEMPLATES_MAX - 1 }, (_, i) => t(`T${i}`));
    const got = readImport(exportFile([t("A"), t("B"), t("C")]), existing, ids);
    expect(got.added.map((a) => a.name)).toEqual(["A"]);
    expect(got.overLimit).toBe(2);
  });
});
