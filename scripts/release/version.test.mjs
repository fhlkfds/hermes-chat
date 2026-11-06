import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FILES, bump, check, compare, nextVersion, versions } from "./version.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch checkout holding copies of this repo's real five version files. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-version-"));
  dirs.push(root);
  for (const file of Object.values(FILES)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    cpSync(file, join(root, file));
  }
  return root;
}

const edit = (root, file, fn) => writeFileSync(join(root, file), fn(readFileSync(join(root, file), "utf8")));

describe("the next version", () => {
  it("raises one number and resets the ones below it", () => {
    expect(nextVersion("0.1.1", "patch")).toBe("0.1.2");
    expect(nextVersion("0.1.1", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.1", "major")).toBe("1.0.0");
  });

  it("releases a prerelease at its own number", () => {
    expect(nextVersion("1.0.0-beta.1", "patch")).toBe("1.0.0");
    expect(nextVersion("1.0.0-beta.1", "minor")).toBe("1.0.0");
    expect(nextVersion("1.0.0-beta.1", "major")).toBe("1.0.0");
    expect(nextVersion("1.2.3-rc.1", "minor")).toBe("1.3.0");
  });

  it("takes an exact version only when it is newer", () => {
    expect(nextVersion("0.1.1", "1.0.0-beta.1")).toBe("1.0.0-beta.1");
    expect(() => nextVersion("0.1.1", "0.1.1")).toThrow("isn't newer");
    expect(() => nextVersion("0.1.1", "0.1.0")).toThrow("isn't newer");
    expect(() => nextVersion("1.0.0", "1.0.0-rc.1")).toThrow("isn't newer");
    expect(() => nextVersion("0.1.1", "v0.2.0")).toThrow("isn't patch, minor, major");
    expect(() => nextVersion("0.1.1", "bugfix")).toThrow("isn't patch, minor, major");
  });

  it("orders prereleases as semver does", () => {
    const sorted = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 1; i < sorted.length; i++) expect(compare(sorted[i - 1], sorted[i]), `${sorted[i - 1]} < ${sorted[i]}`).toBe(-1);
    expect(compare("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("bumping the files", () => {
  it("writes the new version into all five files and changes nothing else", () => {
    const root = checkout();
    const current = check(root);
    const before = Object.fromEntries(Object.values(FILES).map((f) => [f, readFileSync(join(root, f), "utf8")]));

    const { from, to } = bump(root, "minor");

    expect(from).toBe(current);
    expect(to).toBe(nextVersion(current, "minor"));
    expect(new Set(Object.values(versions(root)))).toEqual(new Set([to]));
    for (const file of Object.values(FILES)) {
      const after = readFileSync(join(root, file), "utf8");
      const changed = after.split("\n").filter((line, i) => line !== before[file].split("\n")[i]);
      // tauri.conf.json, package.json, Cargo.toml, Cargo.lock: one line; package-lock.json: two.
      expect(changed.length, file).toBe(file === FILES.npmLock ? 2 : 1);
      for (const line of changed) expect(line, file).toContain(to);
      expect(after.split("\n").length, file).toBe(before[file].split("\n").length);
    }
  });

  it("leaves a dependency at the same version, and other Cargo tables, alone", () => {
    const root = checkout();
    const current = check(root);
    edit(root, FILES.cargo, (t) => `${t}\n[package.metadata.other]\nversion = "${current}"\n`);
    edit(root, FILES.cargoLock, (t) => `${t}\n[[package]]\nname = "hermes-chat-helper"\nversion = "${current}"\n`);
    edit(root, FILES.npmLock, (t) =>
      t.replace('"packages": {', `"packages": {\n    "node_modules/same": {\n      "version": "${current}"\n    },`),
    );

    const { to } = bump(root, "patch");

    expect(readFileSync(join(root, FILES.cargo), "utf8")).toContain(`[package.metadata.other]\nversion = "${current}"`);
    expect(readFileSync(join(root, FILES.cargoLock), "utf8")).toContain(`name = "hermes-chat-helper"\nversion = "${current}"`);
    const lock = JSON.parse(readFileSync(join(root, FILES.npmLock), "utf8"));
    expect(lock.packages["node_modules/same"].version).toBe(current);
    expect(lock.packages[""].version).toBe(to);
  });

  it("writes nothing when the files already disagree", () => {
    const root = checkout();
    edit(root, FILES.cargo, (t) => t.replace(/^version = ".*"$/m, 'version = "9.9.9"'));
    const before = readFileSync(join(root, FILES.tauri), "utf8");

    expect(() => bump(root, "patch")).toThrow(/src-tauri\/Cargo\.toml \(\[package\]\): 9\.9\.9/);
    expect(readFileSync(join(root, FILES.tauri), "utf8")).toBe(before);
  });
});

describe("checking the files", () => {
  it("passes this repo's own files and their tag", () => {
    const version = check(".");
    expect(check(".", `v${version}`)).toBe(version);
  });

  it("names each file that disagrees with tauri.conf.json, or with the tag", () => {
    const root = checkout();
    const current = check(root);
    edit(root, FILES.npm, (t) => t.replace(`"version": "${current}"`, '"version": "0.0.9"'));
    edit(root, FILES.cargoLock, (t) => t.replace(/(name = "hermes-chat"\nversion = ")[^"]*/, "$10.0.8"));

    expect(() => check(root)).toThrow(/package\.json: 0\.0\.9\n {2}src-tauri\/Cargo\.lock: 0\.0\.8/);
    const fresh = checkout();
    expect(() => check(fresh, "v99.0.0")).toThrow(/these don't say 99\.0\.0[\s\S]*bump to 99\.0\.0 before tagging v99\.0\.0/);
    expect(() => check(fresh, "release-1")).toThrow("isn't a v<semver> tag");
  });

  it("runs from the command line with the exit code CI needs", () => {
    const root = checkout();
    const run = (...args) => execFileSync("node", ["scripts/release/version.mjs", ...args], { env: { ...process.env, HERMES_CHAT_ROOT: root }, encoding: "utf8", stdio: "pipe" });
    const current = check(root);

    expect(run("check", `v${current}`)).toContain(`every version file says ${current}`);
    expect(() => run("check", "v99.0.0")).toThrow(/error: these don't say 99\.0\.0/);
    expect(run("bump", "major")).toContain(`${current} → ${nextVersion(current, "major")}`);
    expect(() => run("bump")).toThrow(/usage/);
  });
});
