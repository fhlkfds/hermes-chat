# Templates screenshots

Captured on 2026-11-03 from the running Tauri debug build of this branch (WebKitGTK, `tauri build --debug --no-bundle`)
on an Xvfb display, 1280 × 820, driven by hand with xdotool, against the fake dashboard in
`../slash-commands/bridge.ts` (synthetic chats, loopback only). App data went to a throwaway `XDG_DATA_HOME`, and the
app ran on its own D-Bus session bus, so the keyring save failed and nothing reached the login keyring. Nothing was
composited or retouched.

"Restart a service" was made with **New** in the app. The other three came from `seed.json` through **Import…** and
the real GTK file chooser. The file also holds a template whose name was taken (imported as `restart a SERVICE (2)`,
then deleted with **Delete**) and one with no name (skipped).

1. `1-library.png`: the library, with "Restart a service" picked with ↓.
2. `2-fill-form.png`: Enter opened the fill-in form. `service` is required and still empty, so the preview marks it
   and Insert waits. The defaults show as placeholders.
3. `3-preview.png`: filled in, including a two-line `why`. The preview is exactly what Insert put in the composer.
   Insert was then pressed. The composer held the text, and the transcript gained no message.
4. `4-replace-or-append.png`: a second template, with the first one's text still in the composer as a draft. The
   only choices are Replace draft and Add after draft. **Cancel** was pressed here first, and the screenshot after
   it was byte-identical to the one before opening the dialog.
5. `5-appended.png`: after **Add after draft**. The draft stored in local storage
   (`hermes-chat.draft.["url","http://127.0.0.1:47811","demo","default","backup"]`) was read back and was the first
   message, a blank line, then the second.
6. `6-imported.png`: the result of importing `seed.json`.

**Export…** was then used through the native Save dialog. The file it wrote held the four templates, with name,
description and body only. A different session's app then opened on the same Xvfb display, so the run stopped there.
