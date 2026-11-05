//! Speech to text on this computer (#220, ADR 0067): finds the engines already installed here, keeps which one the
//! owner picked, and runs it on a Dictation or Voice conversation recording instead of sending the audio to Hermes.
//!
//! Only programs found on `PATH` under a known engine's name, or one the owner picked in the native Open dialog, are
//! ever run, and only with an argument list built here: no shell. The webview names an engine and model only by
//! choosing among what Rust found or was given through a dialog. The recording goes to a private folder (0700) that is
//! deleted once the text is read, and the engine is killed after a timeout. The choice lives in `local-stt.json` in the
//! app's config folder, for this computer, not per connection or profile.
use std::ffi::{OsStr, OsString};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::transport::Transcript;

const SETTINGS_FILE: &str = "local-stt.json";
/// Serializes the settings file's read-modify-write between this app's commands.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
/// The largest recording taken: Dictation's five minutes of 16 kHz 16-bit mono WAV is 9.6 MB.
const MAX_WAV_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    WhisperCpp,
    /// faster-whisper's command line, `whisper-ctranslate2`.
    FasterWhisper,
    OpenaiWhisper,
    Vosk,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::WhisperCpp => "whisper.cpp",
            Kind::FasterWhisper => "faster-whisper",
            Kind::OpenaiWhisper => "OpenAI Whisper",
            Kind::Vosk => "Vosk",
        }
    }
    /// Its model is a folder rather than one file.
    fn model_is_folder(self) -> bool {
        matches!(self, Kind::FasterWhisper | Kind::Vosk)
    }
}

/// The program names looked for on `PATH`.
const NAMES: [&str; 5] = ["whisper-cli", "whisper-cpp", "whisper", "whisper-ctranslate2", "vosk-transcriber"];

/// Which engine a program is, by its file name. `whisper` is both whisper.cpp's old name and OpenAI Whisper's Python
/// script, so a script (`#!`) is OpenAI's.
pub fn kind_of(binary: &Path) -> Option<Kind> {
    match binary.file_name()?.to_str()? {
        "whisper-cli" | "whisper-cpp" => Some(Kind::WhisperCpp),
        "whisper-ctranslate2" => Some(Kind::FasterWhisper),
        "vosk-transcriber" => Some(Kind::Vosk),
        "whisper" => {
            let mut head = [0u8; 2];
            let script = std::fs::File::open(binary).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head)).is_ok() && &head == b"#!";
            Some(if script { Kind::OpenaiWhisper } else { Kind::WhisperCpp })
        }
        _ => None,
    }
}

fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The engines on `path` (a `PATH` value): for each known name, the first executable with it, as the shell would run.
pub fn on_path(path: &OsStr) -> Vec<(Kind, PathBuf)> {
    NAMES
        .iter()
        .filter_map(|name| std::env::split_paths(path).map(|dir| dir.join(name)).find(|p| p.is_absolute() && is_executable(p)))
        .filter_map(|p| Some((kind_of(&p)?, p)))
        .collect()
}

/// The folders models usually sit in: the XDG data and cache folders, Hugging Face's cache, and the home folder.
pub struct Places {
    pub home: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub hf: PathBuf,
}

impl Places {
    fn from_env() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let var = |name: &str, or: PathBuf| std::env::var_os(name).filter(|v| !v.is_empty()).map_or(or, PathBuf::from);
        let data = var("XDG_DATA_HOME", home.join(".local/share"));
        let cache = var("XDG_CACHE_HOME", home.join(".cache"));
        let hf = var("HF_HOME", cache.join("huggingface"));
        Places { home, data, cache, hf }
    }
}

fn children(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
    out.sort();
    out
}

fn name_of(p: &Path) -> &str {
    p.file_name().and_then(|n| n.to_str()).unwrap_or("")
}

