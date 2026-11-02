//! Rust half of the Hermes transport: sign in to the dashboard, then move JSON-RPC text frames
//! between `/api/ws` and the webview, and relay its dashboard REST calls with the sign-in cookies.
//! The webview speaks the protocol; this side never parses it (ADR 0003). Wire details:
//! docs/research/hermes-gateway-api.md §2, §5 and "Password login and profiles".
//! It also reads the files the owner attaches, so their bytes go from disk to Hermes without passing
//! through the webview (§7), and the staged images the composer shows as thumbnails. For a direct connection it
//! resolves the host name in the URL the owner typed, so the webview can tell whether the connection is Unsecure.
//! Setup uses two more things here: `probe`, which tests a sign-in without keeping it, and
//! `Dashboard::save_provider_key`, which gives Hermes a model provider's API key.

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use reqwest::{header, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

/// The dashboard's username/password provider (`/api/status.auth_providers` on the live server).
const PASSWORD_PROVIDER: &str = "basic";

pub struct SignIn {
    pub username: String,
    pub password: String,
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("Enter the dashboard's URL, starting with http:// or https://, such as http://hermes:9119. Put the username and password in their own fields.")]
    BadUrl,
    #[error("Can't reach the Hermes dashboard: {0}")]
    Unreachable(String),
    #[error("Wrong username or password.")]
    BadCredentials,
    #[error("Too many sign-in attempts. Wait a minute and try again.")]
    RateLimited,
    #[error("The dashboard answered {status}: {body}")]
    Unexpected { status: u16, body: String },
    #[error("The chat connection failed: {0}")]
    WebSocket(String),
    #[error("The chat connection is closed.")]
    Closed,
    #[error("The dashboard sign-in has expired. Sign in again.")]
    SignedOut,
    #[error("Hermes Chat doesn't relay {0}.")]
    NotRelayed(String),
    #[error("it's {:.1} MB now, over the {} MB limit", *.size as f64 / MIB as f64, .max / MIB)]
    FileTooLarge { size: u64, max: u64 },
    #[error("{0}")]
    File(String),
    /// The provider turned down an API key the owner typed (`POST /api/providers/validate`).
    #[error("{0}")]
    KeyRejected(String),
}

const MIB: u64 = 1024 * 1024;

/// A dashboard to sign in to directly, without the SSH tunnel: its root, and the IP addresses its host name
/// resolves to (none when the host is an IP address).
#[derive(Debug)]
pub struct DirectUrl {
    pub base: Url,
    pub addresses: Vec<IpAddr>,
}

/// Reads the URL the owner typed: `http(s)://` or `ws(s)://` (taken as `http(s)://`), with an optional path
/// prefix, then resolves its host name. A URL with a username or password in it is refused, since the app saves
/// and shows the URL.
pub async fn resolve_direct(raw: &str) -> Result<DirectUrl, TransportError> {
    let mut base = Url::parse(raw.trim()).map_err(|_| TransportError::BadUrl)?;
    if !base.username().is_empty() || base.password().is_some() {
        return Err(TransportError::BadUrl);
    }
    let scheme = match base.scheme() {
        "http" | "ws" => "http",
        "https" | "wss" => "https",
        _ => return Err(TransportError::BadUrl),
    };
    base.set_scheme(scheme).expect("ws(s) URLs map to http(s)");
    base.set_query(None);
    base.set_fragment(None);
    let addresses = match base.host() {
        Some(url::Host::Domain(name)) => {
            let port = base.port_or_known_default().expect("http(s) has a default port");
            let mut found: Vec<IpAddr> = tokio::net::lookup_host((name, port))
                .await
                .map_err(|e| TransportError::Unreachable(format!("couldn't look up {name}: {e}")))?
                .map(|a| a.ip())
                .collect();
            found.sort();
            found.dedup();
            found
        }
        Some(_) => vec![],
        None => return Err(TransportError::BadUrl),
    };
    Ok(DirectUrl { base, addresses })
}

