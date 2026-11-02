//! Rust half of the Hermes transport: sign in to the dashboard, then move JSON-RPC text frames
//! between `/api/ws` and the webview, and relay its dashboard REST calls with the sign-in cookies.
//! The webview speaks the protocol; this side never parses it (ADR 0003). Wire details:
//! docs/research/hermes-gateway-api.md §2, §5 and "Password login and profiles".
//! It also reads the files the owner attaches, so their bytes go from disk to Hermes without passing
//! through the webview (§7), and the staged images the composer shows as thumbnails. For a direct connection it
//! resolves the host name in the URL the owner typed, so the webview can tell whether the connection is Unsecure.
//! For voice it relays a recording to the dashboard's transcription route and a reply to its speech route, and reads
//! which speech providers the profile uses without passing the rest of its config, keys and all, to the webview
//! (research doc, "Voice").

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use reqwest::{header, Method, StatusCode};
use serde::Serialize;
use serde_json::json;
use std::net::IpAddr;
use std::sync::Mutex;
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
    #[error("This Hermes server can't {0}: it has no {1} route. Updating Hermes adds it.")]
    NoVoiceRoute(&'static str, &'static str),
    #[error("{0}")]
    Voice(String),
}

const MIB: u64 = 1024 * 1024;

/// Hermes's own limit on a recording to transcribe (`_MAX_TRANSCRIPTION_UPLOAD_BYTES` in
/// `hermes_cli/web_routers/audio.py` at the deployed `bf0203a`).
pub const TRANSCRIBE_MAX_BYTES: u64 = 25 * MIB;

/// What Hermes heard in a recording. `text` is empty when it heard no speech.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Transcript {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// A reply read aloud by Hermes: the audio file's bytes and type.
#[derive(Debug, Clone, PartialEq)]
pub struct Speech {
    pub mime: String,
    pub audio: Vec<u8>,
    pub provider: Option<String>,
}

/// What the profile's voice set-up looks like from here: whether the server has the two audio routes, and which
/// providers the profile's config names. Only these fields leave Rust; the config they come from can hold API keys.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSetup {
    /// The server has `POST /api/audio/transcribe`.
    pub transcribe: bool,
    /// The server has `POST /api/audio/speak`.
    pub speak: bool,
    /// `stt.enabled`; Hermes counts a missing one as on. `None` when the config couldn't be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stt_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stt_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tts_provider: Option<String>,
}

/// How an audio route answered: its JSON, no such route, or a refusal and Hermes's reason.
enum AudioAnswer {
    Done(serde_json::Value),
    NoRoute,
    Refused(String),
}

/// A plain MIME type such as `audio/wav`, without parameters, or `None` if it isn't an audio type.
fn audio_mime(raw: &str) -> Option<String> {
    let mime = raw.split(';').next()?.trim().to_ascii_lowercase();
    let (kind, sub) = mime.split_once('/')?;
    let token = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$&-^_.+".contains(&b));
    (kind == "audio" && token(sub)).then_some(mime)
}

/// The reason in a refusal's body: FastAPI's `detail`, an `error`, or else the status alone (a proxy's HTML page says
/// nothing useful). Long enough for Hermes's "No STT provider available", which lists what each provider needs.
fn refusal_reason(status: StatusCode, body: &str) -> String {
    let json: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let text = json["detail"].as_str().or(json["error"].as_str()).map(str::trim).filter(|s| !s.is_empty());
    match text {
        Some(t) => t.chars().take(800).collect(),
        None => format!("the server answered {status}"),
    }
}

/// A config value as a short display string, or `None` if it isn't a non-empty string.
fn config_word(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(|s| s.chars().take(64).collect())
}

