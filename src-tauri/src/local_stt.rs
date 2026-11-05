//! Speech-to-text on this computer (ADR 0065): whisper.cpp's `whisper-cli` and a Whisper model in ggml format.
//!
//! The recording never leaves the computer. It is written to a private temp file, `whisper-cli` reads it, and the file
//! is deleted when the run ends. Only the text goes back to the webview, which sends it to Hermes as typed text.
//!
//! What runs is never named by the webview. The engine is the one the owner picked in the native Open dialog, or else
//! the first `whisper-cli` (or `whisper-cpp`) found on `PATH`. The model is one of the five Whisper sizes, downloaded
//! from whisper.cpp's own Hugging Face repository into the app's data folder and checked against its pinned size and
//! SHA-256, or a model file the owner picked in the Open dialog. The engine runs as a fixed argument list with no shell
//! and a timeout.
//!
//! The settings (model size, language, picked engine and picked model file) are kept in `local-stt.json` in the app's
//! data folder, written whole and read back after every change.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeBody};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

/// A Whisper model this app can download: its size name, file, exact byte count and SHA-256, as whisper.cpp's Hugging
/// Face repository (`ggerganov/whisper.cpp`, branch `main`) lists them (its LFS object ids, read 2026-11-04).
#[derive(Debug, Clone, Copy)]
pub struct ModelInfo {
    pub name: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

impl ModelInfo {
    pub fn file_name(&self) -> String {
        format!("ggml-{}.bin", self.name)
    }
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo { name: "tiny", bytes: 77_691_713, sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" },
    ModelInfo { name: "base", bytes: 147_951_465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" },
    ModelInfo { name: "small", bytes: 487_601_967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" },
    ModelInfo { name: "medium", bytes: 1_533_763_059, sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208" },
    ModelInfo { name: "large-v3", bytes: 3_095_033_483, sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2" },
];

/// Where the models are downloaded from: whisper.cpp's own repository, at a file name from `MODELS` only.
pub const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

/// The program names looked for on `PATH`, in order: whisper.cpp's CLI as it is built (`whisper-cli`) and as some
/// distributions package it.
pub const ENGINE_NAMES: &[&str] = &["whisper-cli", "whisper-cpp", "whisper.cpp"];

/// The most a recording can be: Hermes's own limit on one to transcribe, so both sides take the same recordings.
pub const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;

/// The longest and shortest a run may take before it is stopped, in seconds.
pub const MAX_TIMEOUT_SECONDS: u64 = 600;
pub const MIN_TIMEOUT_SECONDS: u64 = 5;

pub fn model_info(name: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.name == name)
}

/// The owner's settings, as kept in `local-stt.json`. `engine` and `model_file` are set only from the Open dialog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub model: String,
    pub language: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_file: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Config { model: "base".into(), language: "auto".into(), engine: None, model_file: None }
    }
}

/// `auto`, or a Whisper language code: two or three lowercase letters (`en`, `haw`, `yue`).
pub fn valid_language(language: &str) -> bool {
    language == "auto" || ((2..=3).contains(&language.len()) && language.bytes().all(|b| b.is_ascii_lowercase()))
}

impl Config {
    /// A stored file as it can be used: anything unknown or malformed falls back to the default, field by field.
    pub fn sanitized(mut self) -> Config {
        if model_info(&self.model).is_none() {
            self.model = Config::default().model;
        }
        if !valid_language(&self.language) {
            self.language = Config::default().language;
        }
        self.engine = self.engine.filter(|p| p.is_absolute());
        self.model_file = self.model_file.filter(|p| p.is_absolute());
        self
    }

    pub fn load(path: &Path) -> Config {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok())
            .map(Config::sanitized)
            .unwrap_or_default()
    }

    /// Writes the file whole (a temp file renamed over it), then reads it back: what is returned is what was stored.
    pub fn save(&self, path: &Path) -> Result<Config, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make the settings folder: {e}"))?;
        }
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, json).map_err(|e| format!("Couldn't save the settings: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("Couldn't save the settings: {e}"))?;
        let back = Config::load(path);
        if &back != self {
            return Err("The settings didn't read back as they were saved.".into());
        }
        Ok(back)
    }
}

/// Whether `path` is a regular file someone may run.
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// The first of `names` found as a runnable file in a directory of `path_var` (a `PATH` value). Relative entries are
/// skipped, so a program in whatever folder the app was started from never runs.
pub fn find_on_path(names: &[&str], path_var: Option<OsString>) -> Option<PathBuf> {
    let path_var = path_var?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&path_var).filter(|d| d.is_absolute()).collect();
    names.iter().find_map(|name| dirs.iter().map(|d| d.join(name)).find(|p| is_executable(p)))
}

