# The Screen relay forwards each RFB message as it comes

Issue #172 asked why computer use is slow, and whether the Screen tab adds lag. Measured in `docs/research/computer-use-speed/`, with a real Xvnc and the real app, a stand-in for Hermes's bridge and emulated remote links: at low load, a page change on the Bot Desktop reached the glass in about 50 ms over loopback and about 115 ms over an emulated 50 ms-RTT, 20 Mbit/s link. The app's own share of that (ADR 0039's Rust relay, the Tauri channel, noVNC and painting) had a median of 25 to 34 ms on loopback and 18 to 31 ms over the emulated links. Hermes's model loop couldn't be timed there. From its code, it costs one or two model round trips per action, so it is very likely where a slow step's time goes, but that is an inference, not a measurement.

One app-side cost stood out. Hermes's bridge sends one WebSocket message per read of Xvnc's socket, so one page change is 50 to 190 messages, mostly under 1 KiB. The relay hands each one to the webview as its own channel message, and each costs a script run on the webview's main thread, plus an IPC fetch at 1 KiB and over. On loopback, where a page's messages all arrive within a few milliseconds, that queue took 14 to 18 ms at low load. Over the emulated links it took 0 to 5 ms.

## Decisions

- **The relay stays a plain splice.** Each binary message from `/api/display/ws` goes to the webview as soon as it comes, and nothing waits to be sent with later bytes.
- **noVNC keeps quality 7 and compression 2**, the official desktop's settings. Quality 5 would save about 16% of the bytes at a visible cost. Compression 2 is already as small as 9.

## Considered options

- **Batching the relayed bytes** (bytes within 8 ms of the last batch go together). It cut a page to 2 or 3 channel messages, but in a back-to-back A/B it made small changes up to 38 ms slower and a busy screen show 6 to 8 frames a second instead of 10. The likely cause, inferred rather than traced: TigerVNC paces each client by timing fence round trips, and noVNC answers a fence only when its bytes arrive. Holding bytes back adds up to 8 ms of jitter to every round trip, which TigerVNC reads as a filling queue, and it slows down. Any batching that waits would do the same. Batching only bytes that have already arrived never batches, because the relay keeps up with the network; only the webview falls behind.
- **A loopback WebSocket from Rust to the webview**, so noVNC reads a real socket with no per-message script run or fetch. Not built: it would save at most the 14 to 18 ms seen on loopback (up to about 30 ms on a busy machine), and little over the emulated links, and it adds a listening port that needs its own token and origin checks.

## Consequences

- On a fast link or a busy machine, a page change can still spend up to about 30 ms in the channel. If that ever matters, the loopback WebSocket is the way to remove it, not batching.
- How fast computer use feels depends on Hermes: model round trips per action, the screenshot each one carries, and an extra vision-model call on models that can't take images in tool results. What Hermes would need is written up in the research note and on issue #172.
