# Office HQ stage 1 (#281)

Taken with the verify skill (`.claude/skills/verify-hermes-chat`) in the real app, headless, against the stand-in dashboard, except 8, which is the owner's Hyprland desktop with its graphics card. The CPU measurements are in [cpu.md](cpu.md).

1. `1-three-typing-dark.png`: a chat that delegated to two subagents. Its reply and both subagents type at one group of Workroom desks, in one team color, each under a name tag.
2. `2-three-typing-light.png`: the same, in light mode. Walls, floors and light follow the theme; the team color doesn't.
3. `3-card-dark.png`: "Read the tests" clicked. Its card shows the chat, profile, state, goal, what it is doing now, model, how long it has run, and Open chat.
4. `4-at-rest-dark.png`: an Approval in the Waiting room (hand up, "!"), a failed reply in the Trouble room (slumped, red marker), and another profile's two Unread chats on a Lounge couch, each in its own color.
5. `5-at-rest-card-light.png`: the Approval's card, in light mode, with its selection ring on the floor.
6. `6-list-fallback-dark.png`: a run with WebGL unavailable (Mesa's GL and GLES versions capped below what WebGL needs). The office shows List and says why.
7. `7-list-fallback-light.png`: the same, in light mode.
8. `8-desktop-gpu-three-typing.png`: the delegating chat on the owner's desktop, from the CPU run there. Taken before the pods were numbered from the Workroom door, so the team sits at the far pod.
9. `9-open-chat-light.png`: Open chat on "Read the tests": the office closes and the chat opens with the subagent focused in its Subagents panel, where its desk went before.

Shots 4 to 7 came from a build before the pods were numbered from the door; nothing else in them changed.
