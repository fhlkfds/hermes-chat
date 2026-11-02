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
use transport::{Dashboard, ExtraHeader, LocalFile, LocalText, PickedFiles, Pipe, PipeEvent, SignIn};
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
    /// `headers`: extra request headers for a gateway in front of the dashboard, such as Cloudflare Access (ADR 0006).
    /// Only a direct connection sends them; the SSH tunnel goes straight to the dashboard.
    Url {
        url: String,
        #[serde(default)]
        headers: Vec<ExtraHeader>,
    },
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
    let (base, tunnel, route, headers) = match target {
        Target::Ssh { target } => {
            let tunnel = tunnel::open(&target, DASHBOARD_PORT).await.map_err(|e| e.to_string())?;
            let base = url::Url::parse(&format!("http://127.0.0.1:{}/", tunnel.local_port)).expect("valid URL");
            (base, Some(tunnel), Route::Ssh { target: target.trim().to_owned() }, Default::default())
        }
        Target::Url { url, headers } => {
            let headers = transport::extra_headers(&headers).map_err(|e| e.to_string())?;
            let direct = transport::resolve_direct(&url).await.map_err(|e| e.to_string())?;
            let addresses = direct.addresses.iter().map(ToString::to_string).collect();
            (direct.base, None, Route::Url { url: url.trim().to_owned(), addresses }, headers)
        }
    };
    let dashboard = Dashboard::sign_in(&base, &SignIn { username, password, headers }).await.map_err(|e| e.to_string())?;
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

/// Saves a file pasted into the composer to a temp file and returns its path. Its bytes come as the raw body, not
/// JSON, so a big screenshot isn't sent as a list of numbers; its name comes URI-encoded in the `x-name` header.
#[tauri::command]
async fn stage_clipboard_file(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The pasted file didn't arrive as bytes.".into());
    };
    let header = request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or_default();
    // encodeURIComponent never writes `+`, `&` or `=` bare, so one form-decoded key is exactly the name.
    let name = url::form_urlencoded::parse(header.as_bytes()).next().map(|(k, _)| k.into_owned()).unwrap_or_default();
    let path = transport::stage_clipboard_file(&name, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
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
    saved_password::load(saved_password::PASSWORD).await
}

#[tauri::command]
async fn password_save(password: String) -> Result<(), String> {
    saved_password::save(saved_password::PASSWORD, password).await
}

#[tauri::command]
async fn password_delete() -> Result<(), String> {
    saved_password::delete(saved_password::PASSWORD).await
}

/// The extra request headers, names and values, as JSON the webview reads and writes.
#[tauri::command]
async fn headers_load() -> Result<Option<String>, String> {
    saved_password::load(saved_password::HEADERS).await
}

#[tauri::command]
async fn headers_save(headers: String) -> Result<(), String> {
    saved_password::save(saved_password::HEADERS, headers).await
}

#[tauri::command]
async fn headers_delete() -> Result<(), String> {
    saved_password::delete(saved_password::HEADERS).await
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

/// A local file the owner picked for the preview pane.
#[derive(Serialize)]
struct PickedFile {
    path: String,
    name: String,
}

/// Opens the native Open dialog for a file to preview. The webview never names the path: only a file picked here can
/// be read by `preview_read_local`. `None`: the owner cancelled.
#[tauri::command]
async fn preview_pick_local(app: tauri::AppHandle, picked: State<'_, PickedFiles>) -> Result<Option<PickedFile>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Preview a file on this computer");
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
    let path = picked.allow(&path.display().to_string()).map_err(|e| e.to_string())?;
    Ok(Some(PickedFile { path, name }))
}

/// The start of a local file picked in `preview_pick_local`, as text.
#[tauri::command]
async fn preview_read_local(picked: State<'_, PickedFiles>, path: String) -> Result<LocalText, String> {
    picked.read(&path).await.map_err(|e| e.to_string())
}

/// Image bytes from the same retained handle as text previews, never from a newly resolved path.
#[tauri::command]
async fn preview_read_local_image(picked: State<'_, PickedFiles>, path: String) -> Result<tauri::ipc::Response, String> {
    picked.read_image(&path).await.map(tauri::ipc::Response::new).map_err(|e| e.to_string())
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
        .manage(PickedFiles::default())
        .invoke_handler(tauri::generate_handler![
            hermes_connect,
            hermes_send,
            hermes_send_file,
            hermes_stat_files,
            hermes_read_preview,
            stage_clipboard_file,
            hermes_request,
            hermes_disconnect,
            password_load,
            password_save,
            password_delete,
            headers_load,
            headers_save,
            headers_delete,
            chat_export,
            preview_pick_local,
            preview_read_local,
            preview_read_local_image,
            notify_desktop,
            system_fonts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
