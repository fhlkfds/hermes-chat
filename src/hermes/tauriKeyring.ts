// The real keyring: Rust keeps the dashboard password, and the extra request headers as JSON, in the system keyring
// (src-tauri/src/saved_password.rs).
import { invoke } from "@tauri-apps/api/core";
import type { Keyring } from "./account";
import { asError } from "./tauriPipe";

export const systemKeyring: Keyring = {
  load: () => invoke<string | null>("password_load").then((p) => p ?? undefined, asError),
  save: (password) => invoke<void>("password_save", { password }).catch(asError),
  delete: () => invoke<void>("password_delete").catch(asError),
};

export const systemHeaderKeyring: Keyring = {
  load: () => invoke<string | null>("headers_load").then((h) => h ?? undefined, asError),
  save: (headers) => invoke<void>("headers_save", { headers }).catch(asError),
  delete: () => invoke<void>("headers_delete").catch(asError),
};
