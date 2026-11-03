pub mod defaults_file;
pub mod fonts;
pub mod media;
pub mod notify;
pub mod remote;
pub mod saved_password;
pub mod screenshot;
pub mod terminal;
pub mod transport;
pub mod tunnel;
pub mod web_page;
pub mod update;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeBody};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use transport::{Dashboard, ExtraHeader, LocalFile, LocalText, PickedFiles, Pipe, PipeEvent, ProbeFailure, SavedKey, SignIn, Stage};
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

/// `probe`: the connection test running now, so setup can stop it, and a new one replaces it. `connecting`: the
/// connection being opened now, so the webview can stop it.
#[derive(Default)]
struct AppState(Mutex<Option<Connection>>, std::sync::Mutex<Option<tokio::task::AbortHandle>>, std::sync::Mutex<Connecting>);

/// The connection `hermes_connect` is opening, by the webview's name for that attempt, and the attempts stopped
/// before they began.
#[derive(Default)]
struct Connecting {
    now: Option<(String, tokio::task::AbortHandle)>,
    stopped: std::collections::HashSet<String>,
}

/// How long opening a connection may take, all steps together, so a server that stops answering midway can't keep
/// the app, or Sign out, waiting for good.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const CONNECT_STOPPED: &str = "Connecting was stopped.";

/// The dashboard root for `target`, the tunnel that reaches it (SSH only), the route to report, and the extra
/// request headers to send (URL only, ADR 0006). Failures are the owner's address, headers or SSH (`Stage::Address`).
async fn open_target(target: Target) -> Result<(url::Url, Option<Tunnel>, Route, reqwest::header::HeaderMap), String> {
    Ok(match target {
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
    })
}

/// Private screenshot storage and desktop requests waiting for a signed-in window.
#[derive(Default)]
struct Screenshots {
    captures: std::sync::Mutex<Option<Arc<screenshot::Captures>>>,
    requests: remote::Requests,
}

