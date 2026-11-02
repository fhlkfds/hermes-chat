pub mod saved_password;
pub mod transport;
pub mod tunnel;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use transport::{Dashboard, LocalFile, Pipe, PipeEvent, SignIn, TransportError};
use tunnel::{Tunnel, TunnelError};

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

/// Why `hermes_connect` or `hermes_request` failed, as the webview gets it. `signed_out`: the dashboard refused
/// the password, so trying again with it won't help, unlike a server that can't be reached.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    message: String,
    signed_out: bool,
}

impl From<TransportError> for CommandError {
    fn from(e: TransportError) -> Self {
        let signed_out = matches!(e, TransportError::BadCredentials | TransportError::SignedOut);
        CommandError { message: e.to_string(), signed_out }
    }
}

impl From<TunnelError> for CommandError {
    fn from(e: TunnelError) -> Self {
        CommandError { message: e.to_string(), signed_out: false }
    }
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
) -> Result<Route, CommandError> {
    let mut slot = state.0.lock().await;
    *slot = None;
    let (base, tunnel, route) = match target {
        Target::Ssh { target } => {
            let tunnel = tunnel::open(&target, DASHBOARD_PORT).await?;
            let base = url::Url::parse(&format!("http://127.0.0.1:{}/", tunnel.local_port)).expect("valid URL");
            (base, Some(tunnel), Route::Ssh { target: target.trim().to_owned() })
        }
        Target::Url { url } => {
            let direct = transport::resolve_direct(&url).await?;
            let addresses = direct.addresses.iter().map(ToString::to_string).collect();
            (direct.base, None, Route::Url { url: url.trim().to_owned(), addresses })
        }
    };
    let dashboard = Dashboard::sign_in(&base, &SignIn { username, password }).await?;
    let pipe = dashboard
        .open_pipe(&profile, move |e| {
            let _ = on_event.send(e);
        })
        .await?;
    *slot = Some(Connection { dashboard: Arc::new(dashboard), pipe: Arc::new(pipe), _tunnel: tunnel });
    Ok(route)
}

#[tauri::command]
async fn hermes_send(state: State<'_, AppState>, frame: String) -> Result<(), String> {
    match &*state.0.lock().await {
        Some(conn) => conn.pipe.send(frame).map_err(|e| e.to_string()),
        None => Err(TransportError::Closed.to_string()),
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
        None => return Err(TransportError::Closed.to_string()),
    };
    pipe.send_file(&head, &path, &tail, max_bytes).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn hermes_stat_files(paths: Vec<String>) -> Vec<LocalFile> {
    transport::stat_files(&paths).await
}

#[tauri::command]
async fn hermes_request(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, CommandError> {
    // Don't hold the lock across the request, so frames keep flowing while it runs.
    let dashboard = match &*state.0.lock().await {
        Some(conn) => conn.dashboard.clone(),
        None => return Err(TransportError::Closed.into()),
    };
    Ok(dashboard.request(&method, &path, body).await?)
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            hermes_connect,
            hermes_send,
            hermes_send_file,
            hermes_stat_files,
            hermes_request,
            hermes_disconnect,
            password_load,
            password_save,
            password_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
