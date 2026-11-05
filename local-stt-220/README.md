# #220 speech to text on this computer: screenshots

Captured on 2026-11-05 from the real Tauri debug builds (WebKitGTK) on an Xvfb display, 1280 × 820, signed in by URL to
`docs/screenshots/voice-providers/bridge.ts` (the tests' FakeHermes over loopback HTTP/WS, not a real Hermes).
"before" is origin/main `059ddc6`. "after" 1–5 are branch `ea175ea`, and 6 is `1015f64` (the round 2 fixes only change
the Test button's lifecycle). whisper.cpp 1.9.5 was built from source into /tmp and put first on PATH, with
`ggml-tiny.en.bin` linked into the throwaway XDG data folder. The machine has no microphone, so Test shows the
microphone error (4).

- before-1-voice-tab.png: Settings → Voice before.
- after-1-hermes-server.png: the new Speech to text section, Hermes server picked (the default).
- after-2-this-computer-none-chosen.png: This computer picked and no engine chosen yet. Dictation and Voice
  conversation above become Unavailable and say why.
- after-3-whisper-cpp-found.png: the whisper.cpp found on PATH, its --version line, and the model found.
- after-4-test-no-microphone.png: Test on a machine with no microphone.
- after-5-after-restart.png: after quitting and relaunching on the same config folder, the choice is still there.
- after-6-none-installed.png: no engine on PATH. Shows a layout bug in the how-to note (the code-formatted spans
  break into columns).