/// A local file the owner wants to attach: its size, or why it can't be attached.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LocalFile {
    pub path: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn stat_files(paths: &[String]) -> Vec<LocalFile> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let name = std::path::Path::new(path).file_name().map_or(path.clone(), |n| n.to_string_lossy().into_owned());
        let (size, error) = match file_size(path).await {
            Ok(size) => (Some(size), None),
            Err(e) => (None, Some(e.to_string())),
        };
        out.push(LocalFile { path: path.clone(), name, size, error });
    }
    out
}

/// The most an image preview reads: Hermes's own limit for images, so a bigger one was refused when attached.
pub const PREVIEW_MAX_BYTES: u64 = 25 * MIB;

/// Reads a staged image for the composer's thumbnail. Only image files up to `PREVIEW_MAX_BYTES`, judged by both
/// their extension and their first bytes, so the webview can't use it to read anything else.
pub async fn read_preview(path: &str) -> Result<Vec<u8>, TransportError> {
    let p = std::path::Path::new(path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    // The extensions Hermes looks at as images (`IMAGE_EXTENSIONS` in transport.ts).
    if !p.is_absolute() || !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") {
        return Err(TransportError::File("it isn't an image".into()));
    }
    let bytes = read_capped(path, PREVIEW_MAX_BYTES).await?;
    let b = bytes.as_slice();
    let image = b.starts_with(b"\x89PNG\r\n\x1a\n")
        || b.starts_with(b"\xff\xd8\xff")
        || b.starts_with(b"GIF8")
        || b.starts_with(b"BM")
        || (b.len() >= 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP");
    if !image {
        return Err(TransportError::File("it isn't an image".into()));
    }
    Ok(bytes)
}

/// Reads a whole file, refusing one over `max_bytes`; the size is checked again after reading, in case it grew.
async fn read_capped(path: &str, max_bytes: u64) -> Result<Vec<u8>, TransportError> {
    let too_large = |size| TransportError::FileTooLarge { size, max: max_bytes };
    let size = file_size(path).await?;
    if size > max_bytes {
        return Err(too_large(size));
    }
    // Read at most one byte past the limit, so a file that grew can't fill memory.
    let mut bytes = Vec::with_capacity(size as usize);
    let file = tokio::fs::File::open(path).await.map_err(|e| TransportError::File(e.to_string()))?;
    file.take(max_bytes + 1).read_to_end(&mut bytes).await.map_err(|e| TransportError::File(e.to_string()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_large(bytes.len() as u64));
    }
    Ok(bytes)
}

async fn file_size(path: &str) -> Result<u64, TransportError> {
    let meta = tokio::fs::metadata(path).await.map_err(|e| TransportError::File(e.to_string()))?;
    if meta.is_dir() {
        return Err(TransportError::File("it's a folder".into()));
    }
    Ok(meta.len())
}

/// What the pipe reports to the webview. One `Frame` per JSON-RPC message.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PipeEvent {
    Frame { text: String },
    Closed { reason: String },
}

/// An open `/api/ws` connection. Dropping it closes the socket.
pub struct Pipe {
    outgoing: mpsc::UnboundedSender<String>,
    task: JoinHandle<()>,
}

impl Pipe {
    pub fn send(&self, text: String) -> Result<(), TransportError> {
        self.outgoing.send(text).map_err(|_| TransportError::Closed)
    }

