//! Files the owner pastes into the composer when the clipboard hands over bytes rather than a path: a screenshot,
//! or a file copied from a file manager that the webview won't give the path of. Each is written under the app's
//! cache directory so it can be attached like any other local file. Every paste gets its own folder, so the file
//! keeps the name Hermes sees. Nothing pasted is needed once the composer that held it is gone, so folders older
//! than a day are cleared at launch.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const KEEP_FOR: Duration = Duration::from_secs(86_400);

static NEXT: AtomicU64 = AtomicU64::new(0);

/// Writes `bytes` to a new folder under `dir` as `name`, and returns the file's path. Only the last part of `name`
/// is used, so it can't climb out of the folder.
pub async fn save(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let name = Path::new(name).file_name().map_or_else(|| "pasted".into(), |n| n.to_string_lossy().into_owned());
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let folder = dir.join(format!("{nanos}-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    tokio::fs::create_dir_all(&folder).await?;
    let path = folder.join(name);
    tokio::fs::write(&path, bytes).await?;
    Ok(path)
}

/// Deletes the paste folders under `dir` last written more than a day ago. Errors are ignored: the next launch
/// tries again.
pub async fn clear_old(dir: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let old = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .is_ok_and(|t| t.elapsed().is_ok_and(|age| age > KEEP_FOR));
        if old {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}
