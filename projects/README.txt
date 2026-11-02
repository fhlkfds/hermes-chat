Actual Hermes Chat Tauri screenshots, 2026-11-02.
Feature head: 2d92bc04697cdf43191ce3e98b58e94f4f84ee78.
Built with npx tauri build --debug --no-bundle. Captured from its WebKitGTK window on Xvfb :63 using framebuffer xwd2png; driven with xdotool.
Backend: deployed Hermes code bf0203a, isolated loopback dashboard on the remote server, throwaway HERMES_HOME, synthetic chats and temporary git repositories with one pre-existing worktree. Connected through local SSH forwarding at http://127.0.0.1:19119 in URL sign-in mode. Real user Hermes data was not opened.
project.png: remote folder paths, connection and branch/worktree details after adding an existing worktree.
folder-error.png: refused missing remote folder; no folder creation.
filtered-chats.png: project filter, two Active chats, one Settled unread chat.
chat-menu.png: checked Homelab membership, independently toggleable project associations.
No screenshots were composited or edited. Earlier manual runs also verified creation, persistence after restart, and project deletion preserving all seven chats and all fixture folders.
No AI provider is configured for this throwaway backend; a real model response was not validated.