    /// Send one frame: `head`, the file at `path` as base64, then `tail`. Refuses a file over
    /// `max_bytes` without sending anything; the size is checked again after reading, in case it grew.
    pub async fn send_file(&self, head: &str, path: &str, tail: &str, max_bytes: u64) -> Result<(), TransportError> {
        let bytes = read_capped(path, max_bytes).await?;
        let mut frame = String::with_capacity(head.len() + bytes.len().div_ceil(3) * 4 + tail.len());
        frame.push_str(head);
        base64::engine::general_purpose::STANDARD.encode_string(&bytes, &mut frame);
        frame.push_str(tail);
        self.send(frame)
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A signed-in dashboard session. It keeps the session cookies up to date: the dashboard rotates an
/// expired access token through the refresh cookie on any request and sends the new ones back.
pub struct Dashboard {
    http: reqwest::Client,
    base: Url,
    cookies: Mutex<Vec<(String, String)>>,
}

impl Dashboard {
    /// Sign in at `base`, the dashboard root (e.g. the local end of the SSH tunnel).
    pub async fn sign_in(base: &Url, sign_in: &SignIn) -> Result<Dashboard, TransportError> {
        let dashboard = Dashboard { http: reqwest::Client::new(), base: base.clone(), cookies: Mutex::default() };
        let login = dashboard
            .http
            .post(endpoint(base, "auth/password-login"))
            .json(&json!({
                "provider": PASSWORD_PROVIDER,
                "username": sign_in.username,
                "password": sign_in.password,
            }))
            .send()
            .await
            .map_err(|e| TransportError::Unreachable(e.to_string()))?;
        match login.status() {
            s if s.is_success() => {}
            StatusCode::UNAUTHORIZED => return Err(TransportError::BadCredentials),
            StatusCode::TOO_MANY_REQUESTS => return Err(TransportError::RateLimited),
            _ => return Err(unexpected(login).await),
        }
        dashboard.keep_cookies(&login);
        Ok(dashboard)
    }

    /// Mint a WS ticket and open `/api/ws` for `profile`. Every frame the server sends, starting with
    /// `gateway.ready`, goes to `on_event`.
    pub async fn open_pipe(&self, profile: &str, on_event: impl Fn(PipeEvent) + Send + 'static) -> Result<Pipe, TransportError> {
        let ticket = self
            .http
            .post(endpoint(&self.base, "api/auth/ws-ticket"))
            .header(header::COOKIE, self.cookie_header())
            .send()
            .await
            .map_err(|e| TransportError::Unreachable(e.to_string()))?;
        self.keep_cookies(&ticket);
        if !ticket.status().is_success() {
            return Err(unexpected(ticket).await);
        }
        let ticket: serde_json::Value = ticket
            .json()
            .await
            .map_err(|e| TransportError::Unreachable(e.to_string()))?;
        let ticket = ticket["ticket"].as_str().ok_or_else(|| TransportError::Unexpected {
            status: 200,
            body: "ws-ticket response has no ticket".into(),
        })?;

        let mut ws_url = endpoint(&self.base, "api/ws");
        ws_url
            .set_scheme(if self.base.scheme() == "https" { "wss" } else { "ws" })
            .expect("http(s) URLs map to ws(s)");
        ws_url.query_pairs_mut().append_pair("ticket", ticket).append_pair("profile", profile);
        let (ws, _) = tokio_tungstenite::connect_async(ws_url.as_str())
            .await
            .map_err(|e| TransportError::WebSocket(e.to_string()))?;

        let (outgoing, mut to_server) = mpsc::unbounded_channel::<String>();
        let task = tokio::spawn(async move {
            let (mut sink, mut stream) = ws.split();
            let reason = loop {
                tokio::select! {
                    out = to_server.recv() => match out {
                        Some(text) => {
                            if let Err(e) = sink.send(Message::text(text)).await {
                                break e.to_string();
                            }
                        }
                        None => {
                            let _ = sink.close().await;
                            break "closed by the app".into();
                        }
                    },
                    msg = stream.next() => match msg {
                        // The server writes newline-delimited JSON-RPC; one WS message may carry several.
                        Some(Ok(Message::Text(text))) => {
                            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                                on_event(PipeEvent::Frame { text: line.to_owned() });
                            }
                        }
                        Some(Ok(Message::Close(frame))) => {
                            break frame.map_or("closed by the server".into(), |f| format!("closed by the server ({} {})", f.code, f.reason));
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => break e.to_string(),
                        None => break "closed by the server".into(),
                    },
                }
            };
            on_event(PipeEvent::Closed { reason });
        });

        Ok(Pipe { outgoing, task })
    }

    /// One dashboard REST call for the webview: `GET`, `PATCH` or `DELETE` on a path under `api/`, with a
    /// JSON body. Returns the response body on 2xx.
    pub async fn request(&self, method: &str, path_and_query: &str, body: Option<String>) -> Result<String, TransportError> {
        let method = match method {
            "GET" => Method::GET,
            "PATCH" => Method::PATCH,
            "DELETE" => Method::DELETE,
            other => return Err(TransportError::NotRelayed(format!("{other} requests"))),
        };
        let (path, query) = path_and_query.split_once('?').unwrap_or((path_and_query, ""));
        if !path.starts_with("api/") || path.split('/').any(|seg| seg == "..") {
            return Err(TransportError::NotRelayed(path.to_owned()));
        }
        let mut url = endpoint(&self.base, path);
        url.set_query(Some(query).filter(|q| !q.is_empty()));
        let mut req = self.http.request(method, url).header(header::COOKIE, self.cookie_header());
        if let Some(body) = body {
            req = req.header(header::CONTENT_TYPE, "application/json").body(body);
        }
        let resp = req.send().await.map_err(|e| TransportError::Unreachable(e.to_string()))?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => resp.text().await.map_err(|e| TransportError::Unreachable(e.to_string())),
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            _ => Err(unexpected(resp).await),
        }
    }

    /// Take in every Set-Cookie: a new value replaces the old one, an empty one deletes it. Only
    /// `name=value` is kept; the dashboard is the only site this jar talks to.
    fn keep_cookies(&self, resp: &reqwest::Response) {
        let mut jar = self.cookies.lock().unwrap();
        for v in resp.headers().get_all(header::SET_COOKIE) {
            let Some((name, value)) = v.to_str().ok().and_then(|v| v.split(';').next()?.split_once('=')) else {
                continue;
            };
            let (name, value) = (name.trim(), value.trim());
            jar.retain(|(n, _)| n != name);
            if !value.is_empty() {
                jar.push((name.to_owned(), value.to_owned()));
            }
        }
    }

    fn cookie_header(&self) -> String {
        let jar = self.cookies.lock().unwrap();
        jar.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ")
    }
}

fn endpoint(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    let prefix = url.path().trim_end_matches('/').to_owned();
    url.set_path(&format!("{prefix}/{path}"));
    url
}

async fn unexpected(resp: reqwest::Response) -> TransportError {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default().chars().take(300).collect();
    TransportError::Unexpected { status, body }
}

/// How far a connection test got before it failed, so setup can say what to fix.
/// `Address`: the URL or SSH target, or the SSH tunnel. `Reach`: the dashboard's HTTP port. `SignIn`: the
/// username and password. `Chat`: the `/api/ws` chat connection. `Cancelled`: the owner stopped the test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    Address,
    Reach,
    SignIn,
    Chat,
    Cancelled,
}

