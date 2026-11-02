//! Screenshots for the composer: the owner picks a region or a window, and the capture is staged as an image
//! attachment, to review before sending. Nothing leaves this computer until the message is sent.
//!
//! How a capture is taken depends on the desktop:
//! - Hyprland, Sway and other wlroots compositors: slurp lets the owner drag a region or click a window, and grim saves
//!   it. Their screenshot portals (xdg-desktop-portal-hyprland and -wlr) capture the whole screen or need slurp
//!   themselves, so without slurp and grim the owner is told to install them, and nothing is captured.
//! - Everywhere else (GNOME, KDE Plasma): the xdg-desktop-portal Screenshot portal, asked to be interactive, so the
//!   desktop shows its own region and window picker. A portal too old to offer a picker is refused the same way.
//!
//! Captures are written to a private folder, `$XDG_RUNTIME_DIR/hermes-chat/captures/<pid>/`, which only this user can
//! read and which is in memory on systemd systems. Each is deleted when it is removed from the composer, once its
//! message is sent, and when the app exits; folders left by an app that crashed are swept at the next start. A file the
//! portal wrote in a temporary folder is deleted once copied; one it saved anywhere else (some desktops keep a copy in
//! Pictures) is the desktop's and is left alone.

use serde::Serialize;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

/// How long the owner has to pick a region or window before the capture gives up.
pub const PICK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long grim, hyprctl or swaymsg may take.
const TOOL_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a capture produced no image. Sent to the webview as `{ kind, message }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum CaptureError {
    /// The owner backed out of the picker. Not an error to show.
    #[error("The screenshot was cancelled.")]
    Cancelled,
    /// The desktop refused.
    #[error("{0}")]
    Denied(String),
    /// Nothing on this desktop can take one.
    #[error("{0}")]
    Unsupported(String),
    /// Another capture is still waiting for its pick.
    #[error("A screenshot is already being taken.")]
    Busy,
    #[error("{0}")]
    Failed(String),
}

fn failed(what: &str, e: impl std::fmt::Display) -> CaptureError {
    CaptureError::Failed(format!("{what}: {e}"))
}

/// A capture staged for the composer, and anything the owner should know about how it was taken.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Capture {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Where slurp's window outlines come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Windows {
    Hyprland,
    Sway,
    /// slurp still picks regions; it has no window list to offer.
    None,
}

/// How a capture is taken on this desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    GrimSlurp(Windows),
    Portal,
    /// A wlroots compositor without slurp or grim: its portal can't let the owner pick, so nothing is captured.
    NeedsSlurpAndGrim,
}

/// Picks the capture method from the session's environment and the tools on PATH.
pub fn plan(env: impl Fn(&str) -> Option<String>, has: impl Fn(&str) -> bool) -> Method {
    let set = |k: &str| env(k).is_some_and(|v| !v.is_empty());
    let desktop = env("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let desktops: Vec<&str> = desktop.split(':').collect();
    let wayland = set("WAYLAND_DISPLAY") || env("XDG_SESSION_TYPE").as_deref() == Some("wayland");
    let hyprland = set("HYPRLAND_INSTANCE_SIGNATURE") || desktops.contains(&"hyprland");
    let sway = set("SWAYSOCK") || desktops.contains(&"sway");
    let wlroots = hyprland
        || sway
        || desktops
            .iter()
            .any(|d| matches!(*d, "river" | "labwc" | "wayfire" | "wlroots"));
    if !(wayland && wlroots) {
        return Method::Portal;
    }
    if !(has("grim") && has("slurp")) {
        return Method::NeedsSlurpAndGrim;
    }
    let windows = if hyprland && has("hyprctl") {
        Windows::Hyprland
    } else if sway && has("swaymsg") {
        Windows::Sway
    } else {
        Windows::None
    };
    Method::GrimSlurp(windows)
}

/// `tool` is an executable file in one of PATH's folders.
pub fn on_path(tool: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| {
            std::fs::metadata(dir.join(tool))
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
    })
}

/// This session's capture method.
pub fn current_method() -> Method {
    plan(|k| std::env::var(k).ok(), on_path)
}

/// What the Settings screen says about screenshots on this desktop. `ok` false: a capture will fail, and `summary`
/// says what to install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Support {
    pub ok: bool,
    pub summary: String,
}

const NO_PORTAL: &str = "No screenshot portal is running. Install xdg-desktop-portal and the backend for your desktop \
(xdg-desktop-portal-gnome, -kde, -hyprland or -wlr), or on Hyprland and Sway install slurp and grim.";
const NEEDS_SLURP_AND_GRIM: &str =
    "On Hyprland, Sway and other wlroots desktops, Hermes Chat picks a region or window \
with slurp and grim. Install both (on Arch: sudo pacman -S slurp grim), then try again.";
const PORTAL_TOO_OLD: &str =
    "Your desktop's screenshot portal is too old to let you pick a region or window. Update \
xdg-desktop-portal and its backend for your desktop.";

/// How screenshots are taken here, for Settings. Asks the portal for its version, so it can block briefly.
pub fn support() -> Support {
    match current_method() {
        Method::GrimSlurp(windows) => Support {
            ok: true,
            summary: match windows {
                Windows::None => "Screenshots use slurp and grim: drag to select a region.".into(),
                _ => "Screenshots use slurp and grim: drag to select a region, or click a window.".into(),
            },
        },
        Method::NeedsSlurpAndGrim => Support { ok: false, summary: NEEDS_SLURP_AND_GRIM.into() },
        Method::Portal => match portal::version() {
            Ok(v) if v >= 2 => Support {
                ok: true,
                summary: "Screenshots use your desktop's screenshot portal, which asks you to pick a region or window.".into(),
            },
            Ok(_) => Support { ok: false, summary: PORTAL_TOO_OLD.into() },
            Err(e) => Support { ok: false, summary: e.to_string() },
        },
    }
}

/// Only one capture at a time: a second shortcut press while the picker is up does nothing.
static CAPTURING: AtomicBool = AtomicBool::new(false);
struct Turn;
impl Turn {
    fn take() -> Result<Turn, CaptureError> {
        CAPTURING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Turn)
            .map_err(|_| CaptureError::Busy)
    }
}
impl Drop for Turn {
    fn drop(&mut self) {
        CAPTURING.store(false, Ordering::Release);
    }
}

/// Takes a screenshot of a region or window the owner picks, and stages it in `captures` as `<name>.png`.
pub async fn capture(captures: &Captures, name: &str) -> Result<Capture, CaptureError> {
    let _turn = Turn::take()?;
    match current_method() {
        Method::GrimSlurp(windows) => {
            let path = grim_slurp(captures, windows, name).await?;
            Ok(Capture {
                path: path.to_string_lossy().into_owned(),
                note: None,
            })
        }
        Method::NeedsSlurpAndGrim => Err(CaptureError::Unsupported(NEEDS_SLURP_AND_GRIM.into())),
        Method::Portal => {
            let source = tokio::task::spawn_blocking(|| {
                // Version 1 has no picker: it would capture the whole screen without asking.
                if portal::version()? < 2 {
                    return Err(CaptureError::Unsupported(PORTAL_TOO_OLD.into()));
                }
                portal::screenshot(PICK_TIMEOUT)
            })
            .await
            .map_err(|e| failed("The screenshot stopped", e))??;
            let scratch = is_scratch(&source);
            let path = captures.adopt(&source, name, scratch)?;
            let note = (!scratch && source.exists()).then(|| {
                format!(
                    "Your desktop also saved its own copy at {}.",
                    source.display()
                )
            });
            Ok(Capture {
                path: path.to_string_lossy().into_owned(),
                note,
            })
        }
    }
}

// ---- slurp and grim ----

async fn grim_slurp(
    captures: &Captures,
    windows: Windows,
    name: &str,
) -> Result<PathBuf, CaptureError> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    let boxes = window_boxes(windows).await;
    let mut slurp = Command::new("slurp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| failed("Couldn't start slurp", e))?;
    if let Some(mut stdin) = slurp.stdin.take() {
        // With no outlines, slurp still picks regions; a write error just means it didn't read them.
        let _ = stdin.write_all(boxes.join("\n").as_bytes()).await;
    }
    let picked = tokio::time::timeout(PICK_TIMEOUT, slurp.wait_with_output())
        .await
        .map_err(|_| {
            CaptureError::Failed(
                "Nothing was picked within 5 minutes, so the screenshot was cancelled.".into(),
            )
        })?
        .map_err(|e| failed("slurp failed", e))?;
    let geometry = slurp_outcome(picked.status.success(), &picked.stdout, &picked.stderr)?;

    let path = captures.slot(&format!("{}.png", capture_stem(name)))?;
    let grim = Command::new("grim")
        .args(["-t", "png", "-g", &geometry])
        .arg(&path)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = match tokio::time::timeout(TOOL_TIMEOUT, grim).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            captures.discard(&path);
            return Err(failed("Couldn't start grim", e));
        }
        Err(_) => {
            captures.discard(&path);
            return Err(CaptureError::Failed(
                "grim didn't finish the screenshot.".into(),
            ));
        }
    };
    let checked = grim_outcome(out.status.success(), &out.stderr)
        .and_then(|()| check_image(&path).map(|_| ()))
        .and_then(|()| {
            // grim writes with the umask; the folder is private already, the file is made so too.
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| failed("Couldn't save the screenshot", e))
        });
    if let Err(e) = checked {
        captures.discard(&path);
        return Err(e);
    }
    Ok(path)
}

/// slurp's answer: a `x,y wxh` geometry, or why there isn't one.
pub fn slurp_outcome(ok: bool, stdout: &[u8], stderr: &[u8]) -> Result<String, CaptureError> {
    let err = String::from_utf8_lossy(stderr).trim().to_owned();
    if !ok {
        if err.contains("cancel") {
            return Err(CaptureError::Cancelled);
        }
        if err.contains("layer") || err.contains("doesn't support") || err.contains("not support") {
            return Err(CaptureError::Unsupported(format!(
                "Your compositor doesn't let slurp pick a region: {err}"
            )));
        }
        return Err(CaptureError::Failed(format!(
            "slurp failed: {}",
            if err.is_empty() {
                "no reason given"
            } else {
                &err
            }
        )));
    }
    let geometry = String::from_utf8_lossy(stdout).trim().to_owned();
    if !is_geometry(&geometry) {
        return Err(CaptureError::Failed(format!(
            "slurp answered something that isn't a region: {geometry:?}"
        )));
    }
    Ok(geometry)
}

/// `x,y wxh`, with a non-empty size.
fn is_geometry(g: &str) -> bool {
    let Some((at, size)) = g.split_once(' ') else {
        return false;
    };
    let Some((x, y)) = at.split_once(',') else {
        return false;
    };
    let Some((w, h)) = size.split_once('x') else {
        return false;
    };
    x.parse::<i64>().is_ok()
        && y.parse::<i64>().is_ok()
        && w.parse::<u32>().is_ok_and(|w| w > 0)
        && h.parse::<u32>().is_ok_and(|h| h > 0)
}

pub fn grim_outcome(ok: bool, stderr: &[u8]) -> Result<(), CaptureError> {
    if ok {
        return Ok(());
    }
    let err = String::from_utf8_lossy(stderr).trim().to_owned();
    if err.contains("screencopy") || err.contains("doesn't support") || err.contains("not support")
    {
        return Err(CaptureError::Unsupported(format!(
            "Your compositor doesn't let grim capture the screen: {err}"
        )));
    }
    Err(CaptureError::Failed(format!(
        "grim failed: {}",
        if err.is_empty() {
            "no reason given"
        } else {
            &err
        }
    )))
}

/// The visible windows, as slurp outlines (`x,y wxh`), so a click picks one. Empty if the compositor can't say.
async fn window_boxes(windows: Windows) -> Vec<String> {
    async fn run(cmd: &str, args: &[&str]) -> Option<String> {
        let out = tokio::process::Command::new(cmd)
            .args(args)
            .kill_on_drop(true)
            .output();
        let out = tokio::time::timeout(TOOL_TIMEOUT, out).await.ok()?.ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }
    match windows {
        Windows::Hyprland => match (
            run("hyprctl", &["-j", "clients"]).await,
            run("hyprctl", &["-j", "monitors"]).await,
        ) {
            (Some(c), Some(m)) => hyprland_boxes(&c, &m),
            _ => vec![],
        },
        Windows::Sway => run("swaymsg", &["-t", "get_tree", "-r"])
            .await
            .map(|t| sway_boxes(&t))
            .unwrap_or_default(),
        Windows::None => vec![],
    }
}

/// Hyprland's windows on the workspaces on screen, from `hyprctl -j clients` and `hyprctl -j monitors`.
pub fn hyprland_boxes(clients: &str, monitors: &str) -> Vec<String> {
    use serde_json::Value;
    let (Ok(Value::Array(clients)), Ok(Value::Array(monitors))) = (
        serde_json::from_str(clients),
        serde_json::from_str(monitors),
    ) else {
        return vec![];
    };
    let shown: Vec<i64> = monitors
        .iter()
        .flat_map(|m| [&m["activeWorkspace"]["id"], &m["specialWorkspace"]["id"]])
        .filter_map(Value::as_i64)
        .filter(|id| *id != 0)
        .collect();
    let num = |v: &Value, i: usize| v.get(i).and_then(Value::as_i64);
    clients
        .iter()
        .filter(|c| c["mapped"].as_bool() != Some(false) && c["hidden"].as_bool() != Some(true))
        .filter(|c| {
            c["workspace"]["id"]
                .as_i64()
                .is_some_and(|id| shown.contains(&id))
        })
        .filter_map(|c| {
            let (x, y, w, h) = (
                num(&c["at"], 0)?,
                num(&c["at"], 1)?,
                num(&c["size"], 0)?,
                num(&c["size"], 1)?,
            );
            (w > 0 && h > 0).then(|| format!("{x},{y} {w}x{h}"))
        })
        .collect()
}

/// Sway's visible windows, from `swaymsg -t get_tree -r`.
pub fn sway_boxes(tree: &str) -> Vec<String> {
    use serde_json::Value;
    fn walk(node: &Value, out: &mut Vec<String>) {
        let window = node.get("pid").is_some_and(Value::is_number)
            || node.get("app_id").is_some_and(Value::is_string);
        if window && node["visible"].as_bool() == Some(true) {
            let r = &node["rect"];
            if let (Some(x), Some(y), Some(w), Some(h)) = (
                r["x"].as_i64(),
                r["y"].as_i64(),
                r["width"].as_i64(),
                r["height"].as_i64(),
            ) {
                if w > 0 && h > 0 {
                    out.push(format!("{x},{y} {w}x{h}"));
                }
            }
        }
        for key in ["nodes", "floating_nodes"] {
            if let Some(children) = node[key].as_array() {
                children.iter().for_each(|c| walk(c, out));
            }
        }
    }
    let mut out = vec![];
    if let Ok(tree) = serde_json::from_str::<Value>(tree) {
        walk(&tree, &mut out);
    }
    out
}

// ---- the portal ----

pub mod portal {
    //! The xdg-desktop-portal Screenshot portal over D-Bus: `Screenshot(parent, {interactive})`, then the answer comes
    //! as a `Response` signal on the request object.
    use super::CaptureError;
    use dbus::arg::{PropMap, RefArg, Variant};
    use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
    use dbus::blocking::Connection;
    use dbus::message::MatchRule;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const DEST: &str = "org.freedesktop.portal.Desktop";
    const PATH: &str = "/org/freedesktop/portal/desktop";
    const IFACE: &str = "org.freedesktop.portal.Screenshot";
    const CALL_TIMEOUT: Duration = Duration::from_secs(10);

    /// A D-Bus error from the portal, as the owner should read it.
    pub fn explain(name: &str, message: &str) -> CaptureError {
        match name {
            "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner" | "org.freedesktop.DBus.Error.FileNotFound" => {
                CaptureError::Unsupported(super::NO_PORTAL.into())
            }
            "org.freedesktop.DBus.Error.UnknownMethod" | "org.freedesktop.DBus.Error.UnknownInterface" | "org.freedesktop.DBus.Error.UnknownObject" | "org.freedesktop.DBus.Error.UnknownProperty" | "org.freedesktop.DBus.Error.InvalidArgs" => {
                CaptureError::Unsupported(
                    "Your desktop's portal doesn't offer screenshots. Install the portal backend for your desktop \
                     (xdg-desktop-portal-gnome, -kde, -hyprland or -wlr), or on Hyprland and Sway install slurp and grim."
                        .into(),
                )
            }
            "org.freedesktop.portal.Error.NotAllowed" | "org.freedesktop.DBus.Error.AccessDenied" => CaptureError::Denied(
                "Your desktop didn't allow Hermes Chat to take a screenshot. Check the screenshot permission in its privacy settings.".into(),
            ),
            _ => CaptureError::Failed(format!("The screenshot portal failed: {message}")),
        }
    }

    fn dbus_error(e: dbus::Error) -> CaptureError {
        explain(
            e.name().unwrap_or(""),
            e.message().unwrap_or("no reason given"),
        )
    }

    /// The portal's `Response`: code 0 with the file's URI, 1 when the owner cancelled, 2 for anything else (a refused
    /// permission, or a failure in the desktop's screenshot tool).
    pub fn response(code: u32, uri: Option<&str>) -> Result<PathBuf, CaptureError> {
        match code {
            0 => {
                let uri = uri.ok_or_else(|| CaptureError::Failed("The screenshot portal didn't say where it saved the screenshot.".into()))?;
                let url = url::Url::parse(uri).map_err(|_| CaptureError::Failed(format!("The screenshot portal gave an address that isn't a file: {uri}")))?;
                if url.scheme() != "file" {
                    return Err(CaptureError::Failed(format!("The screenshot portal gave an address that isn't a file: {uri}")));
                }
                url.to_file_path().map_err(|_| CaptureError::Failed(format!("The screenshot portal gave an address that isn't a file: {uri}")))
            }
            1 => Err(CaptureError::Cancelled),
            _ => Err(CaptureError::Denied(
                "Your desktop didn't take the screenshot. It may not allow Hermes Chat to take screenshots (check its privacy \
                 settings), or its screenshot tool failed."
                    .into(),
            )),
        }
    }

    /// The Screenshot portal's version; an error when there is no portal, or it has no Screenshot interface.
    pub fn version() -> Result<u32, CaptureError> {
        let conn = Connection::new_session().map_err(|e| {
            CaptureError::Unsupported(format!("Couldn't reach the desktop's session bus: {e}"))
        })?;
        let proxy = conn.with_proxy(DEST, PATH, CALL_TIMEOUT);
        proxy.get::<u32>(IFACE, "version").map_err(dbus_error)
    }

    /// Asks the portal for an interactive screenshot and waits up to `timeout` for the owner's pick. Returns the file
    /// the portal saved.
    pub fn screenshot(timeout: Duration) -> Result<PathBuf, CaptureError> {
        let conn = Connection::new_session().map_err(|e| {
            CaptureError::Unsupported(format!("Couldn't reach the desktop's session bus: {e}"))
        })?;
        // The request object's path is known ahead of the call, so the Response can't arrive before we listen for it.
        let token = format!(
            "hermes_chat_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        );
        let sender = conn.unique_name().trim_start_matches(':').replace('.', "_");
        let handle = format!("{PATH}/request/{sender}/{token}");
        let answer: Arc<Mutex<Option<(u32, Option<String>)>>> = Arc::default();
        let listen = |path: String| {
            let answer = answer.clone();
            let rule =
                MatchRule::new_signal("org.freedesktop.portal.Request", "Response").with_path(path);
            conn.add_match(rule, move |(code, results): (u32, PropMap), _, _| {
                let uri = results
                    .get("uri")
                    .and_then(|v| v.0.as_str())
                    .map(str::to_owned);
                *answer.lock().unwrap() = Some((code, uri));
                false
            })
        };
        listen(handle.clone()).map_err(dbus_error)?;

        let mut options = PropMap::new();
        options.insert("handle_token".into(), Variant(Box::new(token)));
        options.insert("interactive".into(), Variant(Box::new(true)));
        options.insert("modal".into(), Variant(Box::new(true)));
        let proxy = conn.with_proxy(DEST, PATH, CALL_TIMEOUT);
        let (request,): (dbus::Path<'static>,) = proxy
            .method_call(IFACE, "Screenshot", ("", options))
            .map_err(dbus_error)?;
        // Portals older than 0.9 pick their own request path.
        if &*request != handle.as_str() {
            listen(request.to_string()).map_err(dbus_error)?;
        }

        let deadline = Instant::now() + timeout;
        loop {
            if let Some((code, uri)) = answer.lock().unwrap().take() {
                return response(code, uri.as_deref());
            }
            if Instant::now() >= deadline {
                let _: Result<(), _> = conn.with_proxy(DEST, request, CALL_TIMEOUT).method_call(
                    "org.freedesktop.portal.Request",
                    "Close",
                    (),
                );
                return Err(CaptureError::Failed(
                    "Nothing was picked within 5 minutes, so the screenshot was cancelled.".into(),
                ));
            }
            conn.process(Duration::from_millis(250))
                .map_err(dbus_error)?;
        }
    }
}

// ---- where captures are kept ----

/// The folder captures are staged in, private to this user, and the subfolder this process owns.
#[derive(Debug)]
pub struct Captures {
    root: PathBuf,
    mine: PathBuf,
    next: AtomicU64,
}

fn my_uid() -> std::io::Result<u32> {
    Ok(std::fs::metadata("/proc/self")?.uid())
}

/// Makes `dir` if needed, and checks it is a real folder (not a link) that only this user can open.
fn private_dir(dir: &Path) -> Result<(), CaptureError> {
    let io = |e: std::io::Error| failed("Couldn't make a private folder for screenshots", e);
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(io(e)),
    }
    let meta = std::fs::symlink_metadata(dir).map_err(io)?;
    if !meta.is_dir()
        || meta.uid() != my_uid().map_err(io)?
        || meta.permissions().mode() & 0o077 != 0
    {
        return Err(CaptureError::Failed(format!(
            "Couldn't save the screenshot: {} isn't a private folder.",
            dir.display()
        )));
    }
    Ok(())
}

/// `$XDG_RUNTIME_DIR/hermes-chat/captures`, or `<temp>/hermes-chat-<uid>/captures` when there is no runtime folder.
pub fn default_root() -> Result<PathBuf, CaptureError> {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_dir());
    let base = match runtime {
        Some(r) => r.join("hermes-chat"),
        None => {
            let uid = my_uid().map_err(|e| failed("Couldn't find a folder for screenshots", e))?;
            std::env::temp_dir().join(format!("hermes-chat-{uid}"))
        }
    };
    Ok(base.join("captures"))
}

/// A capture's file name without its extension: the webview's `screenshot-<local time>`, if it is plain enough.
pub fn capture_stem(name: &str) -> String {
    let ok = !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        name.trim_end_matches(".png").to_owned()
    } else {
        "screenshot".to_owned()
    }
}

/// What a file holds, by its first bytes: the extension to give it, if it is an image the composer can preview.
pub fn image_ext(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if head.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else {
        None
    }
}

fn check_image(path: &Path) -> Result<&'static str, CaptureError> {
    use std::io::Read;
    let mut head = [0u8; 8];
    let n = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .map_err(|e| failed("Couldn't read the screenshot", e))?;
    image_ext(&head[..n])
        .ok_or_else(|| CaptureError::Failed("The screenshot isn't a PNG or JPEG image.".into()))
}

/// `path` is a regular file of this user's in a temporary folder (`$XDG_RUNTIME_DIR` or the system temp folder), where
/// a portal put a capture just for this request; anywhere else it is the desktop's own copy.
pub fn is_scratch(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    let Ok(uid) = my_uid() else { return false };
    if !meta.is_file() || meta.uid() != uid {
        return false;
    }
    let Ok(real) = path.canonicalize() else {
        return false;
    };
    let temp = [
        std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from),
        Some(std::env::temp_dir()),
    ];
    temp.into_iter()
        .flatten()
        .filter_map(|t| t.canonicalize().ok())
        .any(|t| real.starts_with(t))
}

impl Captures {
    /// Opens the captures folder at `root`, private to this user, with a subfolder for this process.
    pub fn open(root: PathBuf) -> Result<Captures, CaptureError> {
        if let Some(parent) = root.parent() {
            private_dir(parent)?;
        }
        private_dir(&root)?;
        let mine = root.join(std::process::id().to_string());
        Ok(Captures {
            root,
            mine,
            next: AtomicU64::new(0),
        })
    }

    /// This process's folder.
    pub fn mine(&self) -> &Path {
        &self.mine
    }

    /// A fresh path for a capture named `file_name`, in a private folder of its own, so names never clash.
    pub fn slot(&self, file_name: &str) -> Result<PathBuf, CaptureError> {
        private_dir(&self.mine)?;
        let dir = self
            .mine
            .join(self.next.fetch_add(1, Ordering::Relaxed).to_string());
        // A leftover from a crashed process with the same pid goes first.
        let _ = std::fs::remove_dir_all(&dir);
        private_dir(&dir)?;
        Ok(dir.join(file_name))
    }

    /// Copies a capture the portal saved into a slot, as `<name>.png` (or `.jpg`), readable only by this user, and
    /// deletes `source` if `remove_source`, even when it couldn't be copied.
    pub fn adopt(
        &self,
        source: &Path,
        name: &str,
        remove_source: bool,
    ) -> Result<PathBuf, CaptureError> {
        let adopted = self.copy_in(source, name);
        // A scratch copy goes whether or not it could be staged: nothing else would ever delete it.
        if remove_source {
            let _ = std::fs::remove_file(source);
        }
        adopted
    }

    fn copy_in(&self, source: &Path, name: &str) -> Result<PathBuf, CaptureError> {
        let meta =
            std::fs::metadata(source).map_err(|e| failed("Couldn't read the screenshot", e))?;
        if !meta.is_file() {
            return Err(CaptureError::Failed(
                "The screenshot portal didn't save a file.".into(),
            ));
        }
        let ext = check_image(source)?;
        let path = self.slot(&format!("{}.{ext}", capture_stem(name)))?;
        let copied = (|| -> std::io::Result<()> {
            let mut from = std::fs::File::open(source)?;
            let mut to = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            std::io::copy(&mut from, &mut to)?;
            to.sync_all()
        })();
        if let Err(e) = copied {
            self.discard(&path);
            return Err(failed("Couldn't save the screenshot", e));
        }
        Ok(path)
    }

    /// `path` is a capture this process staged. Only names inside its own folder count, so the webview can't use
    /// discarding to delete anything else.
    pub fn owns(&self, path: &Path) -> bool {
        path.is_absolute()
            && path.parent().and_then(Path::parent) == Some(self.mine.as_path())
            && !path.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
    }

    /// Deletes a staged capture and its folder. Anything else is left alone; returns whether it was one.
    pub fn discard(&self, path: &Path) -> bool {
        if !self.owns(path) {
            return false;
        }
        let _ = std::fs::remove_file(path);
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
        true
    }

    /// Deletes every capture this process staged; at exit.
    pub fn clear(&self) {
        let _ = std::fs::remove_dir_all(&self.mine);
    }

    /// Deletes the folders of processes that are gone: captures left behind when the app crashed or was killed.
    pub fn sweep(&self) {
        self.sweep_except(instance_alive);
    }

    /// `sweep`, with `alive` saying which pids are still a running Hermes Chat.
    pub fn sweep_except(&self, alive: impl Fn(u32) -> bool) {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name();
            let Some(pid) = name.to_str().and_then(|n| n.parse::<u32>().ok()) else {
                continue;
            };
            if pid != std::process::id() && !alive(pid) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

/// `pid` is a running Hermes Chat: it exists, isn't a zombie, and has this program's name. A pid reused by another
/// program, or one never reaped, doesn't keep a crashed run's captures around.
pub fn instance_alive(pid: u32) -> bool {
    let proc = Path::new("/proc").join(pid.to_string());
    let Ok(stat) = std::fs::read_to_string(proc.join("stat")) else {
        return false;
    };
    // The state follows the name in parentheses, which can itself hold spaces or parentheses.
    let state = stat
        .rsplit_once(") ")
        .and_then(|(_, rest)| rest.chars().next());
    if matches!(state, None | Some('Z') | Some('X')) {
        return false;
    }
    let comm = |p: &Path| std::fs::read_to_string(p.join("comm")).map(|c| c.trim_end().to_owned());
    matches!((comm(&proc), comm(Path::new("/proc/self"))), (Ok(a), Ok(b)) if a == b)
}