/// The models of `kind` in their usual folders under `places` (and the system's `/usr/share`, `/usr/local/share`).
pub fn models(kind: Kind, places: &Places) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = match kind {
        Kind::WhisperCpp => {
            // `whisper.cpp`, `whisper.cpp-model-base.en` and the like under each share folder, and their `models`.
            let mut dirs = vec![places.cache.join("whisper.cpp"), places.home.join("whisper.cpp/models")];
            for share in [places.data.clone(), "/usr/share".into(), "/usr/local/share".into()] {
                for d in children(&share).into_iter().filter(|d| name_of(d).starts_with("whisper")) {
                    dirs.push(d.join("models"));
                    dirs.push(d);
                }
            }
            let ggml = |p: &PathBuf| name_of(p).starts_with("ggml-") && name_of(p).ends_with(".bin") && p.is_file();
            dirs.iter().flat_map(|d| children(d)).filter(ggml).collect()
        }
        Kind::OpenaiWhisper => children(&places.cache.join("whisper")).into_iter().filter(|p| name_of(p).ends_with(".pt") && p.is_file()).collect(),
        Kind::FasterWhisper => children(&places.hf.join("hub"))
            .into_iter()
            .filter(|d| name_of(d).starts_with("models--") && name_of(d).contains("whisper"))
            .flat_map(|d| children(&d.join("snapshots")))
            .filter(|s| s.join("model.bin").exists())
            .collect(),
        Kind::Vosk => [places.cache.join("vosk"), places.data.join("vosk"), "/usr/share/vosk".into()]
            .iter()
            .flat_map(|d| children(d))
            .filter(|d| d.join("am").is_dir())
            .collect(),
    };
    found.dedup();
    found
}

/// An engine to run: its program and model, which the owner picked from what was found or through a dialog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Engine {
    pub kind: Kind,
    pub binary: PathBuf,
    pub model: Option<PathBuf>,
}

/// The owner's choice. `on_this_computer` false: Hermes transcribes, as before this setting.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub on_this_computer: bool,
    #[serde(default)]
    pub engine: Option<Engine>,
}

/// The settings, or the default when there is no file yet. A file that can't be read is an error, not the default:
/// the default sends recordings to Hermes, which the owner may have turned off.
fn read_settings(path: &Path) -> Result<Settings, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("The speech-to-text setting in {} can't be read: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(format!("The speech-to-text setting in {} can't be read: {e}", path.display())),
    }
}

fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let dir = path.parent().ok_or("No folder for the speech-to-text setting.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let text = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join(SETTINGS_FILE))
}

/// Why `engine` can't run now, or `None`.
pub fn problem(engine: Option<&Engine>) -> Option<String> {
    let Some(e) = engine else { return Some("No speech-to-text engine is chosen on this computer.".into()) };
    if !is_executable(&e.binary) {
        return Some(format!("{} isn't at {} any more, or can't be run.", e.kind.label(), e.binary.display()));
    }
    let Some(model) = &e.model else { return Some(format!("No model is chosen for {}.", e.kind.label())) };
    let there = if e.kind.model_is_folder() { model.is_dir() } else { model.is_file() };
    if !there {
        return Some(format!("The model {} isn't there any more.", model.display()));
    }
    None
}

/// The arguments that have `engine` transcribe `wav` into `<out>/audio.txt`. Each is one argument: nothing is parsed by
/// a shell. The input file is named `audio.wav`, so the Whisper command lines name their output `audio.txt`.
pub fn args(engine: &Engine, model: &Path, wav: &Path, out: &Path) -> Vec<OsString> {
    let s = |v: &str| OsString::from(v);
    let p = |v: &Path| v.as_os_str().to_owned();
    match engine.kind {
        // `-l auto`: a multilingual model detects the language; an English-only one ignores it. `-np`: results only.
        Kind::WhisperCpp => vec![s("-m"), p(model), s("-f"), p(wav), s("-l"), s("auto"), s("-nt"), s("-np"), s("-otxt"), s("-of"), p(&out.join("audio"))],
        Kind::FasterWhisper => vec![
            p(wav),
            s("--model_directory"),
            p(model),
            s("--output_dir"),
            p(out),
            s("--output_format"),
            s("txt"),
            s("--verbose"),
            s("False"),
        ],
        Kind::OpenaiWhisper => vec![
            p(wav),
            s("--model"),
            p(model),
            s("--output_dir"),
            p(out),
            s("--output_format"),
            s("txt"),
            s("--verbose"),
            s("False"),
            s("--fp16"),
            s("False"),
        ],
        Kind::Vosk => vec![s("-m"), p(model), s("-i"), p(wav), s("-o"), p(&out.join("audio.txt"))],
    }
}

