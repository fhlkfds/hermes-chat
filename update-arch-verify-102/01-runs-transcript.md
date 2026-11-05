# Issue #102 verification transcript

Copied from the command output of the session that ran these, on 2026-11-04 (America/Chicago), Arch Linux, kernel 7.2.11-arch1-1.
`S=tools/arch-update/sandbox.sh`. The app ran under Xvfb :102 with a private D-Bus session bus and a throwaway gnome-keyring. It
was signed in to a throwaway Hermes 0.22.7 dashboard (`HERMES_HOME=/tmp/hc102/hhome`, basic auth, 127.0.0.2:9502), started with
no model credentials, so no message reached a model provider.

## 1. Sandbox: the real pacman on a copy of the real database

```
$ S run sbx2 sh -c 'id; ls -la /usr/bin/hermes-chat /usr/bin/pacman; pacman -Q hermes-chat-git; pacman -Qqo /usr/bin/hermes-chat; touch /usr/bin/zz && echo writable'
uid=0(root) gid=0(root) groups=0(root),65534(nobody)
-rwxr-xr-x 1 root root 16945208 Nov  4 18:52 /usr/bin/hermes-chat
lrwxrwxrwx 1 root root       36 Nov  4 18:55 /usr/bin/pacman -> /tmp/hc102/sbx2/real/_usr_bin/pacman
hermes-chat-git r622.af77a05-1
hermes-chat-git
writable
$ S user sbx2 sh -c 'id; pacman -Qqo /usr/bin/hermes-chat'
uid=1000(liam) gid=1000(liam) groups=1000(liam),65534(nobody)
hermes-chat-git
```

