// The real keyring: Rust keeps each saved connection's dashboard password, and its extra request headers as JSON, in
// the system keyring, one entry of each per connection id (src-tauri/src/saved_password.rs). The connection migrated
// from the single sign-in kept before passes no id, and keeps the entries it already had.
import { invoke } from "@tauri-apps/api/core";
import type { Keyring, Secrets } from "./account";
import type { SavedConnection } from "./connections";
import { asError } from "./tauriPipe";

function keyring(kind: "password" | "headers", c: SavedConnection): Keyring {
  const connection = c.legacy ? null : c.id;
  return {
    load: () => invoke<string | null>(`${kind}_load`, { connection }).then((v) => v ?? undefined, asError),
    save: (value) => invoke<void>(`${kind}_save`, { [kind]: value, connection }).catch(asError),
    delete: () => invoke<void>(`${kind}_delete`, { connection }).catch(asError),
  };
}

export const systemSecrets = (c: SavedConnection): Secrets => ({ password: keyring("password", c), headers: keyring("headers", c) });