/// A failed connection test. `status`: the dashboard's `GET /api/status` body, when it answered one, so setup can
/// tell a Hermes dashboard from something else on the port, and which sign-in methods it offers.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProbeFailure {
    pub stage: Stage,
    pub message: String,
    pub status: Option<String>,
}

impl ProbeFailure {
    pub fn new(stage: Stage, message: impl Into<String>) -> Self {
        ProbeFailure { stage, message: message.into(), status: None }
    }
}

/// A connection test that went through: the dashboard's `GET /api/status` body (none if it didn't answer one) and
/// the first frame `/api/ws` sent, which the webview checks is a legacy `gateway.ready`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Probed {
    pub status: Option<String>,
    pub ready: String,
}

/// How long each step of a connection test may take. The app's own sign-in has no limit, but a test the owner is
/// watching should say where it stuck.
pub const PROBE_STEP_TIMEOUT: Duration = Duration::from_secs(15);

/// Tests a sign-in at `base` the way `Dashboard::sign_in` and `open_pipe` do it, without keeping anything: reads
/// `/api/status` (no sign-in needed), signs in, opens `/api/ws` for `profile` and waits for its first frame, then
/// closes it. The app's own connection, if there is one, is untouched.
pub async fn probe(base: &Url, sign_in: &SignIn, profile: &str) -> Result<Probed, ProbeFailure> {
    probe_with(base, sign_in, profile, PROBE_STEP_TIMEOUT).await
}

