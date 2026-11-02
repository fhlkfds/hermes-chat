pub mod fonts;
pub mod notify;
pub mod remote;
pub mod saved_password;
pub mod screenshot;
pub mod transport;
pub mod tunnel;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use transport::{Dashboard, LocalFile, Pipe, PipeEvent, SignIn};
use tunnel::Tunnel;

/// The owner's `hermes dashboard` port on the server's loopback (research doc, "SSH tunnel, Host header
/// and protocol generation").
const DASHBOARD_PORT: u16 = 9119;

struct Connection {
    dashboard: Arc<Dashboard>,
    pipe: Arc<Pipe>,
    _tunnel: Option<Tunnel>,
}

/// Where the owner signs in: through an SSH tunnel (ADR 0003), or straight to a dashboard URL.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Target {
    Ssh { target: String },
    Url { url: String },
}

/// How the connection reached the dashboard, for the webview to show and to decide whether it is Unsecure.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Route {
    Ssh { target: String },
    Url { url: String, addresses: Vec<String> },
}

#[derive(Default)]
struct AppState(Mutex<Option<Connection>>);

/// The private folder screenshots are staged in (screenshot.rs), opened at the first capture. And when the app was
/// started by `hermes-chat --screenshot` with no window open yet, when that was, so the first signed-in window takes it.
#[derive(Default)]
struct Screenshots {
    captures: std::sync::Mutex<Option<Arc<screenshot::Captures>>>,
    asked_at_launch: std::sync::Mutex<Option<std::time::Instant>>,
}

/// How long a screenshot asked for at launch still waits for sign-in. Any later, and it would surprise the owner.
const LAUNCH_REQUEST_FOR: std::time::Duration = std::time::Duration::from_secs(120);

impl Screenshots {
    fn captures(&self) -> Result<Arc<screenshot::Captures>, screenshot::CaptureError> {
        let mut slot = self.captures.lock().unwrap();
        if let Some(c) = &*slot {
            return Ok(c.clone());
        }
        let c = Arc::new(screenshot::Captures::open(screenshot::default_root()?)?);
        c.sweep();
        *slot = Some(c.clone());
        Ok(c)
    }
}

#[tauri::command]
async fn hermes_connect(
    state: State<'_, AppState>,
    target: Target,
    username: String,
    password: String,
    profile: String,
    on_event: Channel<PipeEvent>,
) -> Result<Route, String> {
    let mut slot = state.0.lock().await;
    *slot = None;
    let (base, tunnel, route) = match target {
        Target::Ssh { target } => {
            let tunnel = tunnel::open(&target, DASHBOARD_PORT).await.map_err(|e| e.to_string())?;
            let base = url::Url::parse(&format!("http://127.0.0.1:{}/", tunnel.local_port)).expect("valid URL");
            (base, Some(tunnel), Route::Ssh { target: target.trim().to_owned() })
        }
        Target::Url { url } => {
            let direct = transport::resolve_direct(&url).await.map_err(|e| e.to_string())?;
            let addresses = direct.addresses.iter().map(ToString::to_string).collect();
            (direct.base, None, Route::Url { url: url.trim().to_owned(), addresses })
        }
    };
    let dashboard = Dashboard::sign_in(&base, &SignIn { username, password }).await.map_err(|e| e.to_string())?;
    let pipe = dashboard
        .open_pipe(&profile, move |e| {
            let _ = on_event.send(e);
        })
        .await
        .map_err(|e| e.to_string())?;
    *slot = Some(Connection { dashboard: Arc::new(dashboard), pipe: Arc::new(pipe), _tunnel: tunnel });
    Ok(route)
}

#[tauri::command]
async fn hermes_send(state: State<'_, AppState>, frame: String) -> Result<(), String> {
    match &*state.0.lock().await {
        Some(conn) => conn.pipe.send(frame).map_err(|e| e.to_string()),
        None => Err(transport::TransportError::Closed.to_string()),
    }
}

