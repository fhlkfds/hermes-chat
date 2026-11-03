//! The dashboard passwords, kept in the system keyring (the Secret Service: GNOME Keyring or KWallet) so the app can
//! sign in at launch without asking, and beside them the extra request headers, whose values may be secrets such as a
//! Cloudflare Access client secret. Each saved connection has one entry of each, named by its stable id
//! (`dashboard-password/<id>`). The connection migrated from the single sign-in kept before keeps the entries it
//! already had (`dashboard-password`, `extra-request-headers`). The keyring talks D-Bus and blocks, so each call runs
//! off the async runtime.

use keyring::{Entry, Error};

const SERVICE: &str = "hermes-chat";
pub const PASSWORD: &str = "dashboard-password";
pub const HEADERS: &str = "extra-request-headers";

/// The keyring account for `base` (`PASSWORD` or `HEADERS`) of one connection. `None`: the migrated connection's own
/// entry. An id is a UUID as the webview makes it: lowercase letters, digits and dashes, 8 to 64 of them, so it can't
/// name another entry.
pub fn account(base: &str, connection: Option<&str>) -> Result<String, String> {
    match connection {
        None => Ok(base.to_string()),
        Some(id) if (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') => {
            Ok(format!("{base}/{id}"))
        }
        Some(_) => Err("That isn't a saved connection's id.".to_string()),
    }
}

fn entry(account: &str) -> Result<Entry, Error> {
    Entry::new(SERVICE, account)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("The system keyring failed: {e}"))
}

/// The saved secret, or none if nothing is saved.
pub async fn load(account: String) -> Result<Option<String>, String> {
    blocking(move || match entry(&account)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    })
    .await
}

pub async fn save(account: String, secret: String) -> Result<(), String> {
    blocking(move || entry(&account)?.set_password(&secret)).await
}

/// Deletes the saved secret. Nothing saved counts as done.
pub async fn delete(account: String) -> Result<(), String> {
    blocking(move || match entry(&account)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_migrated_connection_keeps_its_old_entries() {
        assert_eq!(account(PASSWORD, None).unwrap(), "dashboard-password");
        assert_eq!(account(HEADERS, None).unwrap(), "extra-request-headers");
    }

    #[test]
    fn each_connection_has_its_own_entries() {
        let id = "3f2c1a9e-7b4d-4c1e-9a2f-0d6b8e5c4a31";
        assert_eq!(account(PASSWORD, Some(id)).unwrap(), format!("dashboard-password/{id}"));
        assert_eq!(account(HEADERS, Some(id)).unwrap(), format!("extra-request-headers/{id}"));
    }

    #[test]
    fn an_id_cant_name_another_entry() {
        for bad in ["", "short", "../dashboard-password", "ABCDEF12-0000", "a b c d e f g h", "x/../../y-123456", &"a".repeat(65)] {
            assert!(account(PASSWORD, Some(bad)).is_err(), "{bad:?}");
        }
    }
}
