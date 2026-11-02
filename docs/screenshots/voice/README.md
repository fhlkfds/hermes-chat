# Voice screenshots

Captured on 2026-11-02 from the running Tauri app and its WebKitGTK webview under Xvfb. Images are framebuffer captures, cropped to show the relevant controls; image 8 stacks three captures of loading, playing and ended states.

The app connected through its real Rust transport to a local stub dashboard based on `FakeHermes`. Chat content and returned transcript text are fixtures. Recording captures used WebKitGTK's mock microphone through a temporary verification patch, removed before committing. The received recording was checked as valid 16 kHz mono, 16-bit WAV containing the mock device's 150 Hz tone. This verifies capture, upload and insertion of returned text, not recognition of a person's speech.

Read aloud used a real Edge TTS MP3 obtained from the deployed Hermes server, served by the stub. WebKitGTK reached playback, Stop worked, and playback ended without an error. Audible output was not verified because the test environment had no speakers. The missing-microphone capture used the ordinary app without the mock device. The provider error reproduces the deployed server's actual missing-transcriber response.

The final image shows a different-origin page reached through a reply link being refused microphone access (`NotAllowedError`), while the app's own page had access to the mock device. These captures predate integration of the preview pane from main: reply links now open there, with device permissions disabled, instead of navigating the whole webview. The voice controls in these captures are unchanged.

Physical microphone capture, speech recognition with a configured provider, and audible speaker output still need checking on the owner's desktop. The deployed default profile used local STT but lacked `faster-whisper` when checked.
