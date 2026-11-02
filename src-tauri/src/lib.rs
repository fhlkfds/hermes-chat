pub mod fonts;
pub mod media;
pub mod notify;
pub mod saved_password;
pub mod transport;
pub mod tunnel;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeBody};
use tauri::webview::{PermissionKind, PermissionResponse};
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

/// The signed-in dashboard, without holding the lock across a request, so frames keep flowing while it runs.
async fn dashboard(state: &State<'_, AppState>) -> Result<Arc<Dashboard>, String> {
    match &*state.0.lock().await {
        Some(conn) => Ok(conn.dashboard.clone()),
        None => Err(transport::TransportError::Closed.to_string()),
    }
}

/// A header the webview set on a raw-body command, URI-decoded.
fn header_value(request: &tauri::ipc::Request<'_>, name: &str) -> Option<String> {
    let raw = request.headers().get(name)?.to_str().ok()?;
    url::form_urlencoded::parse(format!("v={}", raw.replace('+', "%2B")).as_bytes()).next().map(|(_, v)| v.into_owned())
}

/// Transcribes a dictated recording. Its bytes come as the raw request body, not as JSON, and its MIME type and the
/// profile as the URI-encoded `x-mime` and `x-profile` headers. Nothing here keeps or logs the audio or the text.
#[tauri::command]
async fn hermes_transcribe(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<transport::Transcript, String> {
    let InvokeBody::Raw(audio) = request.body() else {
        return Err("The recording didn't arrive as audio bytes.".into());
    };
    let mime = header_value(&request, "x-mime").unwrap_or_default();
    let profile = header_value(&request, "x-profile").ok_or("The recording didn't name a profile.")?;
    let dashboard = dashboard(&state).await?;
    dashboard.transcribe(&profile, &mime, audio).await.map_err(|e| e.to_string())
}

/// A reply read aloud, as the webview gets it: the audio as base64, since a command answers either JSON or raw bytes.
#[derive(Serialize)]
struct SpeechOut {
    mime: String,
    audio: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
}

#[tauri::command]
async fn hermes_speak(state: State<'_, AppState>, profile: String, text: String) -> Result<SpeechOut, String> {
    use base64::Engine;
    let dashboard = dashboard(&state).await?;
    let speech = dashboard.speak(&profile, &text).await.map_err(|e| e.to_string())?;
    let audio = base64::engine::general_purpose::STANDARD.encode(&speech.audio);
    Ok(SpeechOut { mime: speech.mime, audio, provider: speech.provider })
}

#[tauri::command]
async fn hermes_voice_setup(state: State<'_, AppState>, profile: String) -> Result<transport::VoiceSetup, String> {
    let dashboard = dashboard(&state).await?;
    dashboard.voice_setup(&profile).await.map_err(|e| e.to_string())
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

/// Dictation records from the microphone, and the app asks for it only when the owner starts a recording, so a
/// microphone request from the app's own page is granted here. Any other page (a link in a reply can navigate the
/// webview away) is refused, as are the camera and screen, which the app never uses. Anything else gets WebKit's
/// default.
fn permission<R: tauri::Runtime>(webview: &tauri::Webview<R>, kind: PermissionKind) -> PermissionResponse {
    match kind {
        PermissionKind::Microphone => {
            // In a dev build the page comes from the Vite server; a release build only trusts its bundled page.
            let dev_url = if tauri::is_dev() { webview.config().build.dev_url.clone() } else { None };
            match webview.url() {
                Ok(page) if media::is_app_page(&page, dev_url.as_ref()) => PermissionResponse::Allow,
                _ => PermissionResponse::Deny,
            }
        }
        PermissionKind::Camera | PermissionKind::DisplayCapture => PermissionResponse::Deny,
        _ => PermissionResponse::Default,
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .on_permission_request(|webview, kind| permission(&webview, kind))
        .setup(|app| {
            // WebKitGTK leaves `navigator.mediaDevices` out unless media capture is turned on.
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    if let Some(settings) = webview.inner().settings() {
                        settings.set_enable_media_stream(true);
                    }
                })?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hermes_connect,
            hermes_send,
            hermes_send_file,
            hermes_stat_files,
            hermes_read_preview,
            hermes_request,
            hermes_transcribe,
            hermes_speak,
            hermes_voice_setup,
            hermes_disconnect,
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