Install the older package (r564.6017fa6-1, built from main by the owner on Nov 4, includes #61):

```
$ S run sbx3 pacman -U --noconfirm hermes-chat-git-r564.6017fa6-1-x86_64.pkg.tar.zst
warning: downgrading package hermes-chat-git (r622.af77a05-1 => r564.6017fa6-1)
...
downgrading hermes-chat-git...
ldconfig: Can't create temporary cache file /etc/ld.so.cache~: Permission denied      <- hooks outside the sandbox's writable paths
(2/3) Updating icon theme caches...  gtk-update-icon-cache: ... Permission denied
pacman exit 0
hermes-chat-git r564.6017fa6-1
/usr/bin/hermes-chat is owned by hermes-chat-git r564.6017fa6-1
5e4038f1068059be59dfe869d33450f64db779b965a3dec6b732a77dfa4b2e10  /usr/bin/hermes-chat
5e4038f1068059be59dfe869d33450f64db779b965a3dec6b732a77dfa4b2e10  -        (the package's own usr/bin/hermes-chat)
host:
hermes-chat-git r622.af77a05-1
390d8fc17557ad960d0b3b1154e026d531aaa4db1b7bdef41945ca3f4ef0c307  /usr/bin/hermes-chat
```

## 2. r564 app: version detection from the real database, then the documented upgrade under it

Settings → Updates in the running r564 app: "Version r622.af77a05 is available. You have r564.6017fa6-1", with the pull
requests merged since and `git pull && packaging/aur/build.sh -si` (screenshot E1).

The documented command ran from a clone of the repo at 6017fa6 (`02-documented-upgrade.log`). `PACMAN_AUTH` pointed makepkg's
`pacman -U` into the sandbox instead of doas; nothing else was changed. While it ran, the r564 process kept running:

```
$ ls -la /proc/428580/exe
lrwxrwxrwx 1 liam liam 0 Nov  4 18:57 /proc/428580/exe -> /usr/bin/hermes-chat (deleted)
```

## 3. Refocus, Restart: split panes, drafts, an uncertain message and a queue (r564 -> r622)

Before the refocus (localStorage, read-only sqlite):

```
hermes-chat.draft.["connection","8ca57b83-... => Draft in the chat pane, typed just before restart
hermes-chat.draft.["connection","8ca57b83-... => New chat draft in the right pane
hermes-chat.outbox.["connection","8ca57b83-... => [{"kind":"user","id":"u-4","text":"Uncertain: sent while Hermes was frozen","outgoing":{"state":"unknown",...
hermes-chat.queue.["connection","8ca57b83-... => {"items":[{"id":"1f13e974-...","text":"Queued: goes after the reply"}]}
```

(The dashboard was frozen with SIGSTOP for the uncertain send, and stayed frozen through the restart.)

Focus moved to a throwaway X window and back (no window manager on Xvfb). Settings then said "Version r622.af77a05-1 is
installed. Restart to use it; until then this window keeps running r564.6017fa6-1" (E3). Restart now:

```
before: name owner pid (uint32 428580,)
428580 /usr/bin/hermes-chat
snapshot file seen at 19:06:06.144249850
600 963                                   <- restart-drafts.json mode and size
after:
475779 /usr/bin/hermes-chat
/usr/bin/hermes-chat -> /proc/475779/exe  (not "(deleted)")
name owner pid (uint32 475779,)
no restart-drafts file left
$ sha256sum /usr/bin/hermes-chat /proc/475779/exe     (inside the sandbox)
390d8fc17557ad960d0b3b1154e026d531aaa4db1b7bdef41945ca3f4ef0c307  /usr/bin/hermes-chat
390d8fc17557ad960d0b3b1154e026d531aaa4db1b7bdef41945ca3f4ef0c307  /proc/475779/exe
```

The snapshot it wrote (`restart-drafts.captured.json`) held the 2 drafts, the outbox and the queue. After the restart,
localStorage had the same four keys, and the app showed both drafts, the queue paused ("Hermes Chat closed ... since these were
queued") and the uncertain message (E4, E5). The app came back with one pane.

After the dashboard was resumed (SIGCONT), the uncertain message was settled against the chat's history. Server side, the user
messages:

```
$ sqlite3 hhome/state.db "select role, substr(content,1,60), count(*) from messages group by role, content"
user|Create this chat for the restart test|1
user|Uncertain: sent while Hermes was frozen|1
```

Later (section 6) the queue was resumed and the screenshot message retried; the final count, each exactly once:

```
Create this chat for the restart test|1
Uncertain: sent while Hermes was frozen|1
Queued: goes after the reply|1
Uncertain with a screenshot|1
```

## 4. Restart of a copy started from a chat link

Branch package `hermes-chat-git-r599.568fea0-1` built with the PKGBUILD's own steps from this branch (`makepkg -s`, source
pointed at the branch).

Unfixed r622, started as `/usr/bin/hermes-chat 'hermes-chat://chat?id=20261104_190249_73f38c'`, restarted into r599:

```
t+1s: 567958 /usr/bin/hermes-chat hermes-chat://chat?id=20261104_190249_73f38c;      <- link passed to the new copy again
...
(uint32 567958,)
```

The new copy handled the link a second time ("Hermes Chat didn't open that link" again after the restart, E6). In this run the
old copy had exited before the new one could forward it over D-Bus, so the new copy didn't quit; the quit case is a race,
covered by the unit test `restarts_without_the_chat_link_it_was_started_for`.

Fixed r599 (still carrying that link in its own arguments), restarted into r622:

```
before: 567958 /usr/bin/hermes-chat hermes-chat://chat?id=20261104_190249_73f38c
t+1s: 588115 /usr/bin/hermes-chat;          <- no link
t+8s: 588115 /usr/bin/hermes-chat;
name owner: (uint32 588115,)
```

Before that restart, a file attached in the composer (`restart-notes.txt`) was named in the restart note (E7).

## 5. Recovery files that can't be read

Non-UTF-8 `restart-drafts.json` (`{"hermes-chat.draft.x": "caf\xe9 \xff\xfe"}`):
- r622: "couldn't finish putting back the drafts ... stream did not contain valid UTF-8" with Try again; Try again showed the
  same screen (E8).
- r599 (this branch): opened, the draft already in storage untouched, file renamed to `restart-drafts-1793841627.json`, Settings:
  "couldn't be read, because it isn't text (invalid utf-8 sequence of 1 bytes from index 28), so none were put back. The file is
  kept at ..." (E9).

Cut-short `restart-drafts.json` (`{"hermes-chat.draft.x": "half a thou`):

```
== branch r599 over a truncated copy
restart-drafts-1793841627.json
restart-drafts-1793841654.json          <- set aside, "isn't complete JSON (JSON Parse error: Unterminated string)"
== main r622 over a truncated copy
restart-drafts-1793841627.json
restart-drafts-1793841654.json
(restart-drafts.json present? no — deleted)
```

## 6. Screenshot outbox and a failed restart (branch r599)

slurp and grim were stand-in scripts (Xvfb has no Wayland compositor): slurp printed a fixed region and grim wrote a real PNG
with ImageMagick. The app's capture, staging and outbox code ran unchanged. With the dashboard frozen, the screenshot message
failed and stayed in the outbox with the capture:

```
-rw------- 1 liam liam 18868 Nov  4 19:22 home/.cache/hermes-chat/captures/595647/0/screenshot-2026-11-04-192201.png
hermes-chat.outbox... [{"kind":"user","id":"u-6","text":"Uncertain with a screenshot","attachments":["screenshot-2026-11-04-192201.png"],"outgoing":{"state":"failed",...
```

r622 installed under it, app data folder made read-only (`chmod 555`), Restart now: "Couldn't save your drafts before
restarting, so the app didn't restart: Permission denied (os error 13)" with Try again (E10). The same process kept running, and
no `restart-drafts.json` or `.part` file was left. Folder made writable, Try again:

```
t+1s: 610266 /usr/bin/hermes-chat;
name owner: (uint32 610266,)
-rw------- 1 liam liam 18868 Nov  4 19:22 .../screenshot-2026-11-04-192201.png      <- kept through the restart and startup sweep
hermes-chat.outbox... "Uncertain with a screenshot" ... "state":"failed"
```

Retry then sent it once, with the screenshot (E11 and the count above).

## 7. A copied binary

```
$ S run sbx3 pacman -Qqo /tmp/hc102/copied/hermes-chat
error: No package owns /tmp/hc102/copied/hermes-chat
```

Run from there, Settings said "This copy wasn't installed by pacman or as an AppImage, so it isn't updated from here", with no
update dot (E12).