/// The arguments `whisper-cli` runs with: the model, the recording, the language, plain text only (no timestamps, no
/// progress), and up to eight threads.
pub fn engine_args(model: &Path, audio: &Path, language: &str, threads: usize) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    for (flag, value) in [("-m", model.as_os_str()), ("-f", audio.as_os_str())] {
        args.push(flag.into());
        args.push(value.to_owned());
    }
    args.extend(["-l".into(), language.into(), "-nt".into(), "-np".into(), "-t".into(), threads.clamp(1, 8).to_string().into()]);
    args
}

/// The text of `whisper-cli -nt -np`'s output: one segment per line, joined with single spaces. Whisper's markers for
/// no speech (`[BLANK_AUDIO]`, `(silence)` and the like, a whole segment in brackets) are dropped, so silence is empty.
pub fn transcript_text(stdout: &str) -> String {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let bracketed = |open: char, close: char| line.starts_with(open) && line.ends_with(close);
            !(bracketed('[', ']') || bracketed('(', ')') || bracketed('*', '*'))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether `audio` is a WAV file (RIFF … WAVE), the only kind the webview records.
pub fn is_wav(audio: &[u8]) -> bool {
    audio.len() > 44 && &audio[0..4] == b"RIFF" && &audio[8..12] == b"WAVE"
}

/// A folder only this user can read, deleted with everything in it when dropped.
pub struct PrivateDir(PathBuf);

impl PrivateDir {
    pub fn new(parent: &Path) -> std::io::Result<PrivateDir> {
        use std::os::unix::fs::DirBuilderExt;
        static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        for _ in 0..16 {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let seed = format!("{}-{}-{}", std::process::id(), nanos, COUNT.fetch_add(1, Ordering::Relaxed));
            let name = format!("hermes-chat-stt-{}", &hex(&Sha256::digest(seed.as_bytes()))[..16]);
            let dir = parent.join(name);
            // `create` (not `create_dir_all`) fails if the name exists, so a folder someone else made is never used.
            match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
                Ok(()) => return Ok(PrivateDir(dir)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::other("couldn't make a private temp folder"))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for PrivateDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Writes `audio` to a private temp file, runs `engine` on it with `model`, and returns the text. The file and its
/// folder are deleted when this returns, whatever happened; a run past `timeout` is killed.
pub async fn transcribe_with(engine: &Path, model: &Path, language: &str, audio: &[u8], timeout: Duration, tmp_parent: &Path) -> Result<String, String> {
    if !is_wav(audio) {
        return Err("The recording isn't a WAV file.".into());
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err(format!("The recording is over {} MB.", MAX_AUDIO_BYTES / 1024 / 1024));
    }
    let dir = PrivateDir::new(tmp_parent).map_err(|e| format!("Couldn't make a private temp folder: {e}"))?;
    let file = dir.path().join("recording.wav");
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&file)
            .map_err(|e| format!("Couldn't write the recording to a temp file: {e}"))?;
        f.write_all(audio).map_err(|e| format!("Couldn't write the recording to a temp file: {e}"))?;
    }
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut command = tokio::process::Command::new(engine);
    command
        .args(engine_args(model, &file, language, threads))
        .current_dir(dir.path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = command.spawn().map_err(|e| format!("Couldn't start {}: {e}", engine.display()))?;
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(output) => output.map_err(|e| format!("{} failed: {e}", engine.display()))?,
        // Dropping the future drops the child, which kills it (`kill_on_drop`).
        Err(_) => return Err(format!("It took longer than {} s, so it was stopped.", timeout.as_secs())),
    };
    drop(dir);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let last = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("");
        let last: String = last.chars().filter(|c| !c.is_control()).take(300).collect();
        let how = output.status.code().map_or_else(|| "was stopped".to_string(), |c| format!("exited with code {c}"));
        return Err(if last.is_empty() { format!("whisper.cpp {how}.") } else { format!("whisper.cpp {how}: {last}") });
    }
    Ok(transcript_text(&String::from_utf8_lossy(&output.stdout)))
}

/// A download's progress, as the webview's Channel gets it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub name: String,
    pub done: u64,
    pub total: u64,
}

