import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAppImage, stage } from "./manifest.mjs";

const dirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "hermes-chat-manifest-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bundle(files) {
  const dir = join(scratch(), "appimage");
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("the release manifest", () => {
  it("stages the AppImage and its signature under host-safe names and points the manifest at them", () => {
    const bundleDir = bundle({ "Hermes Chat_0.2.0_amd64.AppImage": "\x7fELF built", "Hermes Chat_0.2.0_amd64.AppImage.sig": "c2ln\n" });
    const out = join(scratch(), "release");
    const manifest = stage(bundleDir, out, "https://github.com/l0cky12/hermes-chat/releases/download/v0.2.0/", "Notes.", new Date("2026-11-05T12:34:56.789Z"));
    expect(manifest).toEqual({
      version: "0.2.0",
      notes: "Notes.",
      pub_date: "2026-11-05T12:34:56Z",
      platforms: { "linux-x86_64": { signature: "c2ln", url: "https://github.com/l0cky12/hermes-chat/releases/download/v0.2.0/hermes-chat_0.2.0_amd64.AppImage" } },
    });
    expect(JSON.parse(readFileSync(join(out, "latest.json"), "utf8"))).toEqual(manifest);
    expect(readFileSync(join(out, "hermes-chat_0.2.0_amd64.AppImage"), "utf8")).toBe("\x7fELF built");
    expect(readFileSync(join(out, "hermes-chat_0.2.0_amd64.AppImage.sig"), "utf8")).toBe("c2ln");
  });

  it("refuses a bundle without a signature, with two AppImages, or with an unversioned name", () => {
    expect(() => stage(bundle({ "Hermes Chat_0.2.0_amd64.AppImage": "x" }), join(scratch(), "r"), "https://h/")).toThrow(/\.sig/);
    expect(() => findAppImage(bundle({ "a_0.2.0_amd64.AppImage": "x", "b_0.3.0_amd64.AppImage": "y" }))).toThrow(/found 2/);
    expect(() => findAppImage(bundle({}))).toThrow(/found 0/);
    expect(() => findAppImage(bundle({ "hermes-chat.AppImage": "x" }))).toThrow(/isn't named/);
  });

  it("names the updater target after the bundle's arch", () => {
    const found = findAppImage(bundle({ "Hermes Chat_1.0.0-beta.1_aarch64.AppImage": "x" }));
    expect(found).toMatchObject({ version: "1.0.0-beta.1", target: "linux-aarch64", staged: "hermes-chat_1.0.0-beta.1_aarch64.AppImage" });
  });
});