impl Screenshots {
    fn captures(&self) -> Result<Arc<screenshot::Captures>, screenshot::CaptureError> {
        let mut slot = self.captures.lock().unwrap();
        if let Some(c) = &*slot {
            return Ok(c.clone());
        }
        let c = Arc::new(screenshot::Captures::open(screenshot::default_root()?)?);
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
    attempt: Option<String>,
    on_event: Channel<PipeEvent>,
) -> Result<Route, String> {
    let mut slot = state.0.lock().await;
    *slot = None;
    let attempt = attempt.unwrap_or_default();
    // Run apart, so `hermes_connect_cancel` can stop it; stopping it drops what it opened, SSH tunnel included.
    let task = {
        let mut connecting = state.2.lock().unwrap();
        if connecting.stopped.remove(&attempt) {
            return Err(CONNECT_STOPPED.into());
        }
        let task = tokio::spawn(async move {
            tokio::time::timeout(CONNECT_TIMEOUT, open_connection(target, username, password, profile, on_event))
                .await
                .unwrap_or_else(|_| Err(format!("Hermes didn't finish connecting within {}s.", CONNECT_TIMEOUT.as_secs())))
        });
        connecting.now = Some((attempt.clone(), task.abort_handle()));
        task
    };
    let opened = task.await;
    {
        let mut connecting = state.2.lock().unwrap();
        if connecting.now.as_ref().is_some_and(|(a, _)| *a == attempt) {
            connecting.now = None;
        }
    }
    let (connection, route) = match opened {
        Ok(opened) => opened?,
        Err(e) if e.is_cancelled() => return Err(CONNECT_STOPPED.into()),
        Err(e) => return Err(e.to_string()),
    };
    *slot = Some(connection);
    Ok(route)
}

/// Opens the tunnel or resolves the URL, signs in and opens `/api/ws`, for `hermes_connect`.
async fn open_connection(
    target: Target,
    username: String,
    password: String,
    profile: String,
    on_event: Channel<PipeEvent>,
) -> Result<(Connection, Route), String> {
    let (base, tunnel, route, headers) = open_target(target).await?;
    let dashboard = Dashboard::sign_in(&base, &SignIn { username, password, headers }).await.map_err(|e| e.to_string())?;
    let pipe = dashboard
        .open_pipe(&profile, move |e| {
            let _ = on_event.send(e);
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok((Connection { dashboard: Arc::new(dashboard), pipe: Arc::new(pipe), _tunnel: tunnel }, route))
}

/// Stops the connection `hermes_connect` is opening for `attempt`, or, if it hasn't begun, stops it before it does.
/// Another attempt's is left alone.
#[tauri::command]
fn hermes_connect_cancel(state: State<'_, AppState>, attempt: String) {
    let mut connecting = state.2.lock().unwrap();
    match &connecting.now {
        Some((now, task)) if *now == attempt => task.abort(),
        _ => {
            connecting.stopped.insert(attempt);
        }
    }
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
        let (base, _tunnel, route, headers) = open_target(target).await.map_err(|e| ProbeFailure::new(Stage::Address, e))?;
        let probed = transport::probe(&base, &SignIn { username, password, headers }, &profile).await?;
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

/// The renderer supplies all persisted outboxes at startup and whenever they change, before cleanup.
#[tauri::command]
fn screenshot_sync_outbox(app: tauri::AppHandle, state: State<'_, Screenshots>, paths: Vec<String>) -> Result<(), screenshot::CaptureError> {
    // Also those of drafts an update's restart couldn't put back (update.rs).
    let saved = update::saved_attachment_paths(&app);
    state.captures()?.retain_outbox(paths.into_iter().map(std::path::PathBuf::from).chain(saved));
    Ok(())
}

/// Peeking leaves the request pending if the signed-in window goes away before handling it.
#[tauri::command]
fn screenshot_pending_request(state: State<'_, Screenshots>) -> Option<u64> {
    state.requests.pending()
}

/// A live window started handling this request. A newer request remains pending.
#[tauri::command]
fn screenshot_ack_request(state: State<'_, Screenshots>, id: u64) {
    state.requests.acknowledge(id);
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

/// A read-only dashboard GET whose answer may be big, e.g. a server file for the Server files screen's preview: refused
/// once it passes `max_bytes`.
#[tauri::command]
async fn hermes_get_limited(state: State<'_, AppState>, path: String, max_bytes: u64) -> Result<String, String> {
    let dashboard = dashboard(&state).await?;
    dashboard.get_limited(&path, max_bytes).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn hermes_toolset_guards(state: State<'_, AppState>, profile: String) -> Result<transport::ToolsetGuards, String> {
    let dashboard = dashboard(&state).await?;
    dashboard.toolset_guards(&profile).await.map_err(|e| e.to_string())
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

/// Whether the site at `url` refuses to be shown in the preview's frame, asked the way the frame asks
/// (`web_page::check`, ADR 0011). `user_agent`: the webview's, which the frame sends.
#[tauri::command]
async fn preview_check_web(url: String, user_agent: String) -> Result<web_page::Framing, String> {
    web_page::check(&url, &user_agent).await
}

/// Opens an http(s) page in the owner's browser, for one the preview can't show.
#[tauri::command]
async fn preview_open_in_browser(url: String) -> Result<(), String> {
    web_page::open_in_browser(&url).await
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

/// Opens a terminal on the server: `ssh` to `target` (the sign-in's SSH target, or one the owner gave the terminal),
/// `cols` × `rows`, its output and end sent to `on_event` (terminal.rs, ADR 0022).
#[tauri::command]
async fn terminal_open(
    terminals: State<'_, terminal::Terminals>,
    target: String,
    cols: u16,
    rows: u16,
    on_event: Channel<terminal::TerminalEvent>,
) -> Result<u64, terminal::TerminalError> {
    let command = terminal::ssh_command(&target)?;
    terminals.open(command, cols, rows, move |e| {
        let _ = on_event.send(e);
    })
}

/// Async, so a terminal that isn't reading can't hold up the window.
#[tauri::command]
async fn terminal_write(terminals: State<'_, terminal::Terminals>, id: u64, data: String) -> Result<(), terminal::TerminalError> {
    terminals.write(id, data.as_bytes())
}

#[tauri::command]
fn terminal_resize(terminals: State<'_, terminal::Terminals>, id: u64, cols: u16, rows: u16) -> Result<(), terminal::TerminalError> {
    terminals.resize(id, cols, rows)
}

#[tauri::command]
fn terminal_close(terminals: State<'_, terminal::Terminals>, id: u64) {
    terminals.close(id);
}

/// Starts the app. `screenshot`: it was started by `hermes-chat --screenshot`, with no other Hermes Chat to take it.
pub fn run(screenshot: bool) {
    let screenshots = Screenshots::default();
    if screenshot {
        screenshots.requests.ask();
    }
    let context = tauri::generate_context!();
    let mut builder = tauri::Builder::default();
    // The updater needs a public key to start, so it is there only in a build given one (README, "Updates").
    if update::configured(context.config()) {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(screenshots)
        .manage(update::Updates::default())
        .on_permission_request(|webview, kind| permission(&webview, kind))
        .setup(|app| {
            use tauri::Emitter;
            // WebKitGTK leaves `navigator.mediaDevices` out unless media capture is turned on.
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    if let Some(settings) = webview.inner().settings() {
                        settings.set_enable_media_stream(true);
                    }
                })?;
            }
            // Open storage at startup. The renderer supplies outbox references and triggers the startup sweep.
            if let Err(e) = app.state::<Screenshots>().captures() {
                eprintln!("hermes-chat: couldn't clean up old screenshots: {e}");
            }
            // Which package the binary came from, read before anything can upgrade it.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { handle.state::<update::Updates>().start().await });
            let handle = app.handle().clone();
            remote::serve(move || {
                handle.state::<Screenshots>().requests.ask();
                let _ = handle.emit(remote::EVENT, ());
            });
            Ok(())
        })
        .manage(PickedFiles::default())
        .manage(terminal::Terminals::default())
        .invoke_handler(tauri::generate_handler![
            hermes_connect,
            hermes_send,
            hermes_send_file,
            hermes_stat_files,
            hermes_read_preview,
            stage_clipboard_file,
            hermes_request,
            hermes_transcribe,
            hermes_speak,
            hermes_voice_setup,
            hermes_toolset_guards,
            hermes_get_limited,
            hermes_disconnect,
            hermes_connect_cancel,
            hermes_probe,
            hermes_probe_cancel,
            hermes_save_provider_key,
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
            preview_check_web,
            preview_open_in_browser,
            notify_desktop,
            system_fonts,
            screenshot_capture,
            screenshot_discard,
            screenshot_support,
            screenshot_sync_outbox,
            screenshot_pending_request,
            screenshot_ack_request,
            screenshot_show_window,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            update::update_install_kind,
            update::update_check,
            update::update_download_and_install,
            update::app_restart,
            update::restart_drafts_read,
            update::restart_drafts_clear,
            defaults_file::project_defaults_read,
            defaults_file::project_defaults_swap,
            update::restart_drafts_set_aside
        ])
        .build(context)
        .expect("error while building tauri application")
        // Outbox persistence in the renderer can precede its asynchronous retention IPC. Leave remaining captures
        // for the next startup's sweep, after persisted references are known, rather than risk deleting Retry bytes.
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                update::relaunch(app);
            }
        });
}
