# Voice screenshots

Captured on 2026-11-02 from the running Tauri app and its WebKitGTK webview under Xvfb. Images are framebuffer captures, cropped to show the relevant controls; image 8 stacks three captures of loading, playing and ended states.

The app connected through its real Rust transport to a local stub dashboard based on `FakeHermes`. Chat content and returned transcript text are fixtures. Recording captures used WebKitGTK's mock microphone through a temporary verification patch, removed before committing. The received recording was checked as valid 16 kHz mono, 16-bit WAV containing the mock device's 150 Hz tone. This verifies capture, upload and insertion of returned text, not recognition of a person's speech.

Read aloud used a real Edge TTS MP3 obtained from the deployed Hermes server, served by the stub. WebKitGTK reached playback, Stop worked, and playback ended without an error. Audible output was not verified because the test environment had no speakers. The missing-microphone capture used the ordinary app without the mock device. The provider error reproduces the deployed server's actual missing-transcriber response.

Image 10 shows a different-origin page reached through a reply link being refused microphone access (`NotAllowedError`), while the app's own page had access to the mock device. Images 1–10 predate integration of the preview pane from main: reply links now open there, with device permissions disabled, instead of navigating the whole webview.

Images 11–12 are captures of the running React app in T3's Chromium browser, after integrating main and fixing recording controls that overflowed beside the preview pane. They use `Main`, the real voice components, `FakeHermes`, and a synthetic browser audio stream in a temporary harness, without native Tauri IPC. At a 440 px chat width, both default and 150% interface text keep Done inside the chat and clickable (checked by bounding boxes and browser hit testing). Clicking Done at 150% text stopped recording, sent one WAV to the fake backend and inserted its returned transcript. This uses synthetic input and a fixture transcript; it does not verify physical microphone input or recognition. Recording controls now occupy their own row; earlier images show the prior layout.

Image 13 repeats the 440 px recording capture after merging projects and token usage from main (`2b74a86`), using the same Chromium harness and synthetic audio. Done remained within the chat and passed browser hit testing. Clicking Done again inserted the fixture transcript without adding a chat message.

Image 14 repeats the Chromium harness capture after merging screenshot capture and title/model fixes from main (`05d2d6e`). The screenshot button remains beside the model controls while recording uses its own row. Browser hit testing confirmed Dictate and Attach a screenshot before recording, and Done during recording, remain clickable at a 440 px chat width; Done uploaded synthetic WAV audio and inserted the fixture transcript without adding a chat message.

Physical microphone capture, speech recognition with a configured provider, and audible speaker output still need checking on the owner's desktop. The deployed default profile used local STT but lacked `faster-whisper` when checked.