pub async fn probe_with(base: &Url, sign_in: &SignIn, profile: &str, step: Duration) -> Result<Probed, ProbeFailure> {
    let timed_out = |what: &str| format!("{what} didn't answer within {}s.", step.as_secs());
    let http = reqwest::Client::new();
    let status = match tokio::time::timeout(step, http.get(endpoint(base, "api/status")).send()).await {
        Err(_) => return Err(ProbeFailure::new(Stage::Reach, timed_out("The dashboard"))),
        Ok(Err(e)) => return Err(ProbeFailure::new(Stage::Reach, TransportError::Unreachable(describe(&e)).to_string())),
        Ok(Ok(resp)) if resp.status().is_success() => resp.text().await.ok(),
        Ok(Ok(_)) => None,
    };
    let fail = |stage, message: String| ProbeFailure { stage, message, status: status.clone() };
    let dashboard = match tokio::time::timeout(step, Dashboard::sign_in(base, sign_in)).await {
        Err(_) => return Err(fail(Stage::SignIn, timed_out("The dashboard's sign-in"))),
        Ok(Err(e)) => return Err(fail(Stage::SignIn, e.to_string())),
        Ok(Ok(d)) => d,
    };
    let (tx, rx) = tokio::sync::oneshot::channel::<PipeEvent>();
    let tx = Mutex::new(Some(tx));
    let pipe = match tokio::time::timeout(
        step,
        dashboard.open_pipe(profile, move |e| {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(e);
            }
        }),
    )
    .await
    {
        Err(_) => return Err(fail(Stage::Chat, timed_out("The chat connection"))),
        Ok(Err(e)) => return Err(fail(Stage::Chat, e.to_string())),
        Ok(Ok(p)) => p,
    };
    let first = tokio::time::timeout(step, rx).await;
    drop(pipe);
    match first {
        Ok(Ok(PipeEvent::Frame { text })) => Ok(Probed { status, ready: text }),
        Ok(Ok(PipeEvent::Closed { reason })) => Err(fail(Stage::Chat, format!("The chat connection closed before Hermes was ready: {reason}"))),
        Ok(Err(_)) => Err(fail(Stage::Chat, "The chat connection closed before Hermes was ready.".into())),
        Err(_) => Err(fail(Stage::Chat, timed_out("Hermes"))),
    }
}

/// A request error with its causes, which say what actually went wrong ("Connection refused", "dns error", a
/// certificate problem); reqwest's own message only names the URL.
fn describe(e: &reqwest::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        let text = s.to_string();
        if !parts.iter().any(|p| p.contains(&text)) {
            parts.push(text);
        }
        source = s.source();
    }
    parts.join(": ")
}

/// What became of a provider key saved with `Dashboard::save_provider_key`. `verified`: the provider accepted it.
/// Otherwise Hermes couldn't check it (no check for that provider, or the provider couldn't be reached) and
/// `message` may say why; it is saved either way.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SavedKey {
    pub verified: bool,
    pub message: String,
}

/// `POST /api/providers/validate`'s answer (`hermes_cli/web_routers/config_env.py` at the deployed `bf0203a`).
#[derive(Deserialize)]
struct Validated {
    ok: bool,
    reachable: bool,
    #[serde(default)]
    message: String,
}

/// An env var name that can hold a model provider's API key: upper-case, ending `_API_KEY`, `_KEY` or `_TOKEN`,
/// and not one of Hermes's own (`HERMES_…`, such as the dashboard session token).
fn provider_key_name(key: &str) -> bool {
    let shape = (2..=64).contains(&key.len())
        && key.starts_with(|c: char| c.is_ascii_uppercase())
        && key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    shape && !key.starts_with("HERMES_") && (key.ends_with("_KEY") || key.ends_with("_TOKEN"))
}

