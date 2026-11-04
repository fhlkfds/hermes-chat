# Voice conversation screenshots

Captured on 2026-11-04 from the running Tauri app (debug build, frontend embedded) and its WebKitGTK 4.1 webview, under Xvfb with Openbox on the Debian build box. The app ran on a private D-Bus session with its own XDG folders, so it had no keyring: that's the warning in Setup.

The app signed in through its real Rust transport to `bridge.ts` here, a loopback stand-in dashboard. It serves the tests' `FakeHermes` and adds the two audio routes the app uses, shaped as `hermes_cli/web_routers/audio.py` answers them. Everything is synthetic: the chats, the transcripts the bridge returns, the replies, and the reply "speech", a generated two-note chime. No transcription or speech provider ran.

| Image | What it shows | Microphone |
| --- | --- | --- |
| 1 | In a new chat, Start voice conversation explains why it can't start, and opens nothing. | none |
| 2 | The Start voice conversation button (sound wave) beside Dictate. | none |
| 3 | Listening, after Start, with the microphone list naming the real input. | **this computer's built-in microphone** (see below) |
| 4 | What is recorded, and where it goes: providers, prerequisites and turn settings, with no credential. | real |
| 5 | Read aloud playing during a conversation: "Not listening while audio plays", Stop speaking. | real |
| 6 | Hearing a turn: level meter, turn clock, Send now and Discard. | WebKitGTK mock device |
| 7 | Thinking, after Send now: the turn under "What Hermes got" as Sent, Stop reply. | mock |
| 8 | Speaking: the microphone shut until the reply finishes, Stop speaking, and the reply's own Read aloud showing Stop. | mock |
| 9 | Muted. | mock |
| 10 | A transcription failure (a shortened form of the deployed server's missing-transcriber message) pauses with Try again and Resume listening. | mock |
| 11 | Try again sent the held recording once; the next reply is spoken. | mock |
| 12 | Minimizing the window paused the conversation; it stayed paused once the window was back. | mock |
| 13 | Split panes: focus moved to the other pane, so this pane's conversation paused; its controls wrap at about 470 px. | mock |
| 14 | Settings → Voice, with the Voice conversation row reading the profile's `voice.*` settings through Rust. | n/a |

## Real hardware (images 3 to 5)

These used the ordinary app, without the mock device. The build box has no PulseAudio, so WebKitGTK reached the sound card through GStreamer's ALSA plugin (`gstreamer1.0-alsa`, on `GST_PLUGIN_PATH`). The microphone list shows "HDA Intel PCH", the Realtek ALC3204 built-in microphone. The kernel's own records confirm the behaviour:

- While listening, `/proc/asound/card0/pcm0c/sub0/status` (capture) was `RUNNING`, owned by the app's WebKitWebProcess.
- With Read aloud playing during the conversation, playback (`pcm0p`) and capture were both `RUNNING`. The panel said it wasn't listening, and the bridge got the speech request and no transcription.
- After End conversation, capture and playback were both `closed`.

This verifies that real devices open, run side by side and are released. It doesn't verify acoustics: the card's mixer had Master playback muted and Capture switched off, so no sound left the speaker and the microphone heard nothing. The mixer was left as it was. Speech, room echo and audible output still need checking on a desktop with working audio.

## Mock microphone (images 6 to 13)

To show turns being heard, these used WebKitGTK's mock capture device, turned on by a temporary one-line patch to `src-tauri/src/lib.rs` (`set_enable_mock_capture_devices(true)`). The patch was removed before committing, as it was for the Dictation screenshots. The device plays a steady tone, so it is "speech" that never pauses. Turns were therefore ended with Send now, and muting stopped the next one. Each turn reached the bridge as valid 16 kHz mono 16-bit WAV (484,504 and 219,982 bytes). The tone kept sounding through Speaking, and no turn was made from it.

Image 10 predates a wording fix: the panel then said "Hermes couldn't transcribe" twice. It now shows the transport's message once. Image 4 predates a correction from review: it says "Nothing is saved on this computer". The panel now says the audio is never saved, and the text sent is kept as typed messages are (in the chat's Saved copy, or as a Failed message).