/// Downloads `info` from `base_url` into `dir`: to a hidden `.part` file, checked for its exact size and SHA-256, then
/// renamed into place. Anything else is deleted, so a wrong or partial file is never taken as the model.
pub async fn download_model(
    client: &reqwest::Client,
    base_url: &str,
    dir: &Path,
    info: &ModelInfo,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<PathBuf, String> {
    use tokio::io::AsyncWriteExt;
    tokio::fs::create_dir_all(dir).await.map_err(|e| format!("Couldn't make the models folder: {e}"))?;
    let dest = dir.join(info.file_name());
    let part = dir.join(format!(".{}.part", info.file_name()));
    let result = async {
        let mut response = interruptible(cancel, client.get(format!("{base_url}{}", info.file_name())).send())
            .await?
            .map_err(|e| format!("Couldn't reach the download: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("The download answered {}.", response.status()));
        }
        let mut file = tokio::fs::File::create(&part).await.map_err(|e| format!("Couldn't write the model: {e}"))?;
        let mut hash = Sha256::new();
        let mut done: u64 = 0;
        while let Some(chunk) = interruptible(cancel, response.chunk()).await?.map_err(|e| format!("The download broke off: {e}"))? {
            done += chunk.len() as u64;
            if done > info.bytes {
                return Err("The download is bigger than the model should be, so it was dropped.".into());
            }
            hash.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| format!("Couldn't write the model: {e}"))?;
            progress(done);
        }
        file.flush().await.map_err(|e| e.to_string())?;
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
        if done != info.bytes {
            return Err(format!("The download ended at {done} of {} bytes.", info.bytes));
        }
        if hex(&hash.finalize()) != info.sha256 {
            return Err("The download doesn't match the model's checksum, so it was dropped.".into());
        }
        tokio::fs::rename(&part, &dest).await.map_err(|e| format!("Couldn't put the model in place: {e}"))?;
        Ok(dest.clone())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    result
}

/// How long a download may go without a byte before it is given up.
pub const DOWNLOAD_STALL: Duration = Duration::from_secs(60);

/// Waits for `step`, but gives up as soon as `cancel` is set (checked every 100 ms) or after `DOWNLOAD_STALL` with
/// nothing: a server that stops sending can't hold the download, and its slot, for ever.
async fn interruptible<T>(cancel: &AtomicBool, step: impl std::future::Future<Output = T>) -> Result<T, String> {
    let cancelled = async {
        while !cancel.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::select! {
        out = step => Ok(out),
        () = cancelled => Err("Cancelled.".into()),
        () = tokio::time::sleep(DOWNLOAD_STALL) => Err(format!("The download stalled: nothing came for {} s.", DOWNLOAD_STALL.as_secs())),
    }
}

/// A model size as the screen lists it: its size, and whether it is downloaded (the file is there at its exact size).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelState {
    pub name: String,
    pub bytes: u64,
    pub downloaded: bool,
}

/// A file the owner picked: its path, and its size, or none when it is no longer there.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

/// The engine that will run: its path, whether the owner picked it (else it was found on `PATH`), and its version.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineState {
    pub path: String,
    pub picked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Everything Settings → Voice shows about speech-to-text on this computer. `ready`: an engine and a model are there,
/// so "This computer" can be used; `why`: what is missing when it isn't.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub model: String,
    pub language: String,
    pub models: Vec<ModelState>,
    pub models_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_file: Option<PickedFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<EngineState>,
    /// The engine the owner picked, when it can no longer be run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picked_engine_missing: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloading: Option<DownloadProgress>,
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

/// The model file that will be used: the picked one, else the downloaded size, if it is there.
pub fn model_path(config: &Config, models_dir: &Path) -> Option<PathBuf> {
    if let Some(file) = &config.model_file {
        return file.is_file().then(|| file.clone());
    }
    let info = model_info(&config.model)?;
    let path = models_dir.join(info.file_name());
    std::fs::metadata(&path).ok().filter(|m| m.is_file() && m.len() == info.bytes).map(|_| path)
}

/// The engine that will run: the picked one if it can still be run, else the first found on `PATH`. A picked engine
/// that is gone is not replaced by one on `PATH`: the owner chose it, so they are told instead.
pub fn engine_path(config: &Config, path_var: Option<OsString>) -> Option<(PathBuf, bool)> {
    match &config.engine {
        Some(picked) => is_executable(picked).then(|| (picked.clone(), true)),
        None => find_on_path(ENGINE_NAMES, path_var).map(|p| (p, false)),
    }
}

/// The status for `config`, without the engine's version (that needs a run; see `engine_version`).
pub fn status_of(config: &Config, models_dir: &Path, path_var: Option<OsString>, downloading: Option<DownloadProgress>) -> Status {
    let models = MODELS
        .iter()
        .map(|m| ModelState {
            name: m.name.into(),
            bytes: m.bytes,
            downloaded: std::fs::metadata(models_dir.join(m.file_name())).map(|md| md.is_file() && md.len() == m.bytes).unwrap_or(false),
        })
        .collect();
    let model_file = config.model_file.as_ref().map(|p| PickedFile {
        path: p.display().to_string(),
        bytes: std::fs::metadata(p).ok().filter(|m| m.is_file()).map(|m| m.len()),
    });
    let engine = engine_path(config, path_var).map(|(p, picked)| EngineState { path: p.display().to_string(), picked, version: None });
    let picked_engine_missing = match (&config.engine, &engine) {
        (Some(p), None) => Some(p.display().to_string()),
        _ => None,
    };
    let model = model_path(config, models_dir);
    let why = if engine.is_none() {
        Some(match &picked_engine_missing {
            Some(p) => format!("The whisper.cpp program you picked ({p}) can't be run any more."),
            None => "whisper.cpp isn't installed on this computer (no whisper-cli on PATH).".into(),
        })
    } else if model.is_none() {
        Some(match &config.model_file {
            Some(p) => format!("The model file you picked ({}) isn't there any more.", p.display()),
            None => format!("The {} model isn't downloaded yet.", config.model),
        })
    } else {
        None
    };
    Status {
        model: config.model.clone(),
        language: config.language.clone(),
        models,
        models_dir: models_dir.display().to_string(),
        model_file,
        engine,
        picked_engine_missing,
        downloading,
        ready: why.is_none(),
        why,
    }
}

/// The engine's version line (`whisper.cpp version: 1.9.5`), if `--version` gives one within two seconds.
pub async fn engine_version(engine: &Path) -> Option<String> {
    let mut command = tokio::process::Command::new(engine);
    command.arg("--version").stdin(std::process::Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(2), command.output()).await.ok()?.ok()?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let line = text.lines().find(|l| l.to_lowercase().contains("version"))?;
    let version = line.rsplit(':').next()?.trim();
    (!version.is_empty() && version.len() <= 40 && !version.chars().any(char::is_control)).then(|| version.to_string())
}

/// The app's state for speech-to-text here: the settings (loaded once, then kept in step with the file), the download
/// running (one at a time) and its cancel flag.
#[derive(Default)]
pub struct LocalStt {
    config: Mutex<Option<Config>>,
    download: Mutex<Option<(DownloadProgress, Arc<AtomicBool>)>>,
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("local-stt.json"))
}

fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("whisper-models"))
}

