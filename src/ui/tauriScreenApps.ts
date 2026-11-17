// The Screen's install of a terminal, a text editor and xclip on the server, through ssh
// (src-tauri/src/screen_apps.rs, ADR 0193). The password, if any, crosses to Rust here and goes on ssh's stdin.
import { invoke } from "@tauri-apps/api/core";
import type { SystemOutcome } from "../hermes/screenApps";

export type ScreenAppsInstaller = (target: string, password?: string) => Promise<SystemOutcome>;

export const tauriScreenApps: ScreenAppsInstaller = (target, password) => invoke<SystemOutcome>("screen_apps_install", { target, password: password ?? null });