impl Dashboard {
    /// Gives the profile's Hermes a model provider's API key, the way the dashboard's Keys page does
    /// (`hermes_cli/web_routers/config_env.py` at the deployed `bf0203a`):
    ///
    /// 1. `GET /api/env?profile=` must list `key` as a provider's secret, so nothing else in the profile's `.env`
    ///    can be written this way, whatever the webview asks.
    /// 2. `POST /api/providers/validate` asks the provider about the key. A key it turns down isn't saved.
    /// 3. `PUT /api/env?profile=` saves it in the profile's `.env` on the server.
    ///
    /// The key never comes back in an error: any echo of it in the dashboard's answer is blanked out.
    pub async fn save_provider_key(&self, profile: &str, key: &str, value: &str) -> Result<SavedKey, TransportError> {
        let value = value.trim();
        if !provider_key_name(key) {
            return Err(TransportError::NotRelayed(format!("{key}: not a model provider's key")));
        }
        if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err(TransportError::KeyRejected("Paste the key on one line, without spaces around it.".into()));
        }
        let scoped = |path: &str| {
            let mut url = endpoint(&self.base, path);
            url.query_pairs_mut().append_pair("profile", profile);
            url
        };
        let hide = |e: TransportError| match e {
            TransportError::Unexpected { status, body } => TransportError::Unexpected { status, body: body.replace(value, "[key]") },
            other => other,
        };

        let env: serde_json::Value = serde_json::from_str(&self.call(Method::GET, scoped("api/env"), None).await?)
            .map_err(|e| TransportError::Unexpected { status: 200, body: format!("GET /api/env: {e}") })?;
        let row = &env[key];
        let is_provider_secret = row["provider"].as_str().is_some_and(|p| !p.is_empty())
            && row["is_password"] == json!(true)
            && row["channel_managed"] != json!(true);
        if !is_provider_secret {
            return Err(TransportError::NotRelayed(format!("{key}: Hermes doesn't list it as a model provider's key")));
        }

        let body = json!({"key": key, "value": value}).to_string();
        let checked = self.call(Method::POST, endpoint(&self.base, "api/providers/validate"), Some(body)).await.map_err(hide)?;
        let checked: Validated = serde_json::from_str(&checked)
            .map_err(|e| TransportError::Unexpected { status: 200, body: format!("POST /api/providers/validate: {e}") })?;
        if !checked.ok && checked.reachable {
            let why = if checked.message.is_empty() { "The provider turned the key down." } else { checked.message.as_str() };
            return Err(TransportError::KeyRejected(why.replace(value, "[key]")));
        }

        let body = json!({"key": key, "value": value, "provider_setup": true}).to_string();
        self.call(Method::PUT, scoped("api/env"), Some(body)).await.map_err(hide)?;
        Ok(SavedKey { verified: checked.ok && checked.reachable, message: checked.message.replace(value, "[key]") })
    }

    /// One signed-in call that the app itself makes, with a JSON body; the webview's are `request`.
    async fn call(&self, method: Method, url: Url, body: Option<String>) -> Result<String, TransportError> {
        let mut req = self.http.request(method, url).header(header::COOKIE, self.cookie_header());
        if let Some(body) = body {
            req = req.header(header::CONTENT_TYPE, "application/json").body(body);
        }
        let resp = req.send().await.map_err(|e| TransportError::Unreachable(e.to_string()))?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => resp.text().await.map_err(|e| TransportError::Unreachable(e.to_string())),
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            _ => Err(unexpected(resp).await),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::provider_key_name;

    #[test]
    fn only_provider_key_names() {
        for ok in ["OPENROUTER_API_KEY", "HF_TOKEN", "GITHUB_TOKEN", "Z_AI_API_KEY", "DASHSCOPE_API_KEY"] {
            assert!(provider_key_name(ok), "{ok}");
        }
        for bad in ["HERMES_DASHBOARD_SESSION_TOKEN", "PATH", "OPENAI_BASE_URL", "openrouter_api_key", "_API_KEY", "A B_KEY", "X\nY_KEY", ""] {
            assert!(!provider_key_name(bad), "{bad}");
        }
    }
}