impl LocalStt {
    fn config(&self, app: &tauri::AppHandle) -> Result<Config, String> {
        let mut held = self.config.lock().map_err(|e| e.to_string())?;
        if held.is_none() {
            *held = Some(Config::load(&config_path(app)?));
        }
        Ok(held.clone().unwrap_or_default())
    }

    fn change(&self, app: &tauri::AppHandle, f: impl FnOnce(&mut Config)) -> Result<(), String> {
        let mut held = self.config.lock().map_err(|e| e.to_string())?;
        let mut next = held.clone().unwrap_or_else(|| config_path(app).map(|p| Config::load(&p)).unwrap_or_default());
        f(&mut next);
        let saved = next.sanitized().save(&config_path(app)?)?;
        *held = Some(saved);
        Ok(())
    }

    fn downloading(&self) -> Option<DownloadProgress> {
        self.download.lock().ok()?.as_ref().map(|(p, _)| p.clone())
    }

    async fn status(&self, app: &tauri::AppHandle) -> Result<Status, String> {
        let config = self.config(app)?;
        let mut status = status_of(&config, &models_dir(app)?, std::env::var_os("PATH"), self.downloading());
        if let Some(engine) = &mut status.engine {
            engine.version = engine_version(Path::new(&engine.path)).await;
        }
        Ok(status)
    }
}

#[tauri::command]
pub async fn local_stt_status(app: tauri::AppHandle, state: State<'_, LocalStt>) -> Result<Status, String> {
    state.status(&app).await
}

/// Sets the model size and the language. Either may be left out. An unknown size or a malformed language is refused.
/// Setting a size also stops using a picked model file, so the size picked is the one that runs.
#[tauri::command]
pub async fn local_stt_set(app: tauri::AppHandle, state: State<'_, LocalStt>, model: Option<String>, language: Option<String>) -> Result<Status, String> {
    if let Some(m) = &model {
        if model_info(m).is_none() {
            return Err(format!("There's no Whisper model called {m}."));
        }
    }
    if let Some(l) = &language {
        if !valid_language(l) {
            return Err("The language must be auto or a code such as en or es.".into());
        }
    }
    state.change(&app, |c| {
        // Picking a size uses it: a picked model file stops being used (the file itself stays).
        if let Some(m) = model {
            c.model = m;
            c.model_file = None;
        }
        if let Some(l) = language {
            c.language = l;
        }
    })?;
    state.status(&app).await
}

