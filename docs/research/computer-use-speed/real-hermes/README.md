# Timing computer use on a real Hermes

The tools behind Step 4 of `../README.md`. They need a Hermes server with the Bot Desktop installed (TigerVNC, Xfce), `cua-driver`, and Node 20+ on both ends.

## A throwaway Hermes home

Everything runs on its own `HERMES_HOME`, so the owner's profiles, screens and approvals aren't touched.

1. On the server, make a home with a dashboard password and only what the bench needs (`H=/tmp/bench-home`):

   ```yaml
   _config_version: 52
   dashboard:
     basic_auth: { username: bench, password_hash: "<from plugins.dashboard_auth.basic.hash_password>", secret: "<random>" }
   approvals: { mode: "off" }   # tool_times.py and turn.mjs only; no one is there to approve
   agent: { image_input_mode: native }
   model: { default: z-ai/glm-5.3-flash, provider: openrouter, supports_vision: true }
   toolsets: [computer_use, vision]
   ```

   For `turn.mjs`, also put the provider's key line in `$H/.env` (mode 600), and delete it afterwards.
2. Start its dashboard from the checkout's venv, on a loopback address other than 127.0.0.1, so it asks for the password as a remote one does: `HERMES_HOME=$H venv/bin/hermes dashboard --host 127.0.0.2 --port 9611 --no-open --skip-build --isolated`. Running `venv/bin/hermes` against a fresh home can try to sync the venv's dependencies first; on the server used here that failed harmlessly and it carried on with the existing ones.
3. On this computer, forward it the way the app does, keeping the same address so the dashboard's Host check passes: `ssh -N -L 127.0.0.2:9611:127.0.0.2:9611 <server>`.
4. Start the screen with `display.start` (any RPC client; `rpc.mjs` has one), then open `page.html` full-screen on it: `DISPLAY=:<n> XAUTHORITY=$H/bot-desktop/Xauthority <Hermes's chromium> --user-data-dir=$H/chrome --kiosk file://…/page.html`. On the page, `t` flips a full-screen gradient, `s` scrolls the article 400 px, `w` goes back to the top, `f` clears the flip, `a` starts the animated canvas and `z` stops it.

## The tools

| File | What it times | Where it runs |
| --- | --- | --- |
| `measure.mjs` (with `rfb.mjs`, `rpc.mjs`) | The stream: fence round trips, key → first update, the lossless refresh, a busy canvas's frame rate. `DIRECT=unix:$H/bot-desktop/rfb.sock` reads Xvnc's socket instead of the bridge. | This computer (through the tunnel) and the server (`node --experimental-websocket` on Node 20) |
| `turn.mjs`, `loop.py` | One real chat turn through Hermes's loop, split into model round trips and tool times. | This computer |
| `tool_times.py` | Each `computer_use` action, called as the agent calls it. | The server, from the hermes-agent checkout |
| `model_turn.py` | One model turn against the number and size of screenshots in it, and against reasoning effort. Costs a few cents of the provider's credit. | The server, from the hermes-agent checkout |
| `app-trace.patch`, `app_trace.py` | The app's share: when Rust got each chunk, when the webview did, when noVNC drew, and each `/api/ws` frame's handling and Saved-copy writes during a turn. Not shipped: apply it, build with `VITE_SCREEN_BENCH_URL`, `VITE_SCREEN_BENCH_PW` (and `VITE_SCREEN_BENCH_PROMPT` for a turn), and run the build with `SCREEN_BENCH=1`. | This computer, on Xvfb (`GDK_BACKEND=x11`, no `WAYLAND_DISPLAY`) |

`runs/` holds what each produced on 2026-11-05 (`app-stream.log.xz` is the in-app stream trace; `app_trace.py` reads it as it is). The server's own model latencies (`model-latency-from-logs.txt`) are aggregates of its `agent.log` lines. Only the counts and timings are kept.

Clean up afterwards: stop the dashboard and the screen, then delete `$H`, the key line included.