/// An engine's output as one line of text, without whisper.cpp's `[BLANK_AUDIO]` and other lines that are only a
/// bracketed note.
pub fn clean(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !(l.starts_with('[') && l.ends_with(']')))
        .collect::<Vec<_>>()
        .join(" ")
}

/// A private folder for one recording, deleted with everything in it when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> std::io::Result<Self> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!("hermes-chat-stt-{}-{nanos}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        // `create`, not `create_all`: it fails if anything, a link included, is already there.
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        Ok(Scratch(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// How long an engine may take: a minute to load, plus three times the recording's length.
fn time_limit(wav_bytes: usize) -> Duration {
    Duration::from_secs(60 + 3 * (wav_bytes.saturating_sub(44) / 32_000) as u64)
}

/// Has `engine` transcribe a WAV recording, within `limit`. The recording is written to a private folder that is
/// deleted afterwards, whatever happens. Errors say why, for the owner.
pub async fn transcribe(engine: &Engine, wav: &[u8], limit: Duration) -> Result<Transcript, String> {
    if let Some(why) = problem(Some(engine)) {
        return Err(why);
    }
    if wav.len() > MAX_WAV_BYTES {
        return Err("The recording is too long to transcribe.".into());
    }
    let model = engine.model.as_deref().expect("checked by problem");
    let scratch = Scratch::new().map_err(|e| format!("Couldn't make a private folder for the recording: {e}"))?;
    let wav_path = scratch.0.join("audio.wav");
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&wav_path).map_err(|e| format!("Couldn't save the recording to transcribe: {e}"))?;
        f.write_all(wav).map_err(|e| format!("Couldn't save the recording to transcribe: {e}"))?;
    }
    let label = engine.kind.label();
    let child = tokio::process::Command::new(&engine.binary)
        .args(args(engine, model, &wav_path, &scratch.0))
        .current_dir(&scratch.0)
        // faster-whisper's model is already here; it must never fetch one.
        .env("HF_HUB_OFFLINE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("{label} couldn't be started: {e}"))?;
    let out = match tokio::time::timeout(limit, child.wait_with_output()).await {
        Err(_) => return Err(format!("{label} took longer than {} s, so it was stopped.", limit.as_secs())),
        Ok(r) => r.map_err(|e| format!("{label} failed: {e}"))?,
    };
    if !out.status.success() {
        // whisper-ctranslate2 prints some of its errors on stdout, so that is the fallback.
        let last_line = |b: &[u8]| String::from_utf8_lossy(b).lines().rev().map(str::trim).find(|l| !l.is_empty()).map(str::to_owned);
        let last = last_line(&out.stderr).or_else(|| last_line(&out.stdout)).unwrap_or_else(|| "no message".into());
        let how = out.status.code().map_or_else(|| "was killed".to_string(), |c| format!("exited with {c}"));
        return Err(format!("{label} {how}: {}", last.chars().take(300).collect::<String>()));
    }
    let text = std::fs::read_to_string(scratch.0.join("audio.txt")).map_err(|e| format!("{label} finished but wrote no transcript: {e}"))?;
    Ok(Transcript { text: clean(&text), provider: Some(label.into()) })
}

/// `None` when Hermes transcribes. Otherwise this computer's engine's answer: a recording is never sent to Hermes
/// while "This computer" is chosen, even when no engine is ready.
pub async fn transcribe_if_local(app: &AppHandle, mime: &str, wav: &[u8]) -> Option<Result<Transcript, String>> {
    match settings_path(app) {
        Ok(path) => transcribe_if_local_at(&path, mime, wav).await,
        Err(e) => Some(Err(e)),
    }
}

/// `transcribe_if_local` with the settings file at `path`.
pub async fn transcribe_if_local_at(path: &Path, mime: &str, wav: &[u8]) -> Option<Result<Transcript, String>> {
    let settings = match read_settings(path) {
        Ok(s) if !s.on_this_computer => return None,
        Ok(s) => s,
        Err(e) => return Some(Err(e)),
    };
    if mime != "audio/wav" {
        return Some(Err(format!("This computer's engine takes WAV recordings, not {mime}.")));
    }
    let Some(engine) = settings.engine else { return Some(Err(problem(None).unwrap())) };
    Some(transcribe(&engine, wav, time_limit(wav.len())).await)
}

/// What Settings → Voice shows of the choice.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub on_this_computer: bool,
    pub engine: Option<Engine>,
    pub label: Option<&'static str>,
    /// Why the engine can't run now.
    pub problem: Option<String>,
}