#[tauri::command]
async fn hermes_send_file(
    state: State<'_, AppState>,
    head: String,
    path: String,
    tail: String,
    max_bytes: u64,
) -> Result<(), String> {
    // Reading a big file takes a while; don't hold the lock, so a Stop can still go out.
    let pipe = match &*state.0.lock().await {
        Some(conn) => conn.pipe.clone(),
        None => return Err(transport::TransportError::Closed.to_string()),
    };
    pipe.send_file(&head, &path, &tail, max_bytes).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn hermes_stat_files(paths: Vec<String>) -> Vec<LocalFile> {
    transport::stat_files(&paths).await
}

/// A staged image's bytes for its composer thumbnail, raw rather than as JSON.
#[tauri::command]
async fn hermes_read_preview(path: String) -> Result<tauri::ipc::Response, String> {
    transport::read_preview(&path).await.map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Takes a screenshot of a region or window the owner picks, staged privately as `<name>.png` for the composer.
#[tauri::command]
async fn screenshot_capture(state: State<'_, Screenshots>, name: String) -> Result<screenshot::Capture, screenshot::CaptureError> {
    let captures = state.captures()?;
    screenshot::capture(&captures, &name).await
}

/// Deletes a staged screenshot: removed from the composer, or its message sent. Paths that aren't one are ignored.
#[tauri::command]
fn screenshot_discard(state: State<'_, Screenshots>, path: String) {
    if let Some(c) = &*state.captures.lock().unwrap() {
        c.discard(std::path::Path::new(&path));
    }
}

/// How screenshots are taken on this desktop, for Settings.
#[tauri::command]
async fn screenshot_support() -> screenshot::Support {
    tokio::task::spawn_blocking(screenshot::support).await.unwrap_or_else(|e| screenshot::Support { ok: false, summary: e.to_string() })
}

/// Whether the app was started by `hermes-chat --screenshot` lately and nothing has taken that yet. True once.
#[tauri::command]
fn screenshot_launch_request(state: State<'_, Screenshots>) -> bool {
    state.asked_at_launch.lock().unwrap().take().is_some_and(|at| at.elapsed() < LAUNCH_REQUEST_FOR)
}

/// Brings the window forward after a desktop shortcut's screenshot was attached, so the owner can review it.
#[tauri::command]
fn screenshot_show_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
async fn hermes_request(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, String> {
    // Don't hold the lock across the request, so frames keep flowing while it runs.
    let dashboard = match &*state.0.lock().await {
        Some(conn) => conn.dashboard.clone(),
        None => return Err(transport::TransportError::Closed.to_string()),
    };
    dashboard.request(&method, &path, body).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn hermes_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    *state.0.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn password_load() -> Result<Option<String>, String> {
    saved_password::load().await
}

#[tauri::command]
async fn password_save(password: String) -> Result<(), String> {
    saved_password::save(password).await
}

#[tauri::command]
async fn password_delete() -> Result<(), String> {
    saved_password::delete().await
}

/// Saves an exported chat (src/hermes/exportChat.ts) where the owner picks in the native Save dialog, which asks
/// before replacing a file. The webview never names the path. `None`: the owner cancelled, and nothing was written.
#[tauri::command]
async fn chat_export(app: tauri::AppHandle, markdown: String, file_name: String) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export chat — the file may contain sensitive information from the chat")
        .set_file_name(file_name)
        .add_filter("Markdown", &["md"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, markdown).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
async fn notify_desktop(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    notify::show(app, title, body).await
}

/// The installed font families, for the Appearance settings.
#[tauri::command]
async fn system_fonts() -> fonts::Fonts {
    fonts::list().await
}

/// Starts the app. `screenshot`: it was started by `hermes-chat --screenshot`, with no other Hermes Chat to take it.
pub fn run(screenshot: bool) {
    let screenshots = Screenshots::default();
    if screenshot {
        *screenshots.asked_at_launch.lock().unwrap() = Some(std::time::Instant::now());
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(screenshots)
        .setup(|app| {
            remote::serve(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hermes_connect,
            hermes_send,
            hermes_send_file,
            hermes_stat_files,
            hermes_read_preview,
            hermes_request,
            hermes_disconnect,
            password_load,
            password_save,
            password_delete,
            chat_export,
            notify_desktop,
            system_fonts,
            screenshot_capture,
            screenshot_discard,
            screenshot_support,
            screenshot_launch_request,
            screenshot_show_window
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Screenshots never outlive the app.
            if let tauri::RunEvent::Exit = event {
                if let Some(c) = &*app.state::<Screenshots>().captures.lock().unwrap() {
                    c.clear();
                }
            }
        });
}
