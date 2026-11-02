// Updates. How this copy of the app was installed decides who may replace it:
// - pacman owns it (the hermes-chat-git PKGBUILD): only the package manager replaces its files. The app reports the
//   package's version, and notices when pacman has installed a newer one, so a restart picks it up.
// - a standalone AppImage built with an update key: Tauri's updater downloads the release, checks its signature against
//   the key built into the app, and swaps the AppImage. Nothing else ever goes through the updater, because with no
//   bundle type it would overwrite whatever file the binary runs from.
// - anything else (a build from source): nothing here updates it.
// The webview checks GitHub for the pacman case itself (src/hermes/updates.ts).
use serde::Serialize;
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::utils::config::BundleType;
use tauri::utils::platform::{bundle_type, current_exe};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::process::Command;
use tokio::sync::{Mutex, OnceCell};

#[derive(Default)]
pub struct Updates {
    /// The owning package and its version when the app started, read once: after pacman replaces the binary the running
    /// process is still the old one.
    started: OnceCell<Option<(String, String)>>,
    /// The update the last check found, for the owner to install.
    found: Mutex<Option<Update>>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Install {
    /// `running`: the package version the app started from. `installed`: the version pacman has now, `None` if the
    /// package is gone.
    Pacman { package: String, running: String, installed: Option<String> },
    /// `updater`: built with an update key and endpoint, so it can update itself.
    AppImage { version: String, updater: bool },
    Unmanaged { version: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    version: String,
    current: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Progress {
    Downloading { downloaded: u64, total: Option<u64> },
    Installing,
}

/// `pacman -Q` prints `name version`.
fn parse_query(stdout: &str) -> Option<String> {
    let mut words = stdout.split_whitespace();
    words.next()?;
    words.next().map(str::to_owned)
}

async fn pacman(args: &[&std::ffi::OsStr]) -> Option<String> {
    let out = Command::new("pacman").args(args).output().await.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

async fn package_version(package: &str) -> Option<String> {
    parse_query(&pacman(&["-Q".as_ref(), package.as_ref()]).await?)
}

/// The package that owns the binary the app started from, and its version. None without pacman, or for a file no
/// package owns.
async fn owner(exe: PathBuf) -> Option<(String, String)> {
    let package = pacman(&["-Qqo".as_ref(), exe.as_os_str()]).await?;
    let version = package_version(&package).await?;
    Some((package, version))
}

/// Running from an AppImage, which the updater replaces in place. A binary pulled out of one has no `APPIMAGE`.
fn is_appimage() -> bool {
    bundle_type() == Some(BundleType::AppImage) && std::env::var_os("APPIMAGE").is_some()
}

/// Whether this build has the updater's key and endpoints, so the plugin is registered (lib.rs).
pub fn configured(config: &tauri::Config) -> bool {
    config.plugins.0.contains_key("updater")
}

impl Updates {
    /// Reads the owning package now, before anything can replace it.
    pub async fn start(&self) {
        self.started.get_or_init(|| async { owner(current_exe().ok()?).await }).await;
    }
}

#[tauri::command]
pub async fn update_install_kind(app: AppHandle, state: State<'_, Updates>) -> Result<Install, String> {
    let version = app.package_info().version.to_string();
    if is_appimage() {
        return Ok(Install::AppImage { version, updater: configured(app.config()) });
    }
    state.start().await;
    Ok(match state.started.get().cloned().flatten() {
        Some((package, running)) => Install::Pacman { installed: package_version(&package).await, package, running },
        None => Install::Unmanaged { version },
    })
}

#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, Updates>) -> Result<Option<Available>, String> {
    if !is_appimage() || !configured(app.config()) {
        return Err("This copy of Hermes Chat can't update itself.".into());
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let available = update.as_ref().map(|u| Available {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    });
    *state.found.lock().await = update;
    Ok(available)
}

/// Downloads the update the last check found, verifies its signature and replaces the AppImage. The app keeps running
/// the old version until it restarts.
#[tauri::command]
pub async fn update_download_and_install(state: State<'_, Updates>, on_progress: Channel<Progress>) -> Result<(), String> {
    // Taken out while it installs, so a second click can't start another; put back if it fails, to try again.
    let Some(update) = state.found.lock().await.take() else {
        return Err("Check for updates again first.".into());
    };
    let (mut downloaded, mut sent) = (0u64, 0u64);
    let result = update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                // About 200 messages for a 100 MB download, rather than one per chunk.
                if downloaded - sent >= 512 * 1024 || Some(downloaded) == total {
                    sent = downloaded;
                    let _ = on_progress.send(Progress::Downloading { downloaded, total });
                }
            },
            || {
                let _ = on_progress.send(Progress::Installing);
            },
        )
        .await;
    if let Err(e) = result {
        *state.found.lock().await = Some(update);
        return Err(e.to_string());
    }
    Ok(())
}

fn drafts_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("restart-drafts.json"))
}

/// Restarts the app. `drafts` (every draft and outbox, from localStorage; updates.ts `DRAFT_PREFIXES`) is written to disk first, and nothing
/// restarts if that fails; the next launch puts them back (`restart_drafts_read`), in case the webview hadn't saved
/// the last keystrokes when the process ended.
#[tauri::command]
pub async fn app_restart(app: AppHandle, drafts: String) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = drafts_file(&app)?;
    let save = || -> std::io::Result<()> {
        std::fs::create_dir_all(path.parent().expect("a file in a directory"))?;
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path)?;
        file.write_all(drafts.as_bytes())?;
        file.sync_all()
    };
    save().map_err(|e| format!("Couldn't save your drafts before restarting, so the app didn't restart: {e}"))?;
    app.restart()
}

/// The drafts saved by the last restart, if any. The file stays until the webview has put them all back
/// (`restart_drafts_clear`), so a crash or a full store at launch doesn't lose them.
#[tauri::command]
pub async fn restart_drafts_read(app: AppHandle) -> Option<String> {
    std::fs::read_to_string(drafts_file(&app).ok()?).ok()
}

#[tauri::command]
pub async fn restart_drafts_clear(app: AppHandle) -> Result<(), String> {
    match std::fs::remove_file(drafts_file(&app)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_from_pacman_query() {
        assert_eq!(parse_query("hermes-chat-git r312.ef433a2-1\n"), Some("r312.ef433a2-1".into()));
        assert_eq!(parse_query("hermes-chat 1:0.2.0-3"), Some("1:0.2.0-3".into()));
        assert_eq!(parse_query("hermes-chat-git"), None);
        assert_eq!(parse_query(""), None);
    }

    #[test]
    fn install_serializes_for_the_webview() {
        let i = Install::Pacman { package: "hermes-chat-git".into(), running: "r1.abc1234-1".into(), installed: None };
        assert_eq!(
            serde_json::to_string(&i).unwrap(),
            r#"{"kind":"pacman","package":"hermes-chat-git","running":"r1.abc1234-1","installed":null}"#
        );
        let i = Install::AppImage { version: "0.1.0".into(), updater: false };
        assert_eq!(serde_json::to_string(&i).unwrap(), r#"{"kind":"appImage","version":"0.1.0","updater":false}"#);
    }
}