fn state_of(s: Settings) -> State {
    State { on_this_computer: s.on_this_computer, label: s.engine.as_ref().map(|e| e.kind.label()), problem: problem(s.engine.as_ref()), engine: s.engine }
}

/// An engine found on `PATH`, its version if it says, and the models found for it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub kind: Kind,
    pub label: &'static str,
    pub binary: PathBuf,
    pub version: Option<String>,
    pub models: Vec<PathBuf>,
}

/// The engines found on `PATH`, with each one's models.
fn found_now() -> Vec<(Kind, PathBuf, Vec<PathBuf>)> {
    let places = Places::from_env();
    on_path(&std::env::var_os("PATH").unwrap_or_default()).into_iter().map(|(k, b)| (k, b, models(k, &places))).collect()
}

/// The first line a program prints for `--version`, if it answers in 5 s.
async fn version(binary: &Path) -> Option<String> {
    let run = tokio::process::Command::new(binary).arg("--version").stdin(Stdio::null()).kill_on_drop(true).output();
    let out = tokio::time::timeout(Duration::from_secs(5), run).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = [out.stdout, out.stderr].concat();
    String::from_utf8_lossy(&text).lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.chars().take(80).collect())
}

fn update(app: &AppHandle, change: impl FnOnce(&mut Settings) -> Result<(), String>) -> Result<State, String> {
    let path = settings_path(app)?;
    let _held = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = read_settings(&path)?;
    change(&mut settings)?;
    write_settings(&path, &settings)?;
    Ok(state_of(settings))
}

#[tauri::command]
pub fn local_stt_state(app: AppHandle) -> Result<State, String> {
    Ok(state_of(read_settings(&settings_path(&app)?)?))
}

#[tauri::command]
pub async fn local_stt_detect() -> Result<Vec<Found>, String> {
    let found = tokio::task::spawn_blocking(found_now).await.map_err(|e| e.to_string())?;
    let versions = futures_util::future::join_all(found.iter().map(|(_, b, _)| version(b))).await;
    Ok(found.into_iter().zip(versions).map(|((kind, binary, models), version)| Found { kind, label: kind.label(), binary, version, models }).collect())
}

/// Checks a choice the webview sends against what is allowed to run: a program found on `PATH` now or the one already
/// chosen (picked in a dialog earlier), and a model found for it now or the one already chosen for that program.
pub fn allowed(choice: &Engine, current: Option<&Engine>, found: &[(Kind, PathBuf, Vec<PathBuf>)]) -> Result<Engine, String> {
    let same_program = current.filter(|c| c.binary == choice.binary);
    let kind = match found.iter().find(|(_, b, _)| *b == choice.binary) {
        Some((k, _, _)) => *k,
        None => same_program.ok_or("That program wasn't found on PATH. Pick it with Choose a program instead.")?.kind,
    };
    if let Some(model) = &choice.model {
        let detected = found.iter().any(|(k, _, ms)| *k == kind && ms.contains(model));
        let kept = same_program.is_some_and(|c| c.model.as_ref() == Some(model));
        if !detected && !kept {
            return Err("That model wasn't found for this engine. Pick it with Choose a model instead.".into());
        }
    }
    Ok(Engine { kind, binary: choice.binary.clone(), model: choice.model.clone() })
}

