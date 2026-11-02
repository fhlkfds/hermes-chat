pub mod fonts;
pub mod notify;
pub mod saved_password;
pub mod transport;
pub mod tunnel;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use transport::{Dashboard, LocalFile, Pipe, PipeEvent, ProbeFailure, SavedKey, SignIn, Stage};
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

/// `probe`: the connection test running now, so setup can stop it, and a new one replaces it.
#[derive(Default)]
struct AppState(Mutex<Option<Connection>>, std::sync::Mutex<Option<tokio::task::AbortHandle>>);

/// The dashboard root for `target`, the tunnel that reaches it (SSH only), and the route to report. Failures are
/// the owner's address or SSH (`Stage::Address`).
async fn open_target(target: Target) -> Result<(url::Url, Option<Tunnel>, Route), String> {
    Ok(match target {
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
    })
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
    let (base, tunnel, route) = open_target(target).await?;
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

/// A connection test that went through: how it reached the dashboard, plus what `transport::probe` read.
#[derive(Serialize)]
struct ProbeResult {
    route: Route,
    #[serde(flatten)]
    probed: transport::Probed,
}

/// Tests a sign-in for setup without keeping it, so the app's own connection, if any, carries on. Its own SSH
/// tunnel, if it opened one, closes when the test ends. A new test, or `hermes_probe_cancel`, stops the one before.
#[tauri::command]
async fn hermes_probe(
    state: State<'_, AppState>,
    target: Target,
    username: String,
    password: String,
    profile: String,
) -> Result<ProbeResult, ProbeFailure> {
    let task = tokio::spawn(async move {
        let (base, _tunnel, route) = open_target(target).await.map_err(|e| ProbeFailure::new(Stage::Address, e))?;
        let probed = transport::probe(&base, &SignIn { username, password }, &profile).await?;
        Ok(ProbeResult { route, probed })
    });
    if let Some(before) = state.1.lock().unwrap().replace(task.abort_handle()) {
        before.abort();
    }
    match task.await {
        Ok(result) => result,
        Err(e) if e.is_cancelled() => Err(ProbeFailure::new(Stage::Cancelled, "The test was stopped.")),
        Err(e) => Err(ProbeFailure::new(Stage::Address, e.to_string())),
    }
}

#[tauri::command]
fn hermes_probe_cancel(state: State<'_, AppState>) {
    if let Some(task) = state.1.lock().unwrap().take() {
        task.abort();
    }
}

/// Gives the signed-in Hermes a model provider's API key for `profile` (`Dashboard::save_provider_key`). The key
/// goes to the server and isn't kept on this computer.
#[tauri::command]
async fn hermes_save_provider_key(state: State<'_, AppState>, profile: String, key: String, value: String) -> Result<SavedKey, String> {
    let dashboard = match &*state.0.lock().await {
        Some(conn) => conn.dashboard.clone(),
        None => return Err(transport::TransportError::Closed.to_string()),
    };
    dashboard.save_provider_key(&profile, &key, &value).await.map_err(|e| e.to_string())
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            hermes_connect,
            hermes_send,
            hermes_send_file,
            hermes_stat_files,
            hermes_read_preview,
            hermes_request,
            hermes_disconnect,
            hermes_probe,
            hermes_probe_cancel,
            hermes_save_provider_key,
            password_load,
            password_save,
            password_delete,
            chat_export,
            notify_desktop,
            system_fonts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