/// Opens the native Open dialog to pick the whisper.cpp program (`what: "engine"`) or a ggml model file (`"model"`).
/// Cancelling changes nothing. The webview never names the path, so it can't make anything else run.
#[tauri::command]
pub async fn local_stt_pick(app: tauri::AppHandle, state: State<'_, LocalStt>, what: String) -> Result<Status, String> {
    let engine = match what.as_str() {
        "engine" => true,
        "model" => false,
        _ => return Err("Pick the engine or a model.".into()),
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title(if engine { "Pick whisper.cpp's whisper-cli" } else { "Pick a Whisper model (ggml .bin)" });
    if !engine {
        dialog = dialog.add_filter("Whisper model", &["bin"]);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_file(move |path| {
        let _ = tx.send(path);
    });
    if let Some(path) = rx.await.map_err(|e| e.to_string())? {
        let path = path.into_path().map_err(|e| e.to_string())?;
        if engine && !is_executable(&path) {
            return Err(format!("{} isn't a program that can be run.", path.display()));
        }
        if !engine && !path.is_file() {
            return Err(format!("{} isn't a file.", path.display()));
        }
        state.change(&app, |c| {
            if engine {
                c.engine = Some(path);
            } else {
                c.model_file = Some(path);
            }
        })?;
    }
    state.status(&app).await
}

/// Forgets the picked engine (back to the one on `PATH`) or the picked model file (back to the downloaded size). The
/// file itself is left alone: this app never deletes a file the owner picked.
#[tauri::command]
pub async fn local_stt_forget(app: tauri::AppHandle, state: State<'_, LocalStt>, what: String) -> Result<Status, String> {
    match what.as_str() {
        "engine" => state.change(&app, |c| c.engine = None)?,
        "model" => state.change(&app, |c| c.model_file = None)?,
        _ => return Err("Forget the engine or the model.".into()),
    }
    state.status(&app).await
}

/// Downloads a model size into the models folder, reporting progress on `on_progress`. One download runs at a time.
#[tauri::command]
pub async fn local_stt_download(app: tauri::AppHandle, state: State<'_, LocalStt>, name: String, on_progress: Channel<DownloadProgress>) -> Result<Status, String> {
    let info = model_info(&name).ok_or_else(|| format!("There's no Whisper model called {name}."))?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut held = state.download.lock().map_err(|e| e.to_string())?;
        if let Some((running, _)) = held.as_ref() {
            return Err(format!("The {} model is downloading already.", running.name));
        }
        *held = Some((DownloadProgress { name: name.clone(), done: 0, total: info.bytes }, cancel.clone()));
    }
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string());
    let dir = models_dir(&app);
    let result = match (client, dir) {
        (Ok(client), Ok(dir)) => {
            let mut last = std::time::Instant::now();
            download_model(&client, MODEL_BASE_URL, &dir, info, &cancel, |done| {
                if let Ok(mut held) = state.download.lock() {
                    if let Some((p, _)) = held.as_mut() {
                        p.done = done;
                    }
                }
                if last.elapsed() >= Duration::from_millis(200) || done == info.bytes {
                    last = std::time::Instant::now();
                    let _ = on_progress.send(DownloadProgress { name: name.clone(), done, total: info.bytes });
                }
            })
            .await
        }
        (Err(e), _) | (_, Err(e)) => Err(e),
    };
    if let Ok(mut held) = state.download.lock() {
        *held = None;
    }
    result?;
    state.status(&app).await
}