/// Saves where speech becomes text, and which found engine and model run it (`engine` absent: keep the current one).
#[tauri::command]
pub async fn local_stt_set(app: AppHandle, on_this_computer: bool, engine: Option<Engine>) -> Result<State, String> {
    let found = match engine {
        Some(_) => tokio::task::spawn_blocking(found_now).await.map_err(|e| e.to_string())?,
        None => vec![],
    };
    update(&app, |s| {
        if let Some(choice) = &engine {
            s.engine = Some(allowed(choice, s.engine.as_ref(), &found)?);
        }
        s.on_this_computer = on_this_computer;
        Ok(())
    })
}

async fn pick(app: &AppHandle, title: &str, folder: bool) -> Result<Option<PathBuf>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let send = move |p: Option<tauri_plugin_dialog::FilePath>| {
        let _ = tx.send(p);
    };
    if folder {
        dialog.pick_folder(send)
    } else {
        dialog.pick_file(send)
    }
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    path.into_path().map(Some).map_err(|e| e.to_string())
}

/// The owner points at an engine's program in the native Open dialog. `None`: cancelled.
#[tauri::command]
pub async fn local_stt_pick_program(app: AppHandle) -> Result<Option<State>, String> {
    let Some(binary) = pick(&app, "Choose a speech-to-text program", false).await? else { return Ok(None) };
    let kind = kind_of(&binary).ok_or("Hermes Chat can run whisper-cli, whisper-cpp, whisper, whisper-ctranslate2 or vosk-transcriber.")?;
    if !is_executable(&binary) {
        return Err(format!("{} can't be run: it isn't an executable file.", binary.display()));
    }
    update(&app, |s| {
        let model = s.engine.take().filter(|e| e.kind == kind).and_then(|e| e.model);
        s.engine = Some(Engine { kind, binary, model });
        Ok(())
    })
    .map(Some)
}

