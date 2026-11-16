# A bot save writes a field only where Hermes still has what the owner saw

> **Accepted.** It builds what ADR 0066 left for later ("Editing a bot's name, picture and description"), changes one line of ADR 0164 ("No Bot Mode block is written"), and changes how ADR 0156's Edit saves a description and a model. The rule is `plan` in `src/hermes/fieldMerge.ts`. `Hermes.editBot` and `Hermes.botLook` in `src/hermes/transport.ts` save and read a bot's look, with the block's types in `src/hermes/bots.ts`. `ProfilesApi.edit` in `src/hermes/profiles.ts` saves a description and model. `ProfileForm` in `src/ui/ProfileSettings.tsx` is the dialog, and `src/ui/Bots.tsx` has the row menu. Tested in `src/hermes/fieldMerge.test.ts`, `src/hermes/botsTransport.test.ts`, `src/hermes/manageProfiles.test.ts`, `src/ui/bots.test.tsx`, `src/ui/botsTranslated.test.tsx` and `src/ui/profileSettings.test.tsx`.

Issue #646: the owner wanted to manage bots from the Bots view, without going to Settings → Profiles, the Hermes CLI or Hermes's desktop app. Edit, rename, clone and delete lived only in Settings → Profiles. A bot's Bot Mode name, colour, picture, Pin and Hide could not be changed here at all.

A bot's name, colour, Pin and Hide live in `ui_meta['hermes-bots']` in the profile's `profile.yaml`. Hermes's desktop keeps its own state in the same block: the section a bot is filed in, its groups, its shape. Hermes `f0d94882` replaces that whole block on every write. It keeps one revision number for the block, and checks it only when the client sends the revision it expects (read in `tui_gateway/methods_profiles.py` `_configure_ui_meta`, and probed live on 2026-11-16). A write without an expected revision replaced the whole block, and the desktop's keys in it were lost.

Hermes's desktop retries a rejected save by reading the block again and applying its change to it. If another client changed the same field in between, that retry writes over it. The owner's rule for this app is stricter: the desktop's keys must survive, and a bot changed elsewhere in the meantime must never be overwritten.

## Decisions

- **A save takes edits, and each edit carries what the owner was shown.** An edit is `{from, to}`: the value the owner saw, and the value they asked for. For Edit bot, `from` is the read made when the dialog opened. For Pin and Hide, it is the row's own value.
- **One rule decides each edited field** (`plan`), against what Hermes has now:
  - Hermes has `to`: saved, and nothing is sent. A lost write landed, or someone made the same change.
  - Hermes has `from`: the field is written.
  - Hermes has anything else: it changed elsewhere. Nothing is written for that field, and the save reports Hermes's value.

  A field the owner didn't change is never compared and never sent. A switch (Pin, Hide) has only two values, so it never conflicts.
