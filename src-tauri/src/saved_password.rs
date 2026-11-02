//! The dashboard password, kept in the system keyring (the Secret Service: GNOME Keyring or KWallet) so the
//! app can sign in at launch without asking, and beside it the extra request headers, whose values may be secrets
//! such as a Cloudflare Access client secret. The app keeps one sign-in, so there is one entry of each. The keyring
//! talks D-Bus and blocks, so each call runs off the async runtime.

use keyring::{Entry, Error};

const SERVICE: &str = "hermes-chat";
pub const PASSWORD: &str = "dashboard-password";
pub const HEADERS: &str = "extra-request-headers";

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
pub async fn load(account: &'static str) -> Result<Option<String>, String> {
    blocking(move || match entry(account)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    })
    .await
}

pub async fn save(account: &'static str, secret: String) -> Result<(), String> {
    blocking(move || entry(account)?.set_password(&secret)).await
}

/// Deletes the saved secret. Nothing saved counts as done.
pub async fn delete(account: &'static str) -> Result<(), String> {
    blocking(move || match entry(account)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    })
    .await
}
