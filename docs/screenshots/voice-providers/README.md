# Settings → Voice: speech providers (#168)

Captured on 2026-11-04 from the running Hermes Chat app (WebKitGTK, debug build with the frontend embedded) built from this branch, on an Xvfb display at 1280 × 900 with openbox. Nothing was composited or retouched. The native select popups draw black without a compositor, so providers were picked with the keyboard.

## `-real`: a real Hermes dashboard

Shots 1–7 are signed in by URL to a throwaway **real** Hermes dashboard. It was started from the deployed checkout `f0d94882e8` (`hermes dashboard --isolated --host 127.0.0.4`, Python 3.14 venv), with its own `HERMES_HOME`, password sign-in and a throwaway password. The keys typed in it are placeholders, not real keys. Every save went through the app's Rust relay to that server, and was checked there afterwards: `stt.provider: groq`, `tts.provider: elevenlabs`, `stt.groq.language: en`, and `ELEVENLABS_API_KEY` in its `.env`.

- `1-loaded-speech-to-text-real.png`: the speech-to-text providers as Hermes lists them, with its own readiness. Local Whisper is in use but its faster-whisper package isn't installed on that server. OpenAI and Groq show "Set up" because an earlier live test saved placeholder keys there.
- `2-loaded-text-to-speech-real.png`: the text-to-speech side. Edge is in use, and its voice is shown from the profile's config.
- `3-picked-groq-key-write-only-real.png`: Groq picked, not yet saved. Its key shows only "Set" and an empty field. The model is a select with the choices Hermes's schema gives.
- `4-key-typed-real.png`: ElevenLabs picked, with a placeholder key typed. It shows masked, and is still "Not set".
- `5-saving-real.png`: the save under way. Every control is held still.
- `6-saved-and-read-back-real.png`: after the read-back. ElevenLabs is in use and set up, the key reads "Set", and the field is empty again.
- `7-conflict-real.png`: the voice ID was edited here while another client (a direct `PUT /api/config` to the same server) changed it. Nothing was sent, and the field shows Hermes's value.

## `-stand-in`: the repo's FakeHermes

Shots 8–11 are signed in to a local stand-in: the repo's `FakeHermes` (`fakeVoiceProviders.ts` for the speech providers) behind real HTTP and WebSocket on loopback (`bridge.ts` here). These states can't be made on demand on a real server: a running voice conversation needs a microphone and a started chat, and a real `f0d94882e8` has the routes and doesn't refuse a listed provider. The chat and its text are synthetic.

- `8-voice-panel-link-stand-in.png`: a voice conversation listening. It used WebKitGTK's mock capture device, turned on in the screenshot build only (`set_enable_mock_capture_devices`, not committed). The panel names both providers and has "Change voice settings".
- `9-opened-from-panel-stand-in.png`: that link opens Settings on the Voice tab. The conversation pauses, as it does whenever its pane is covered.
- `10-refused-stand-in.png`: `GET /__refuse` makes the next pick answer Hermes's own 400 for a provider it doesn't list. The screen says nothing was changed and keeps the pick to try again.
- `11-unsupported-stand-in.png`: `GET /__old` answers the speech-provider routes with FastAPI's 404, as a Hermes without them would. The section says so and points to `hermes tools`. The Voice rows above still show the providers the profile names.

To run the stand-in: `npx rolldown docs/screenshots/voice-providers/bridge.ts --platform node -o /tmp/voice-bridge.mjs && node /tmp/voice-bridge.mjs 47868`, then sign in by URL to `http://127.0.0.1:47868` with any username and password, using the app's own `XDG_*` folders and a private D-Bus session so nothing reaches your keyring.
