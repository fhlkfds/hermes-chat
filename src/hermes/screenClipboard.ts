// Copy and paste between this computer and the Screen's Bot Desktop (ADR 0193), as desktop VNC viewers do it: no keys
// are caught. While the owner holds the screen, this computer's text goes in when the screen gains the focus or the
// pointer, and Ctrl+V on the screen pastes it. The screen's text comes out when the pointer or the focus leaves.
//
// In, noVNC sends it as a client cut text, which Hermes passes only from the lease's holder. Out, Hermes's Xvnc sends
// its clipboard to no viewer (`-SendCutText=0`, tools/bot_desktop/launcher.sh at bf0203a), so xclip reads it on the
// server, over `shell.exec`.
import type { AppsSetup } from "./screenApps";
import { shellQuote } from "./screenApps";
import type { DisplayStatus } from "./screen";

/**
 * The most text that crosses, in UTF-8 bytes. Hermes's bridge drops the whole stream on a cut text over 256 KiB
 * (`_MAX_CUT_TEXT`, tools/bot_desktop/rfb_filter.py), and noVNC's extended clipboard adds a few bytes of framing to
 * text that doesn't compress.
 */
export const MAX_TEXT_BYTES = 255 * 1024;

/** This computer's clipboard text, read and written by Rust (src-tauri/src/clipboard_text.rs). */
export type LocalClipboard = { read(): Promise<string>; write(text: string): Promise<void> };

/** Where the screen's clipboard is read: its X display, and the profile's Hermes home, which holds its X authority. */
export type ScreenDisplay = { display: string; profileKey: string };

/**
 * Where to read the screen's clipboard from, when it can be: a running screen on Hermes's own display, with xclip on
 * the server, found by the apps check or added since.
 */
export function copyOutFrom(status: DisplayStatus | undefined, setup: AppsSetup): ScreenDisplay | undefined {
  if (!status?.running || !status.display || setup.kind !== "checked") return;
  const xclip = setup.apps.clipboard;
  if (xclip && xclip.kind !== "added") return;
  return { display: status.display, profileKey: status.profile_key };
}

/**
 * Bytes of the screen's clipboard per `shell.exec`. Hermes keeps the last 4000 characters of what a command prints,
 * after masking anything that looks like a credential (`tui_gateway/methods_tools.py` at bf0203a). So the text comes
 * as lowercase hex, which no mask matches, two characters a byte.
 */
export const CHUNK_BYTES = 1999;

/** The `shell.exec` command that prints the screen's clipboard from byte `offset`, a chunk of it, in hex. */
export const chunkCommand = ({ display, profileKey }: ScreenDisplay, offset: number) =>
  `DISPLAY=${shellQuote(display)} XAUTHORITY=${shellQuote(`${profileKey}/bot-desktop/Xauthority`)} xclip -selection clipboard -o` +
  ` | tail -c +${offset + 1} | head -c ${CHUNK_BYTES} | od -An -v -tx1 | tr -d ' \\n'`;

type ShellResult = { stdout: string; stderr: string; code: number };

/** What xclip says when nothing on the screen owns the clipboard, or not as text. */
const saysEmpty = (stderr: string) => /target \S+ not available/.test(stderr);

/**
 * Reads the screen's clipboard with `exec` (`shell.exec`), a chunk at a time, until `signal` aborts. "" when it holds
 * no text.
 */
export async function readScreenClipboard(exec: (command: string) => Promise<ShellResult>, where: ScreenDisplay, signal?: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    signal?.throwIfAborted();
    const r = await exec(chunkCommand(where, size));
    const hex = r.stdout.trim();
    if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("The screen's clipboard came back garbled.");
    if (!hex && size === 0 && r.stderr.trim() && !saysEmpty(r.stderr)) throw new Error(r.stderr.trim());
    const chunk = Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_TEXT_BYTES) throw new Error(`The screen's clipboard holds more than ${MAX_TEXT_BYTES / 1024} KiB of text.`);
    if (chunk.length < CHUNK_BYTES) break;
  }
  const bytes = new Uint8Array(size);
  chunks.reduce((at, c) => (bytes.set(c, at), at + c.length), 0);
  return new TextDecoder().decode(bytes);
}

export type PasteOutcome = "pasted" | "same" | "empty" | "too-long";
export type CopyOutcome = "copied" | "same" | "empty";

/**
 * Moves text across, each way only when it changed since the last text that crossed either way, so text copied out of
 * the screen isn't pasted straight back in.
 */
export class ClipboardBridge {
  private last: string | undefined;
  /** The focus and the pointer cross together: one sync each way at a time. */
  private pasting: Promise<PasteOutcome> | undefined;
  private copying: Promise<CopyOutcome> | undefined;

  constructor(private readonly local: LocalClipboard) {}

  /** A new stream: Xvnc keeps what a viewer pasted only while that viewer is connected. */
  forget() {
    this.last = undefined;
  }

  /**
   * This computer's text into the screen through `paste`, unless `signal` aborts first. `always`: even when it is what
   * crossed last.
   */
  paste(paste: (text: string) => void, signal: AbortSignal, always = false): Promise<PasteOutcome> {
    if (always) return this.pasteNow(paste, signal, true);
    return (this.pasting ??= this.pasteNow(paste, signal, false).finally(() => (this.pasting = undefined)));
  }

  /**
   * The screen's text, as `read` gives it, onto this computer's clipboard, unless `signal` aborts first. `always`: even
   * when it crossed last.
   */
  copy(read: () => Promise<string>, signal: AbortSignal, always = false): Promise<CopyOutcome> {
    if (always) return this.copyNow(read, signal, true);
    return (this.copying ??= this.copyNow(read, signal, false).finally(() => (this.copying = undefined)));
  }

  private async pasteNow(paste: (text: string) => void, signal: AbortSignal, always: boolean): Promise<PasteOutcome> {
    const text = await this.local.read();
    signal.throwIfAborted();
    if (!text) return "empty";
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) return "too-long";
    if (text === this.last && !always) return "same";
    paste(text);
    this.last = text;
    return "pasted";
  }

  private async copyNow(read: () => Promise<string>, signal: AbortSignal, always: boolean): Promise<CopyOutcome> {
    const text = await read();
    signal.throwIfAborted();
    if (!text) return "empty";
    if (text === this.last && !always) return "same";
    await this.local.write(text);
    this.last = text;
    return "copied";
  }
}