/// The owner points at a model file (or folder, for faster-whisper and Vosk) for the chosen engine. `None`: cancelled.
#[tauri::command]
pub async fn local_stt_pick_model(app: AppHandle) -> Result<Option<State>, String> {
    let path = settings_path(&app)?;
    let kind = read_settings(&path)?.engine.ok_or("Choose an engine first.")?.kind;
    let title = if kind.model_is_folder() { "Choose the model's folder" } else { "Choose a model file" };
    let Some(model) = pick(&app, title, kind.model_is_folder()).await? else { return Ok(None) };
    update(&app, |s| {
        let engine = s.engine.as_mut().filter(|e| e.kind == kind).ok_or("The engine changed meanwhile. Choose the model again.")?;
        engine.model = Some(model);
        Ok(())
    })
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hc-stt-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn file(path: &Path, text: &str, mode: u32) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn engines_are_found_on_path_by_name_first_match_wins_and_only_if_executable() {
        let d = temp("path");
        let (a, b) = (d.join("a"), d.join("b"));
        file(&a.join("whisper-cli"), "\x7fELF", 0o755);
        file(&b.join("whisper-cli"), "\x7fELF", 0o755);
        file(&a.join("whisper"), "#!/usr/bin/python3\n", 0o755);
        file(&b.join("vosk-transcriber"), "#!/bin/sh\n", 0o644); // not executable
        file(&b.join("whisper-ctranslate2"), "#!/usr/bin/python3\n", 0o755);
        file(&b.join("ls"), "", 0o755);
        let path = std::env::join_paths([&a, &b, &PathBuf::from("relative")]).unwrap();
        let got = on_path(&path);
        assert_eq!(
            got,
            vec![
                (Kind::WhisperCpp, a.join("whisper-cli")),
                (Kind::OpenaiWhisper, a.join("whisper")),
                (Kind::FasterWhisper, b.join("whisper-ctranslate2")),
            ]
        );
        // whisper.cpp's old `whisper` is a binary, not a script.
        file(&a.join("whisper"), "\x7fELF", 0o755);
        assert_eq!(kind_of(&a.join("whisper")), Some(Kind::WhisperCpp));
        assert_eq!(kind_of(Path::new("/usr/bin/sh")), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn models_are_found_in_each_engines_usual_folders() {
        let d = temp("models");
        let places = Places { home: d.join("home"), data: d.join("data"), cache: d.join("cache"), hf: d.join("hf") };
        file(&d.join("data/whisper.cpp/ggml-base.en.bin"), "", 0o644);
        file(&d.join("data/whisper.cpp/models/ggml-tiny.bin"), "", 0o644);
        file(&d.join("data/whisper.cpp/models/notes.txt"), "", 0o644);
        file(&d.join("home/whisper.cpp/models/ggml-small.bin"), "", 0o644);
        file(&d.join("cache/whisper/small.en.pt"), "", 0o644);
        file(&d.join("hf/hub/models--Systran--faster-whisper-small/snapshots/abc/model.bin"), "", 0o644);
        file(&d.join("hf/hub/models--Systran--faster-whisper-tiny/snapshots/def/config.json"), "", 0o644); // incomplete
        file(&d.join("hf/hub/models--bert/snapshots/x/model.bin"), "", 0o644);
        std::fs::create_dir_all(d.join("cache/vosk/vosk-model-small-en-us-0.15/am")).unwrap();
        std::fs::create_dir_all(d.join("cache/vosk/not-a-model")).unwrap();

        let cpp = models(Kind::WhisperCpp, &places);
        for m in [d.join("data/whisper.cpp/ggml-base.en.bin"), d.join("data/whisper.cpp/models/ggml-tiny.bin"), d.join("home/whisper.cpp/models/ggml-small.bin")] {
            assert!(cpp.contains(&m), "{m:?} in {cpp:?}");
        }
        assert!(!cpp.iter().any(|m| m.ends_with("notes.txt")));
        assert_eq!(models(Kind::OpenaiWhisper, &places), vec![d.join("cache/whisper/small.en.pt")]);
        assert_eq!(models(Kind::FasterWhisper, &places), vec![d.join("hf/hub/models--Systran--faster-whisper-small/snapshots/abc")]);
        assert_eq!(models(Kind::Vosk, &places), vec![d.join("cache/vosk/vosk-model-small-en-us-0.15")]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn each_engine_gets_a_fixed_argument_list_writing_audio_txt() {
        let (m, w, o) = (Path::new("/m/model"), Path::new("/t/audio.wav"), Path::new("/t"));
        let e = |kind| Engine { kind, binary: "/bin/x".into(), model: Some(m.into()) };
        let strs = |k| args(&e(k), m, w, o).into_iter().map(|a| a.into_string().unwrap()).collect::<Vec<_>>().join(" ");
        assert_eq!(strs(Kind::WhisperCpp), "-m /m/model -f /t/audio.wav -l auto -nt -np -otxt -of /t/audio");
        assert_eq!(strs(Kind::FasterWhisper), "/t/audio.wav --model_directory /m/model --output_dir /t --output_format txt --verbose False");
        assert_eq!(strs(Kind::OpenaiWhisper), "/t/audio.wav --model /m/model --output_dir /t --output_format txt --verbose False --fp16 False");
        assert_eq!(strs(Kind::Vosk), "-m /m/model -i /t/audio.wav -o /t/audio.txt");
        // A path with spaces and a leading dash stays one argument.
        let odd = Path::new("/m/-x y.bin");
        assert_eq!(args(&e(Kind::WhisperCpp), odd, w, o)[1], OsString::from("/m/-x y.bin"));
    }

    #[test]
    fn transcripts_lose_bracketed_notes_and_line_breaks() {
        assert_eq!(clean(" Hello there.\n\n[BLANK_AUDIO]\n How are you? \n"), "Hello there. How are you?");
        assert_eq!(clean("[BLANK_AUDIO]\n"), "");
    }

    #[test]
    fn the_choice_survives_a_restart_and_a_broken_file_is_an_error_not_the_server() {
        let d = temp("settings");
        let path = d.join(SETTINGS_FILE);
        assert_eq!(read_settings(&path).unwrap(), Settings::default(), "no file: Hermes transcribes");
        let s = Settings { on_this_computer: true, engine: Some(Engine { kind: Kind::Vosk, binary: "/usr/bin/vosk-transcriber".into(), model: Some("/m".into()) }) };
        write_settings(&path, &s).unwrap();
        assert_eq!(read_settings(&path).unwrap(), s);
        std::fs::write(&path, "{").unwrap();
        assert!(read_settings(&path).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_webview_can_choose_only_found_programs_and_models() {
        let found = vec![(Kind::WhisperCpp, PathBuf::from("/usr/bin/whisper-cli"), vec![PathBuf::from("/m/ggml-base.bin")])];
        let choice = |b: &str, m: Option<&str>| Engine { kind: Kind::Vosk, binary: b.into(), model: m.map(PathBuf::from) };
        // The kind comes from what was found, not from the webview.
        assert_eq!(allowed(&choice("/usr/bin/whisper-cli", Some("/m/ggml-base.bin")), None, &found).unwrap().kind, Kind::WhisperCpp);
        assert!(allowed(&choice("/bin/rm", None), None, &found).is_err());
        assert!(allowed(&choice("/usr/bin/whisper-cli", Some("/etc/passwd")), None, &found).is_err());
        // A program and model picked in a dialog earlier stay allowed.
        let picked = Engine { kind: Kind::WhisperCpp, binary: "/opt/w/whisper-cli".into(), model: Some("/opt/m.bin".into()) };
        assert_eq!(allowed(&choice("/opt/w/whisper-cli", Some("/opt/m.bin")), Some(&picked), &found).unwrap(), picked);
        assert!(allowed(&choice("/opt/w/whisper-cli", Some("/etc/passwd")), Some(&picked), &found).is_err());
    }

    /// Each in its own folder: rewriting a program just run can fail with "text file busy".
    fn fake_engine(dir: &Path, name: &str, script: &str) -> Engine {
        let binary = dir.join(name).join("whisper-cli");
        file(&binary, &format!("#!/bin/sh\n{script}\n"), 0o755);
        file(&dir.join("ggml-tiny.bin"), "", 0o644);
        Engine { kind: Kind::WhisperCpp, binary, model: Some(dir.join("ggml-tiny.bin")) }
    }

    /// The private folders left behind in the temp dir by this process.
    fn leftovers() -> usize {
        let prefix = format!("hermes-chat-stt-{}-", std::process::id());
        children(&std::env::temp_dir()).iter().filter(|p| name_of(p).starts_with(&prefix)).count()
    }

    #[tokio::test]
    async fn a_run_reads_the_transcript_and_deletes_the_recording_whatever_happens() {
        let d = temp("run");
        // Writes what it was given, as whisper-cli does with `-of <out>`; records the folder's mode.
        let ok = fake_engine(&d, "ok", r#"while [ "$1" != "-of" ]; do shift; done; stat -c %a "$(dirname "$2")" > "$2.txt"; echo "[BLANK_AUDIO]" >> "$2.txt""#);
        let got = transcribe(&ok, b"RIFF....", Duration::from_secs(10)).await.unwrap();
        assert_eq!(got.text, "700", "the recording's folder is private");
        assert_eq!(got.provider.as_deref(), Some("whisper.cpp"));

        let fails = fake_engine(&d, "fails", "echo 'error: failed to load model' >&2; exit 3");
        assert_eq!(transcribe(&fails, b"RIFF", Duration::from_secs(10)).await.unwrap_err(), "whisper.cpp exited with 3: error: failed to load model");

        let hangs = fake_engine(&d, "hangs", "exec sleep 30");
        let err = transcribe(&hangs, b"RIFF", Duration::from_millis(300)).await.unwrap_err();
        assert!(err.contains("took longer than"), "{err}");

        let mut gone = ok.clone();
        gone.model = Some(d.join("missing.bin"));
        assert!(transcribe(&gone, b"RIFF", Duration::from_secs(10)).await.unwrap_err().contains("isn't there any more"));
        assert_eq!(leftovers(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_failure_printed_only_on_stdout_is_still_said() {
        let d = temp("stdout");
        let e = fake_engine(&d, "stdout", "echo 'RuntimeError: Unable to open file model.bin'; exit 1");
        assert_eq!(transcribe(&e, b"RIFF", Duration::from_secs(10)).await.unwrap_err(), "whisper.cpp exited with 1: RuntimeError: Unable to open file model.bin");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The routing `hermes_transcribe` follows: `None` sends to Hermes; `Some` returns before Hermes is reached.
    #[tokio::test]
    async fn with_this_computer_chosen_a_recording_never_goes_to_hermes() {
        let d = temp("route");
        let path = d.join(SETTINGS_FILE);
        let route = |p: PathBuf| async move { transcribe_if_local_at(&p, "audio/wav", b"RIFF").await };
        assert!(route(path.clone()).await.is_none(), "no file: Hermes, as before");
        write_settings(&path, &Settings { on_this_computer: false, engine: Some(fake_engine(&d, "unused", "exit 0")) }).unwrap();
        assert!(route(path.clone()).await.is_none(), "Hermes server chosen");

        write_settings(&path, &Settings { on_this_computer: true, engine: None }).unwrap();
        assert_eq!(route(path.clone()).await.unwrap().unwrap_err(), "No speech-to-text engine is chosen on this computer.");
        let failing = fake_engine(&d, "failing", "echo boom >&2; exit 2");
        write_settings(&path, &Settings { on_this_computer: true, engine: Some(failing) }).unwrap();
        assert_eq!(route(path.clone()).await.unwrap().unwrap_err(), "whisper.cpp exited with 2: boom");
        let mut missing = fake_engine(&d, "missing", "exit 0");
        missing.binary = d.join("nowhere/whisper-cli");
        write_settings(&path, &Settings { on_this_computer: true, engine: Some(missing) }).unwrap();
        assert!(route(path.clone()).await.unwrap().is_err());
        let ok = fake_engine(&d, "fine", r#"while [ "$1" != "-of" ]; do shift; done; echo "hello" > "$2.txt""#);
        write_settings(&path, &Settings { on_this_computer: true, engine: Some(ok) }).unwrap();
        assert_eq!(route(path.clone()).await.unwrap().unwrap().text, "hello");
        assert!(transcribe_if_local_at(&path, "audio/webm", b"x").await.unwrap().is_err(), "only WAV, and still not to Hermes");

        std::fs::write(&path, "not json").unwrap();
        assert!(route(path.clone()).await.unwrap().is_err(), "an unreadable choice isn't taken as Hermes server");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Against a real whisper.cpp: `HERMES_STT_WHISPER_CLI=…/whisper-cli HERMES_STT_MODEL=…/ggml-tiny.en.bin
    /// HERMES_STT_WAV=…/samples/jfk.wav cargo test -- --ignored real_whisper_cpp`.
    #[tokio::test]
    #[ignore]
    async fn real_whisper_cpp() {
        let var = |n: &str| PathBuf::from(std::env::var_os(n).unwrap_or_else(|| panic!("{n} not set")));
        let engine = Engine { kind: Kind::WhisperCpp, binary: var("HERMES_STT_WHISPER_CLI"), model: Some(var("HERMES_STT_MODEL")) };
        let wav = std::fs::read(var("HERMES_STT_WAV")).unwrap();
        let started = std::time::Instant::now();
        let got = transcribe(&engine, &wav, time_limit(wav.len())).await.unwrap();
        println!("{:?} in {:?}: {}", version(&engine.binary).await, started.elapsed(), got.text);
        assert!(got.text.to_lowercase().contains("ask not what your country can do for you"), "{}", got.text);
        assert_eq!(leftovers(), 0);
    }
}
