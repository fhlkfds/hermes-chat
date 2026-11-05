# A tool result's inline images stay out of the chat

Issue #172 asked why computer use is slow. ADR 0056 timed the Screen stream against a stand-in for Hermes. This time a real Hermes (2026.9.24) was timed: its Bot Desktop, `cua-driver` 0.21.0 and its configured model, through the app's own SSH tunnel (Step 4 of `docs/research/computer-use-speed/README.md`).
- **Where a step's time goes:** to Hermes. A model round trip took 2.4 s (median), a five-action task needed eight of them, and each capture took 0.6 s.
- **The stream:** a key press's picture reached this computer in about 40 ms over the LAN, plus about 16 ms in the app.

Nothing in the app makes a step faster. What Hermes would need is listed in that note.

One app-side cost did grow with every step. Hermes sends a tool's whole result with `tool.complete`, and a `computer_use` capture's result carries its screenshot as a base64 data URL. On the 1440x900 Bot Desktop that's a 0.9 to 1 MB frame per capture. The chat kept that result, pretty-printed, as the tool call's text:
- **The Saved copy went.** Five captures made 4.7 MB of JSON, past the 2 MB that all Saved copies on this computer share (`TRANSCRIPT_LIMIT_BYTES`, counted in UTF-16), so the chat's own copy wasn't kept.
- **Other chats' copies went too.** A single capture took over half the room, and older chats' copies were let go to fit it.
- **Opening the tool call** showed the base64 as text.

## Decisions

- **Inline data in a tool's result is swapped for a note when the result arrives** (`src/hermes/toolResult.ts`). Two kinds count as data:
  - every `data:…;base64,` URL of 1 KiB or more;
  - every string of 4 KiB or more that is nothing but base64, with no spaces or line breaks.

  Each becomes, for example, `[image/png, 435 KB, not kept in the chat]`. The rest of the result is kept as it came, including the text that says where Hermes saved the screenshot on the server. Hermes's own history does the same with `inline_images=false`, which the app already asks for when it opens a chat.
- **Only what the chat keeps changes.** The frame still crosses the relay and the channel whole. The relay passes `/api/ws` frames through unread, and in the webview a capture's frame costs about a millisecond.

## Considered options

- **Showing the screenshot as an image in the tool call.** Not built. The Screen tab shows the screen live, and the file stays on the server at the path the result names.
- **Dropping the image in Rust, before the frame reaches the webview.** Rejected: the relay would have to parse every frame, to save about a millisecond each.
- **Hermes leaving the image out of `tool.complete`.** That's the better fix, since clients don't need it, and it's on the list for Hermes. It doesn't exist yet, so the app does this meanwhile.

## Consequences

- A result that really is a long run of base64, such as a tool printing a file as base64, shows as a note in the chat. Hermes still has it.
- A computer-use chat keeps its Saved copy, and leaves other chats' copies alone.
- History opened from Hermes and results that arrive live now look the same: neither carries the image.
