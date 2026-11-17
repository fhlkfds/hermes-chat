// Reading the Screen's clipboard on the server (screenClipboard.ts, ADR 0193): the exact command Hermes's `shell.exec`
// gets, run in a real `sh` against a stand-in xclip, and through the transport against FakeHermes.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { CHUNK_BYTES, chunkCommand, readScreenClipboard } from "./screenClipboard";
import { connect } from "./transport";

const dir = mkdtempSync(join(tmpdir(), "screen-clipboard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const HOME = join(dir, "o'neil's hermes");
const CLIPBOARD = join(dir, "clipboard");

// xclip as the server has it: it prints the clipboard of the display and X authority it is given, or says it has none.
writeFileSync(
  join(dir, "xclip"),
  `#!/bin/sh
[ "$*" = "-selection clipboard -o" ] || { echo "xclip: bad arguments: $*" >&2; exit 2; }
[ "$DISPLAY" = ":42" ] && [ "$XAUTHORITY" = "$EXPECTED_XAUTHORITY" ] || { echo "Error: Can't open display: $DISPLAY" >&2; exit 1; }
[ -e "${CLIPBOARD}" ] || { echo "Error: target STRING not available" >&2; exit 1; }
cat "${CLIPBOARD}"
`,
);
chmodSync(join(dir, "xclip"), 0o755);

/** `shell.exec` as Hermes runs it: `sh -c`, keeping the last 4000 characters printed. */
async function shellExec(command: string) {
  const r = spawnSync("sh", ["-c", command], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, EXPECTED_XAUTHORITY: `${HOME}/bot-desktop/Xauthority` },
  });
  return { stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000), code: r.status ?? 1 };
}

const where = { display: ":42", profileKey: HOME };
const copied = (text: string | undefined) => (text === undefined ? rmSync(CLIPBOARD, { force: true }) : writeFileSync(CLIPBOARD, text));

describe("The screen's clipboard, read on the server", () => {
  it("quotes the display and the profile's X authority for the shell", () => {
    expect(chunkCommand({ display: ":42", profileKey: "/home/liam/.hermes" }, 0)).toBe(
      `DISPLAY=':42' XAUTHORITY='/home/liam/.hermes/bot-desktop/Xauthority' xclip -selection clipboard -o | tail -c +1 | head -c ${CHUNK_BYTES} | od -An -v -tx1 | tr -d ' \\n'`,
    );
    execFileSync("sh", ["-n", "-c", chunkCommand(where, 0)]);
  });

  it("reads short text in one command", async () => {
    copied("https://example.com/a?b=c");
    const commands: string[] = [];
    expect(await readScreenClipboard((c) => (commands.push(c), shellExec(c)), where)).toBe("https://example.com/a?b=c");
    expect(commands).toHaveLength(1);
  });

  it("reads text longer than Hermes passes back at once, in chunks, whole characters and all", async () => {
    // Multibyte characters straddle the chunk edges; the credential-shaped and JSON lines would be masked as text.
    const text = `{"api_key": "sk-proj-abcdefghijklmnop"}\n${"日本語のテキスト ".repeat(400)}\nend`;
    copied(text);
    const commands: string[] = [];
    expect(await readScreenClipboard((c) => (commands.push(c), shellExec(c)), where)).toBe(text);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(4 * CHUNK_BYTES);
    expect(commands.length).toBe(Math.ceil(new TextEncoder().encode(text).length / CHUNK_BYTES));
  });

  it("stops between chunks once the owner no longer holds the screen", async () => {
    copied("a".repeat(3 * CHUNK_BYTES));
    const hold = new AbortController();
    let commands = 0;
    const exec = async (c: string) => (commands++, hold.abort(), shellExec(c));
    await expect(readScreenClipboard(exec, where, hold.signal)).rejects.toThrow();
    expect(commands).toBe(1);
  });

  it("reads a clipboard nothing owns as empty", async () => {
    copied(undefined);
    expect(await readScreenClipboard(shellExec, where)).toBe("");
    copied("");
    expect(await readScreenClipboard(shellExec, where)).toBe("");
  });

  it("says why when it can't be read", async () => {
    copied("text");
    await expect(readScreenClipboard(shellExec, { ...where, display: ":7" })).rejects.toThrow("Error: Can't open display: :7");
  });

  it("stops at what the screen takes in", async () => {
    copied("x".repeat(256 * 1024));
    await expect(readScreenClipboard(shellExec, where)).rejects.toThrow("The screen's clipboard holds more than 255 KiB of text.");
  });
});

describe("Through Hermes", () => {
  function server(clipboard: string | undefined, programs = ["xclip"]) {
    const s = new FakeHermes();
    s.display = { status: { supported: true, installed: true, missing: [], running: true, display: ":42" }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
    s.machine = { programs: new Set(programs), files: new Set(), pmInstall: { code: 0, output: "" }, browser: "", clipboard };
    return s;
  }

  it("asks shell.exec for the running screen's clipboard", async () => {
    const s = server("copied on the screen ✓");
    const hermes = await connect(s.openPipe);
    const status = await hermes.screen.status();
    expect(await hermes.screen.readClipboard({ display: status.display!, profileKey: status.profile_key })).toBe("copied on the screen ✓");
    expect(s.requests.filter((r) => r.method === "shell.exec").map((r) => r.params)).toEqual([
      { command: `DISPLAY=':42' XAUTHORITY='/home/liam/.hermes/bot-desktop/Xauthority' xclip -selection clipboard -o | tail -c +1 | head -c 1999 | od -An -v -tx1 | tr -d ' \\n'` },
    ]);
  });

  it("fails without xclip on the server", async () => {
    const hermes = await connect(server("text", []).openPipe);
    await expect(hermes.screen.readClipboard({ display: ":42", profileKey: "/home/liam/.hermes" })).rejects.toThrow("xclip: not found");
  });
});