#[tauri::command]
pub fn local_stt_cancel_download(state: State<'_, LocalStt>) {
    if let Ok(held) = state.download.lock() {
        if let Some((_, cancel)) = held.as_ref() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// Deletes a downloaded model size from the models folder. Only those five files can be deleted this way.
#[tauri::command]
pub async fn local_stt_delete(app: tauri::AppHandle, state: State<'_, LocalStt>, name: String) -> Result<Status, String> {
    let info = model_info(&name).ok_or_else(|| format!("There's no Whisper model called {name}."))?;
    if state.downloading().is_some_and(|d| d.name == name) {
        return Err(format!("The {name} model is still downloading. Cancel it first."));
    }
    let path = models_dir(&app)?.join(info.file_name());
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Couldn't delete {}: {e}", path.display())),
    }
    state.status(&app).await
}

/// What this computer heard. `provider` names the engine and model, as Hermes's answer names its provider.
#[derive(Debug, Serialize)]
pub struct LocalTranscript {
    pub text: String,
    pub provider: String,
}

/// Transcribes a recording on this computer. The audio comes as the raw request body (a WAV file), the timeout in
/// seconds as the `x-timeout` header. Nothing here keeps or logs the audio or the text, and nothing goes to the network.
#[tauri::command]
pub async fn local_stt_transcribe(app: tauri::AppHandle, state: State<'_, LocalStt>, request: tauri::ipc::Request<'_>) -> Result<LocalTranscript, String> {
    let InvokeBody::Raw(audio) = request.body() else {
        return Err("The recording didn't arrive as audio bytes.".into());
    };
    let timeout = request
        .headers()
        .get("x-timeout")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(MAX_TIMEOUT_SECONDS)
        .clamp(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
    let config = state.config(&app)?;
    let dir = models_dir(&app)?;
    let status = status_of(&config, &dir, std::env::var_os("PATH"), None);
    let (Some((engine, _)), Some(model)) = (engine_path(&config, std::env::var_os("PATH")), model_path(&config, &dir)) else {
        return Err(status.why.unwrap_or_else(|| "Speech-to-text isn't set up on this computer.".into()));
    };
    let label = match &config.model_file {
        Some(p) => p.file_name().map_or_else(|| p.display().to_string(), |n| n.to_string_lossy().into_owned()),
        None => config.model.clone(),
    };
    let text = transcribe_with(&engine, &model, &config.language, audio, Duration::from_secs(timeout), &std::env::temp_dir()).await?;
    Ok(LocalTranscript { text, provider: format!("whisper.cpp ({label})") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hermes-local-stt-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn wav() -> Vec<u8> {
        let mut w = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        w.resize(64, 0);
        w
    }

    #[test]
    fn the_engine_is_found_on_path_in_order_and_never_in_a_relative_folder() {
        let a = scratch("path-a");
        let b = scratch("path-b");
        script(&b, "whisper-cpp", "true");
        let first = script(&a, "whisper-cli", "true");
        std::fs::write(a.join("whisper-cpp"), "not executable").unwrap();
        let path = std::env::join_paths([a.clone(), b.clone()]).unwrap();
        assert_eq!(find_on_path(ENGINE_NAMES, Some(path.clone())), Some(first));
        // whisper-cpp in `a` isn't executable, so `b`'s is found.
        assert_eq!(find_on_path(&["whisper-cpp"], Some(path)), Some(b.join("whisper-cpp")));
        assert_eq!(find_on_path(ENGINE_NAMES, Some("relative/bin".into())), None);
        assert_eq!(find_on_path(ENGINE_NAMES, None), None);
    }

    #[test]
    fn the_engine_runs_as_a_fixed_argument_list() {
        let args = engine_args(Path::new("/m/ggml-base.bin"), Path::new("/t/rec wav; rm -rf ~"), "auto", 32);
        let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["-m", "/m/ggml-base.bin", "-f", "/t/rec wav; rm -rf ~", "-l", "auto", "-nt", "-np", "-t", "8"]);
        let one = engine_args(Path::new("m"), Path::new("f"), "en", 0);
        assert_eq!(one.last().unwrap(), "1");
    }

    #[test]
    fn the_output_is_joined_and_no_speech_markers_are_dropped() {
        assert_eq!(transcript_text("\n And so my fellow Americans,\n ask not.\n"), "And so my fellow Americans, ask not.");
        assert_eq!(transcript_text(" [BLANK_AUDIO]\n"), "");
        assert_eq!(transcript_text("(silence)\n *music*\n"), "");
        assert_eq!(transcript_text("[Music] then words\n"), "[Music] then words");
    }

    #[test]
    fn settings_read_back_and_bad_values_fall_back() {
        let dir = scratch("config");
        let path = dir.join("local-stt.json");
        assert_eq!(Config::load(&path), Config::default());
        let c = Config { model: "small".into(), language: "es".into(), engine: Some("/usr/bin/whisper-cli".into()), model_file: None };
        assert_eq!(c.save(&path).unwrap(), c);
        assert_eq!(Config::load(&path), c);
        std::fs::write(&path, r#"{"model":"huge","language":"English!","engine":"bin/whisper","modelFile":"/m.bin"}"#).unwrap();
        let back = Config::load(&path);
        assert_eq!(back, Config { model: "base".into(), language: "auto".into(), engine: None, model_file: Some("/m.bin".into()) });
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(Config::load(&path), Config::default());
        assert!(valid_language("haw") && valid_language("auto") && !valid_language("EN") && !valid_language("e") && !valid_language("en-US"));
    }

    #[test]
    fn status_says_what_is_missing() {
        let dir = scratch("status");
        let models = dir.join("models");
        std::fs::create_dir_all(&models).unwrap();
        let bin = scratch("status-bin");
        let none = status_of(&Config::default(), &models, Some(bin.clone().into_os_string()), None);
        assert!(!none.ready);
        assert!(none.why.unwrap().contains("isn't installed"));
        assert_eq!(none.models.len(), 5);
        assert!(none.models.iter().all(|m| !m.downloaded));

        script(&bin, "whisper-cli", "true");
        let no_model = status_of(&Config::default(), &models, Some(bin.clone().into_os_string()), None);
        assert!(!no_model.ready);
        assert_eq!(no_model.why.as_deref(), Some("The base model isn't downloaded yet."));

        // A file of the wrong size isn't taken as downloaded.
        std::fs::write(models.join("ggml-base.bin"), b"short").unwrap();
        assert!(!status_of(&Config::default(), &models, Some(bin.clone().into_os_string()), None).ready);

        // A picked model file is used whatever its size; one that's gone is said.
        let file = dir.join("mine.bin");
        std::fs::write(&file, b"ggml").unwrap();
        let picked = Config { model_file: Some(file.clone()), ..Config::default() };
        let s = status_of(&picked, &models, Some(bin.clone().into_os_string()), None);
        assert!(s.ready, "{:?}", s.why);
        assert_eq!(s.model_file.unwrap().bytes, Some(4));
        std::fs::remove_file(&file).unwrap();
        let gone = status_of(&picked, &models, Some(bin.clone().into_os_string()), None);
        assert!(gone.why.unwrap().contains("isn't there any more"));

        // A picked engine that's gone isn't swapped for the one on PATH.
        let lost = Config { engine: Some(dir.join("gone/whisper-cli")), ..Config::default() };
        let s = status_of(&lost, &models, Some(bin.into_os_string()), None);
        assert!(s.engine.is_none());
        assert!(s.picked_engine_missing.is_some());
        assert!(s.why.unwrap().contains("can't be run any more"));
    }

    #[tokio::test]
    async fn a_run_gets_the_text_and_leaves_no_recording_behind() {
        let dir = scratch("run");
        let tmp = scratch("run-tmp");
        // The stand-in checks its arguments, that the recording is private, and prints what whisper-cli would.
        let engine = script(
            &dir,
            "whisper-cli",
            r#"[ "$1" = -m ] && [ "$2" = /models/ggml-base.bin ] && [ "$3" = -f ] && [ "$5" = -l ] && [ "$6" = es ] || exit 3
[ "$(stat -c %a "$4")" = 600 ] || exit 4
[ "$(stat -c %a "$(dirname "$4")")" = 700 ] || exit 5
echo "$4" > "$0.seen"
printf '\n Hola,\n mundo.\n'"#,
        );
        let text = transcribe_with(&engine, Path::new("/models/ggml-base.bin"), "es", &wav(), Duration::from_secs(10), &tmp).await.unwrap();
        assert_eq!(text, "Hola, mundo.");
        let seen = std::fs::read_to_string(dir.join("whisper-cli.seen")).unwrap();
        assert!(!Path::new(seen.trim()).exists(), "the recording was left behind");
        assert_eq!(std::fs::read_dir(&tmp).unwrap().count(), 0, "the temp folder was left behind");
    }

    #[tokio::test]
    async fn a_failed_slow_or_wrong_run_says_why() {
        let dir = scratch("fail");
        let tmp = scratch("fail-tmp");
        let failing = script(&dir, "fails", "echo 'loading' >&2; echo 'error: failed to open model' >&2; exit 2");
        let err = transcribe_with(&failing, Path::new("/m"), "auto", &wav(), Duration::from_secs(10), &tmp).await.unwrap_err();
        assert_eq!(err, "whisper.cpp exited with code 2: error: failed to open model");

        let slow = script(&dir, "slow", "exec sleep 30");
        let started = std::time::Instant::now();
        let err = transcribe_with(&slow, Path::new("/m"), "auto", &wav(), Duration::from_secs(1), &tmp).await.unwrap_err();
        assert!(err.contains("longer than 1 s"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(std::fs::read_dir(&tmp).unwrap().count(), 0);

        let err = transcribe_with(&failing, Path::new("/m"), "auto", b"OggS not a wav file at all, longer than forty-four bytes", Duration::from_secs(1), &tmp)
            .await
            .unwrap_err();
        assert!(err.contains("isn't a WAV"));
        let err = transcribe_with(&dir.join("missing"), Path::new("/m"), "auto", &wav(), Duration::from_secs(1), &tmp).await.unwrap_err();
        assert!(err.starts_with("Couldn't start"), "{err}");
    }

    /// Serves `body` at every path, over loopback.
    async fn serve(body: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(move || {
            let body = body.clone();
            async move { body }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/")
    }

    #[tokio::test]
    async fn a_download_is_kept_only_when_its_size_and_checksum_match() {
        let body = b"pretend ggml model".to_vec();
        let digest = hex(&Sha256::digest(&body));
        let digest: &'static str = Box::leak(digest.into_boxed_str());
        let good = ModelInfo { name: "tiny", bytes: body.len() as u64, sha256: digest };
        let url = serve(body.clone()).await;
        let client = reqwest::Client::new();
        let dir = scratch("download");
        let mut seen = 0;
        let path = download_model(&client, &url, &dir, &good, &AtomicBool::new(false), |d| seen = d).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), body);
        assert_eq!(seen, body.len() as u64);

        let wrong_hash = ModelInfo { name: "base", sha256: "00", ..good };
        let err = download_model(&client, &url, &dir, &wrong_hash, &AtomicBool::new(false), |_| {}).await.unwrap_err();
        assert!(err.contains("checksum"));
        let wrong_size = ModelInfo { name: "small", bytes: 5, ..good };
        assert!(download_model(&client, &url, &dir, &wrong_size, &AtomicBool::new(false), |_| {}).await.unwrap_err().contains("bigger"));
        let cancelled = ModelInfo { name: "medium", ..good };
        assert_eq!(download_model(&client, &url, &dir, &cancelled, &AtomicBool::new(true), |_| {}).await.unwrap_err(), "Cancelled.");
        // Only the good one is there, and no part file is left.
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["ggml-tiny.bin"]);
    }

    #[tokio::test]
    async fn a_stalled_download_can_be_cancelled() {
        // Headers, then a body that never comes.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(|| async {
            axum::body::Body::from_stream(futures_util::stream::pending::<Result<Vec<u8>, std::io::Error>>())
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = scratch("stalled");
        let info = ModelInfo { name: "tiny", bytes: 10, sha256: "00" };
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            flag.store(true, Ordering::Relaxed);
        });
        let started = std::time::Instant::now();
        let err = download_model(&reqwest::Client::new(), &format!("http://{addr}/"), &dir, &info, &cancel, |_| {}).await.unwrap_err();
        assert_eq!(err, "Cancelled.");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "the part file was left behind");
    }

    #[test]
    fn the_pinned_models_are_the_five_sizes_with_full_checksums() {
        let names: Vec<&str> = MODELS.iter().map(|m| m.name).collect();
        assert_eq!(names, ["tiny", "base", "small", "medium", "large-v3"]);
        assert!(MODELS.iter().all(|m| m.sha256.len() == 64 && m.sha256.bytes().all(|b| b.is_ascii_hexdigit())));
    }

    /// Runs the real whisper.cpp when `HERMES_TEST_WHISPER_CLI` and `HERMES_TEST_WHISPER_MODEL` name it and a model, on
    /// whisper.cpp's own JFK sample (`HERMES_TEST_WHISPER_WAV`). Skipped otherwise.
    #[tokio::test]
    async fn a_real_whisper_cpp_transcribes_when_one_is_given() {
        let (Some(cli), Some(model), Some(wav)) =
            (std::env::var_os("HERMES_TEST_WHISPER_CLI"), std::env::var_os("HERMES_TEST_WHISPER_MODEL"), std::env::var_os("HERMES_TEST_WHISPER_WAV"))
        else {
            eprintln!("skipped: no HERMES_TEST_WHISPER_CLI/MODEL/WAV");
            return;
        };
        let audio = std::fs::read(wav).unwrap();
        let text = transcribe_with(Path::new(&cli), Path::new(&model), "auto", &audio, Duration::from_secs(120), &std::env::temp_dir()).await.unwrap();
        assert!(text.to_lowercase().contains("ask not what your country can do for you"), "{text}");
        assert!(engine_version(Path::new(&cli)).await.is_some());
    }
}