- **The block is written with the revision just read, and every other key is sent back as read.** `Hermes.editBot` reads `profiles.list`, changes only the edited fields in the block, and sends `profiles.configure` with `ui_meta_expected_revisions`. When Hermes answers that the block moved, the save reads again and applies the rule again, always against the edit's `from` and never against its own last read. It tries three times, then says Hermes kept changing the bot, with nothing written. Hermes checks and writes under one lock, so the keys the app doesn't edit are exactly as Hermes held them at that instant.
- **A write without an expected revision can't be typed.** The block and its revision are branded types that only `blockOf` makes, and `configureParams` is the only builder of the request. It sends `name`, `ui_meta` and `ui_meta_expected_revisions` and nothing else: Hermes refuses a request with a param its contract lacks. A Hermes whose rows report no `ui_meta_revisions` can't check, so nothing is sent to it and the save says so. In the tests, every `profiles.configure` the app sends is checked for a whole-number expected revision.
- **What Hermes's desktop needs beside a change goes with it.** A colour or picture change sets `custom: true`, and a picture sets `imageKind` to `photo`, or `shape` when it is removed, as the desktop's own edit does. A name is written trimmed, and a colour set back to Hermes's own removes the key.
- **The picture goes first, through `profiles.set_asset`, which has no revision.** It is read and compared before it is written. Pictures are compared by their bytes: Hermes sniffs the format and labels what it answers with what it found, so a PNG sent as a JPEG reads back as a PNG. A picture is saved only once its block keys are saved too. If the block write fails after the picture was stored, the picture stays an edit in the dialog, and the next Save writes the keys without storing it again.
- **Every save reads back.** The roster every view shows is read again, and the dialog shows what Hermes has. A write whose answer was lost counts as saved once the read-back has it. A saved field that reads back as something else was written over straight after, and shows as changed elsewhere with that value.
- **Edit bot is Settings → Profiles' Edit form with the bot's look** (`ProfileForm` with `bot`), as New bot is its New form (ADR 0164). It has the name in Bot Mode, the colour and the picture, then the description, the model, the persona link and the profile's name. Description and model go through `ProfilesApi.edit`, which applies the same rule around `PUT …/description` and `PUT …/model`. Settings → Profiles' Edit saves through it too, so it no longer writes over a description or model changed since the dialog opened.
- **A field changed elsewhere keeps the owner's text.** The dialog stays open. The field shows "Changed elsewhere since you opened this. Hermes has “Quill” now." with **Use Hermes's**, which puts Hermes's value in the field. The owner has now seen that value, so it becomes what the next Save is checked against. A second Save replaces it, unless Hermes moved again.
- **The profile is renamed last, and only once every other field saved.** A field changed elsewhere is not saved, so the name is never changed under a dialog that shows a conflict. The rename is ADR 0156's: this computer's data is re-keyed. Hermes moves the block, its revisions and the picture with the folder.
- **Each row of the Bots view has a menu**: Edit bot…, Clone…, Pin or Unpin, Hide or Show, Open in Settings → Profiles, and Delete bot…. It opens from the row's ⋯ button, a right-click, Shift+F10 or the Menu key. Clone and Delete are Settings → Profiles' own dialogs (ADR 0074, ADR 0156), and Delete switches to `default` first when the bot's profile is in use. `default` can't be deleted, and the menu says why. The bots in the chat list panel have no menu.
- **`profiles.configure` and `profiles.set_asset` are capability actions of Profiles**, not write methods of Bot Mode. A Hermes without `profiles.configure` has Pin, Hide, the name and the colour turned off, with the method named, and still shows its bots. A capability action can now be a JSON-RPC method as well as a dashboard route. The picture needs both methods, since its save ends with a block write.
- **The Bots view reads every word from the catalogue** (ADR 0100), and a pseudo-locale test checks it, its menu and Edit bot.

## What is guaranteed, and what isn't

- **Name in Bot Mode, colour, Pin and Hide.** A change another client made to a field since the owner saw it is never written over, and no key the app doesn't edit is lost. Hermes's revision check makes this hold even for a change that lands between the app's read and its write.
- **Description, model and picture.** Hermes has no revision for these. A change made since the owner saw the field is caught. A change that lands in the one round trip between the app's read and its write is written over, as with the persona (ADR 0014).
- **A model's provider reads back respelt.** Hermes stores a provider under its canonical id (probed: `Stub` is stored as `custom:stub`) and the model name as sent. So the read-back after the app's own `PUT` judges the model by its name alone: the same name is saved, and another name is someone else's change. A different provider with the same name, written straight after the app's, isn't caught. The dialog shows the model as Hermes reports it.
- **Hermes's desktop can still write over this app's change** with its own retry.

## Considered options

- **The desktop's retry: read again and re-apply the change.** The least code. Rejected: it writes over a change another client made to the same field between the read and the write, which is the one thing the owner ruled out. A test fails on it.
- **Hold the block and its revision from when the dialog opened, and send that revision.** Rejected: any change to any key, such as the desktop filing the bot into a section, would reject the save, and the dialog would have to merge field by field anyway.
- **A separate Edit bot dialog.** Rejected: it would be a second way to save a description, a model and a rename, beside ADR 0156's.
- **Writing the description through `profiles.configure`.** Rejected: that method's sections have no revision either, and ADR 0156's routes already save it.

## Consequences

- A save costs one `profiles.list` before it and one after, and a `profiles.get_asset` each way when the picture is edited.
- Pin and Hide take the row's last read as what the owner saw, which can be 15 seconds old. For a switch that is harmless.
- Keys Hermes's desktop strips on its own saves, such as a legacy `chat` key, are kept. A block over Hermes's 64 KB limit is refused by Hermes, and the save says it wasn't saved.
- New bot still writes no Bot Mode block. A new bot's name, colour and picture are set afterwards with Edit bot.
- The Clone dialog the menu opens is not on the catalogue yet.