/// `stt.enabled` as Hermes reads it (`is_truthy_value(cfg.get("enabled", True), default=True)` in
/// `tools/transcription_tools.py`, then Python truthiness): missing is on.
fn truthy(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => true,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64() != Some(0.0),
        serde_json::Value::String(s) => matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        serde_json::Value::Array(a) => !a.is_empty(),
        serde_json::Value::Object(o) => !o.is_empty(),
    }
}

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

    /// Sends a recording to Hermes to transcribe with `profile`'s speech-to-text provider (`POST
    /// /api/audio/transcribe`). `mime` must be an audio type. Hermes deletes its temporary copy once it has the text.
    pub async fn transcribe(&self, profile: &str, mime: &str, audio: &[u8]) -> Result<Transcript, TransportError> {
        let mime = audio_mime(mime).ok_or_else(|| TransportError::Voice("The recording isn't audio.".into()))?;
        if audio.is_empty() {
            return Err(TransportError::Voice("The recording is empty.".into()));
        }
        if audio.len() as u64 > TRANSCRIBE_MAX_BYTES {
            return Err(TransportError::Voice(format!(
                "The recording is too long to transcribe: {}.",
                TransportError::FileTooLarge { size: audio.len() as u64, max: TRANSCRIBE_MAX_BYTES }
            )));
        }
        let mut data_url = String::with_capacity(mime.len() + 13 + audio.len().div_ceil(3) * 4);
        data_url.push_str("data:");
        data_url.push_str(&mime);
        data_url.push_str(";base64,");
        base64::engine::general_purpose::STANDARD.encode_string(audio, &mut data_url);
        let body = json!({"data_url": data_url, "mime_type": mime});
        match self.post_audio("api/audio/transcribe", profile, &body).await? {
            AudioAnswer::Done(v) => match v["transcript"].as_str() {
                Some(text) => Ok(Transcript { text: text.trim().to_owned(), provider: config_word(&v["provider"]) }),
                None => Err(TransportError::Voice("Hermes answered without a transcript.".into())),
            },
            AudioAnswer::NoRoute => Err(TransportError::NoVoiceRoute("transcribe recordings", "/api/audio/transcribe")),
            AudioAnswer::Refused(why) => Err(TransportError::Voice(format!("Hermes couldn't transcribe the recording: {why}"))),
        }
    }

    /// Asks Hermes to read `text` aloud with `profile`'s text-to-speech provider (`POST /api/audio/speak`). Hermes
    /// strips the Markdown and splits long text itself, and deletes its audio file once it has sent it.
    pub async fn speak(&self, profile: &str, text: &str) -> Result<Speech, TransportError> {
        if text.trim().is_empty() {
            return Err(TransportError::Voice("There's nothing to read aloud.".into()));
        }
        let v = match self.post_audio("api/audio/speak", profile, &json!({"text": text})).await? {
            AudioAnswer::Done(v) => v,
            AudioAnswer::NoRoute => return Err(TransportError::NoVoiceRoute("read replies aloud", "/api/audio/speak")),
            AudioAnswer::Refused(why) => return Err(TransportError::Voice(format!("Hermes couldn't read it aloud: {why}"))),
        };
        let bad = || TransportError::Voice("Hermes answered with audio this app can't read.".into());
        let (head, encoded) = v["data_url"].as_str().and_then(|u| u.strip_prefix("data:")?.split_once(',')).ok_or_else(bad)?;
        let mime = head.strip_suffix(";base64").and_then(audio_mime).ok_or_else(bad)?;
        let audio = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| bad())?;
        if audio.is_empty() {
            return Err(bad());
        }
        Ok(Speech { mime, audio, provider: config_word(&v["provider"]) })
    }

    /// Reads whether the server has the two audio routes, and which providers `profile`'s config names. The routes
    /// are asked with bodies they refuse before doing any work (an empty recording, no text), so nothing is
    /// transcribed or spoken. Only the provider names and `stt.enabled` are kept from the config.
    pub async fn voice_setup(&self, profile: &str) -> Result<VoiceSetup, TransportError> {
        let has = |a: AudioAnswer| !matches!(a, AudioAnswer::NoRoute);
        let transcribe = has(self.post_audio("api/audio/transcribe", profile, &json!({"data_url": ""})).await?);
        let speak = has(self.post_audio("api/audio/speak", profile, &json!({"text": ""})).await?);
        let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("profile", profile).finish();
        let config: Option<serde_json::Value> = match self.request("GET", &format!("api/config?{query}"), None).await {
            Ok(body) => serde_json::from_str(&body).ok(),
            Err(TransportError::SignedOut) => return Err(TransportError::SignedOut),
            Err(_) => None,
        };
        let (stt_enabled, stt_provider, tts_provider) = match &config {
            Some(c) => (Some(truthy(&c["stt"]["enabled"])), config_word(&c["stt"]["provider"]), config_word(&c["tts"]["provider"])),
            None => (None, None, None),
        };
        Ok(VoiceSetup { transcribe, speak, stt_enabled, stt_provider, tts_provider })
    }

    /// One `POST` to an audio route for `profile`, with a JSON body.
    async fn post_audio(&self, path: &str, profile: &str, body: &serde_json::Value) -> Result<AudioAnswer, TransportError> {
        let mut url = endpoint(&self.base, path);
        url.query_pairs_mut().append_pair("profile", profile);
        let resp = self
            .http
            .post(url)
            .header(header::COOKIE, self.cookie_header())
            .json(body)
            .send()
            .await
            .map_err(|e| TransportError::Unreachable(e.to_string()))?;
        self.keep_cookies(&resp);
        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED {
            return Err(TransportError::SignedOut);
        }
        let text = resp.text().await.map_err(|e| TransportError::Unreachable(e.to_string()))?;
        if status.is_success() {
            return serde_json::from_str(&text)
                .map(AudioAnswer::Done)
                .map_err(|_| TransportError::Unexpected { status: status.as_u16(), body: text.chars().take(300).collect() });
        }
        let reason = refusal_reason(status, &text);
        // FastAPI's own "no such route" (and the headless backend's catch-all) differ from a refusal by the route
        // itself, such as an unknown profile, which also answers 404 but with its own reason.
        let no_route = match status {
            StatusCode::METHOD_NOT_ALLOWED => true,
            StatusCode::NOT_FOUND => reason == "Not Found" || reason.starts_with("Headless backend") || reason.starts_with("the server answered"),
            _ => false,
        };
        Ok(if no_route { AudioAnswer::NoRoute } else { AudioAnswer::Refused(reason) })
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
