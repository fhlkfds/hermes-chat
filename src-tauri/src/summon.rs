//! The global shortcut that brings Hermes Chat forward from any app (ADR 0033).
//!
//! On X11 the app grabs the key itself (x11_grab.rs), and the X server says when another app already has it. Wayland doesn't let an app grab keys, so there the app asks the desktop portal (portal.rs); with no portal
//! that offers it (Sway, older desktops) nothing is registered, and Settings says how to bind a key in the desktop to
//! `hermes-chat --show` or `--toggle` instead (remote.rs). The app never claims a key works that nothing registered.
//!
//! The setting is the last shortcut that registered, and whether a press while the app is in front hides it. It is
//! kept for this computer in the app's config directory, never per server or profile, and holds only the key, never a
//! command. A change registers the new key first and releases the old one only once that worked, so a conflict or a
//! refusal leaves the working key in place and is offered again with Retry.

use crate::portal::{self, Portal};
use crate::x11_grab::{self, Grabber};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// What the portal and Hyprland call the shortcut.
pub const SHORTCUT_ID: &str = "hermes-chat";
const DESCRIPTION: &str = "Show Hermes Chat";
pub const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+H";
/// Tells the webview the status changed (a registration finished, or the desktop changed the key).
pub const STATUS_EVENT: &str = "summon-status";
/// Tells the webview the window was brought forward, so it puts the cursor back in the composer.
pub const SUMMONED_EVENT: &str = "summoned";
const FILE: &str = "global-shortcut.json";

/// A shortcut as Settings writes it: `Ctrl+Alt+H`, modifiers in the order Ctrl, Alt, Shift, Super.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    ctrl: bool,
    alt: bool,
    shift: bool,
    sup: bool,
    key: String,
}

impl Combo {
    /// A shortcut the app can use from anywhere: it needs Ctrl, Alt or Super, so it can't take a key other apps type.
    pub fn parse(s: &str) -> Result<Combo, String> {
        let mut parts: Vec<&str> = s.split('+').collect();
        let key = parts.pop().unwrap_or_default().to_owned();
        let order = ["Ctrl", "Alt", "Shift", "Super"];
        let mut at = 0;
        for p in &parts {
            match order[at..].iter().position(|m| m == p) {
                Some(i) => at += i + 1,
                None => return Err(format!("{s} isn't a shortcut")),
            }
        }
        let has = |m: &str| parts.contains(&m);
        let combo = Combo { ctrl: has("Ctrl"), alt: has("Alt"), shift: has("Shift"), sup: has("Super"), key };
        x11_grab::keysym(&combo.key).ok_or_else(|| format!("{s} isn't a shortcut"))?;
        if !(combo.ctrl || combo.alt || combo.sup) {
            return Err("A shortcut that works from any app needs Ctrl, Alt or Super.".into());
        }
        Ok(combo)
    }

    fn x11_key(&self) -> x11_grab::Key {
        let keysym = x11_grab::keysym(&self.key).expect("checked in parse");
        x11_grab::Key { keysym, ctrl: self.ctrl, alt: self.alt, shift: self.shift, sup: self.sup }
    }

    /// The portal's `preferred_trigger`: XDG shortcut spec modifiers and an xkb key name, `CTRL+ALT+h`.
    pub fn trigger(&self) -> String {
        let key = match self.key.as_str() {
            "PrintScreen" => "Print".to_owned(),
            "ScrollLock" => "Scroll_Lock".to_owned(),
            k if k.len() == 1 => k.to_ascii_lowercase(),
            k => k.to_owned(),
        };
        let mods = [(self.ctrl, "CTRL"), (self.alt, "ALT"), (self.shift, "SHIFT"), (self.sup, "LOGO")];
        mods.iter().filter(|(on, _)| *on).map(|(_, m)| *m).chain([key.as_str()]).collect::<Vec<_>>().join("+")
    }
}

/// What the owner chose, as kept on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub shortcut: Option<String>,
    #[serde(default)]
    pub hide_when_active: bool,
}

impl Default for Setting {
    /// Off until the owner turns it on: a key grabbed from every app shouldn't appear on its own.
    fn default() -> Self {
        Setting { shortcut: None, hide_when_active: false }
    }
}

/// How this desktop registers a global shortcut.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Backend {
    X11,
    Portal,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// No shortcut set.
    Off,
    /// Registering now; the desktop may be asking the owner.
    Pending,
    /// The saved shortcut is registered.
    Working,
    /// The saved shortcut isn't registered (another app took it, or the desktop refused).
    Failed,
    /// Nothing can be registered on this desktop; a desktop binding is the way.
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    /// Another app already has the key.
    Conflict,
    /// The owner said no in the desktop's dialog.
    Denied,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    /// The shortcut that didn't register; Retry tries it again.
    pub shortcut: String,
    pub kind: FailureKind,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub backend: Backend,
    pub wayland: bool,
    /// `hyprland`, `sway`, `gnome`, `kde` or `other`, for the desktop-binding instructions.
    pub desktop: &'static str,
    /// Why nothing can be registered here, when the backend is `none`.
    pub unavailable: Option<String>,
    pub shortcut: Option<String>,
    pub hide_when_active: bool,
    pub state: State,
    /// The key the desktop says it set, through the portal; none when it doesn't say.
    pub trigger: Option<String>,
    /// What Hyprland calls the registered shortcut, for a `global` bind.
    pub hyprland_name: Option<String>,
    pub failure: Option<Failure>,
    /// Settings is recording a new shortcut, and the grab is let go meanwhile.
    pub paused: bool,
}

enum Registered {
    X11(x11_grab::Key),
    Portal(portal::Bound),
}

/// A registration that just succeeded, not yet the app's. `epoch`: the portal's loss count when binding began.
struct Fresh {
    r: Registered,
    epoch: u64,
}

/// A registration that ended without the app asking.
pub(crate) enum Loss {
    /// The desktop closed this portal session.
    Session(String),
    /// The portal restarted or its connection closed: every session is gone.
    Portal,
    /// A layout change lost this X11 key.
    Key(x11_grab::Key),
}

/// Losses of registrations that weren't the app's yet when they came: a bind can succeed and its session end before
/// the app takes it, and that registration must not then count as working.
#[derive(Default)]
struct Losses {
    sessions: Vec<String>,
    keys: Vec<x11_grab::Key>,
    portal_epoch: u64,
}

enum Engine {
    X11(Grabber),
    Portal(Portal),
    None(String),
}

struct Inner {
    setting: Setting,
    registered: Option<Registered>,
    pending: bool,
    failure: Option<Failure>,
    paused: bool,
    hyprland_name: Option<String>,
    losses: Losses,
}

pub struct Summon {
    engine: Engine,
    file: Option<PathBuf>,
    inner: Mutex<Inner>,
    /// One change at a time; registering can wait on the owner.
    ops: Mutex<()>,
    /// When the window last lost focus (lib.rs reports it), for a press of the X11 grab (`on_x11_press`).
    blurred_at: Mutex<Option<std::time::Instant>>,
}

/// An X11 key grab taking effect sends the focused window a FocusOut, so at the moment of the press the window can
/// already look unfocused. A window that lost focus this recently counts as having been in front.
const GRAB_FOCUS_GRACE: std::time::Duration = std::time::Duration::from_millis(400);

pub fn wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t == "wayland")
}

/// X11 grabs only on an X11 session: under XWayland a grab sees keys only while an X window is focused, so it would
/// look registered and never fire from a Wayland app.
pub fn x11() -> bool {
    !wayland() && std::env::var_os("DISPLAY").is_some()
}

fn desktop() -> &'static str {
    let current = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_ascii_lowercase();
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() || current.contains("hyprland") {
        "hyprland"
    } else if std::env::var_os("SWAYSOCK").is_some() || current.contains("sway") {
        "sway"
    } else if current.contains("gnome") {
        "gnome"
    } else if current.contains("kde") {
        "kde"
    } else {
        "other"
    }
}

fn read_setting(file: &Option<PathBuf>) -> Setting {
    let Some(path) = file else { return Setting::default() };
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Setting>(&text) {
            Ok(s) if s.shortcut.as_deref().is_none_or(|k| Combo::parse(k).is_ok()) => s,
            _ => {
                eprintln!("hermes-chat: {} isn't a global shortcut setting; the shortcut is off", path.display());
                Setting::default()
            }
        },
        Err(_) => Setting::default(),
    }
}

fn write_setting(file: &Option<PathBuf>, s: &Setting) -> Result<(), String> {
    let Some(path) = file else { return Err("there's no config directory to keep the setting in".into()) };
    let write = || -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(s).unwrap_or_default())?;
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| format!("couldn't save the setting in {}: {e}", path.display()))
}

impl Summon {
    /// Picks how to register on this desktop and reads the setting. Registering waits for `start`.
    pub fn new<R: Runtime>(app: &AppHandle<R>) -> Summon {
        let file = app.path().app_config_dir().ok().map(|d| d.join(FILE));
        let setting = read_setting(&file);
        let engine = if x11() {
            let handle = app.clone();
            match Grabber::start(move |e| match e {
                x11_grab::GrabEvent::Pressed(_) => on_x11_press(&handle),
                x11_grab::GrabEvent::Lost(key, why) => {
                    if let Some(summon) = handle.try_state::<Summon>() {
                        if summon.lost(Loss::Key(key), format!("The shortcut stopped working: {why}.")) {
                            let _ = handle.emit(STATUS_EVENT, summon.status());
                        }
                    }
                }
            }) {
                Ok(g) => Engine::X11(g),
                Err(e) => Engine::None(e),
            }
        } else if wayland() {
            let handle = app.clone();
            match Portal::start(None, move |e| portal_event(&handle, e)) {
                Ok(p) => Engine::Portal(p),
                Err(e) => Engine::None(e),
            }
        } else {
            Engine::None("there's no X11 or Wayland display".into())
        };
        let inner = Inner { setting, registered: None, pending: false, failure: None, paused: false, hyprland_name: None, losses: Losses::default() };
        Summon { engine, file, inner: Mutex::new(inner), ops: Mutex::new(()), blurred_at: Mutex::new(None) }
    }

    pub fn status(&self) -> Status {
        let i = self.inner.lock().unwrap();
        let (backend, unavailable) = match &self.engine {
            Engine::X11(_) => (Backend::X11, None),
            Engine::Portal(_) => (Backend::Portal, None),
            Engine::None(why) => (Backend::None, Some(why.clone())),
        };
        let state = if backend == Backend::None {
            State::Unavailable
        } else if i.pending {
            State::Pending
        } else if i.setting.shortcut.is_none() {
            State::Off
        } else if i.registered.is_some() || i.paused {
            State::Working
        } else {
            State::Failed
        };
        let trigger = match &i.registered {
            Some(Registered::Portal(b)) => b.trigger.clone(),
            _ => None,
        };
        Status {
            backend,
            wayland: wayland(),
            desktop: desktop(),
            unavailable,
            shortcut: i.setting.shortcut.clone(),
            hide_when_active: i.setting.hide_when_active,
            state,
            trigger,
            hyprland_name: i.hyprland_name.clone(),
            failure: i.failure.clone(),
            paused: i.paused,
        }
    }

    fn register(&self, combo: &Combo) -> Result<Fresh, Failure> {
        let epoch = self.inner.lock().unwrap().losses.portal_epoch;
        self.register_now(combo).map(|r| Fresh { r, epoch })
    }

    /// Takes a registration that just succeeded, unless it ended meanwhile; then it is handed back, to release, with
    /// the failure to show.
    fn accept(i: &mut Inner, fresh: Fresh, shortcut: &str) -> Result<Registered, (Registered, Failure)> {
        let ended = match &fresh.r {
            Registered::Portal(b) => fresh.epoch != i.losses.portal_epoch || i.losses.sessions.contains(&b.session),
            Registered::X11(k) => i.losses.keys.contains(k),
        };
        // One change at a time (`ops`), so what was recorded can only have been about this registration or older ones.
        i.losses.sessions.clear();
        i.losses.keys.clear();
        if ended {
            let message = "The shortcut's registration ended as soon as it was made.".to_owned();
            return Err((fresh.r, Failure { shortcut: shortcut.to_owned(), kind: FailureKind::Failed, message }));
        }
        Ok(fresh.r)
    }

    fn register_now(&self, combo: &Combo) -> Result<Registered, Failure> {
        let fail = |kind, message: String| Failure { shortcut: label(combo), kind, message };
        match &self.engine {
            Engine::X11(g) => {
                let key = combo.x11_key();
                match g.grab(key) {
                    Ok(()) => Ok(Registered::X11(key)),
                    Err(x11_grab::GrabError::Taken) => {
                        Err(fail(FailureKind::Conflict, format!("{} is already used by another app.", label(combo))))
                    }
                    Err(x11_grab::GrabError::NoKey) => {
                        Err(fail(FailureKind::Failed, format!("This keyboard has no key for {}.", label(combo))))
                    }
                    Err(x11_grab::GrabError::Failed(e)) => Err(fail(FailureKind::Failed, format!("{} couldn't be registered: {e}.", label(combo)))),
                }
            }
            Engine::Portal(p) => match p.bind(SHORTCUT_ID, DESCRIPTION, &combo.trigger()) {
                Ok(bound) => Ok(Registered::Portal(bound)),
                Err(portal::BindError::Denied) => {
                    Err(fail(FailureKind::Denied, "Your desktop didn't allow the shortcut. It may have asked you to confirm it.".into()))
                }
                Err(portal::BindError::Failed(e)) => Err(fail(FailureKind::Failed, format!("Your desktop couldn't set the shortcut: {e}."))),
            },
            Engine::None(why) => Err(fail(FailureKind::Failed, why.clone())),
        }
    }

    fn release(&self, r: Registered) {
        match (r, &self.engine) {
            (Registered::X11(key), Engine::X11(g)) => g.ungrab(key),
            (Registered::Portal(b), Engine::Portal(p)) => p.close(&b.session),
            _ => {}
        }
    }

    fn set_pending<R: Runtime>(&self, app: &AppHandle<R>, pending: bool) {
        self.inner.lock().unwrap().pending = pending;
        let _ = app.emit(STATUS_EVENT, self.status());
    }

    /// Registers the saved shortcut, at startup. A failure is shown in Settings, with Retry.
    pub fn start<R: Runtime>(&self, app: &AppHandle<R>) {
        let _op = self.ops.lock().unwrap();
        let Some(saved) = self.inner.lock().unwrap().setting.shortcut.clone() else { return };
        if matches!(self.engine, Engine::None(_)) {
            return;
        }
        let Ok(combo) = Combo::parse(&saved) else { return };
        self.set_pending(app, true);
        let result = self.register(&combo);
        let mut i = self.inner.lock().unwrap();
        i.pending = false;
        let mut dead = None;
        match result.and_then(|fresh| Self::accept(&mut i, fresh, &saved).map_err(|(r, f)| (dead = Some(r), f).1)) {
            Ok(r) => {
                i.registered = Some(r);
                i.failure = None;
            }
            Err(f) => {
                eprintln!("hermes-chat: the global shortcut {saved} isn't registered: {}", f.message);
                i.failure = Some(f);
            }
        }
        drop(i);
        // Released outside the lock: the portal's and the grab's threads take it to report losses.
        if let Some(r) = dead {
            self.release(r);
        }
        self.after_change(app);
    }

    /// Changes the shortcut, or turns it off with `None`. A new one is saved only once it registered, and the old one
    /// is released only then; a failure leaves the old one working and is kept for Retry.
    pub fn set<R: Runtime>(&self, app: &AppHandle<R>, shortcut: Option<String>) -> Result<Status, String> {
        let combo = shortcut.as_deref().map(Combo::parse).transpose()?;
        let _op = self.ops.lock().unwrap();
        let (current, working) = {
            let i = self.inner.lock().unwrap();
            (i.setting.shortcut.clone(), i.registered.is_some())
        };
        let Some(combo) = combo else {
            let old = {
                let mut i = self.inner.lock().unwrap();
                let mut next = i.setting.clone();
                next.shortcut = None;
                write_setting(&self.file, &next)?;
                i.setting = next;
                i.failure = None;
                i.paused = false;
                i.hyprland_name = None;
                i.registered.take()
            };
            if let Some(r) = old {
                self.release(r);
            }
            return Ok(self.after_change(app));
        };
        let wanted = label(&combo);
        if keeps_registration(self.backend(), current.as_deref() == Some(wanted.as_str()), working) {
            self.inner.lock().unwrap().failure = None;
            return Ok(self.after_change(app));
        }
        if let Engine::None(_) = self.engine {
            // Nothing to register; the key is kept for the desktop-binding instructions.
            let mut i = self.inner.lock().unwrap();
            let mut next = i.setting.clone();
            next.shortcut = Some(wanted);
            write_setting(&self.file, &next)?;
            i.setting = next;
            drop(i);
            return Ok(self.after_change(app));
        }
        // A paused grab is let go already; registering the same key again is fine.
        self.set_pending(app, true);
        let result = self.register(&combo);
        let mut i = self.inner.lock().unwrap();
        i.pending = false;
        let mut dead = None;
        match result.and_then(|fresh| Self::accept(&mut i, fresh, &wanted).map_err(|(r, f)| (dead = Some(r), f).1)) {
            Ok(r) => {
                let mut next = i.setting.clone();
                next.shortcut = Some(wanted);
                if let Err(e) = write_setting(&self.file, &next) {
                    drop(i);
                    self.release(r);
                    self.after_change(app);
                    return Err(e);
                }
                i.setting = next;
                i.failure = None;
                i.paused = false;
                i.hyprland_name = None;
                let old = i.registered.replace(r);
                drop(i);
                if let Some(old) = old {
                    self.release(old);
                }
            }
            Err(f) => {
                i.failure = Some(f);
                drop(i);
                if let Some(r) = dead {
                    self.release(r);
                }
            }
        }
        Ok(self.after_change(app))
    }

    /// Tries the shortcut that failed again.
    pub fn retry<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Status, String> {
        let failed = self.inner.lock().unwrap().failure.as_ref().map(|f| f.shortcut.clone());
        match failed {
            Some(s) => {
                // The saved one failing at startup isn't "the same and working", so `set` registers it again.
                self.set(app, Some(s))
            }
            None => Ok(self.status()),
        }
    }

    pub fn set_hide<R: Runtime>(&self, app: &AppHandle<R>, hide: bool) -> Result<Status, String> {
        let mut i = self.inner.lock().unwrap();
        let mut next = i.setting.clone();
        next.hide_when_active = hide;
        write_setting(&self.file, &next)?;
        i.setting = next;
        drop(i);
        Ok(self.after_change(app))
    }

    /// While Settings records a shortcut on X11, the grab is let go, so pressing the current key reaches the recorder
    /// instead of hiding the window. The portal's key belongs to the desktop, which can't be paused.
    pub fn pause<R: Runtime>(&self, app: &AppHandle<R>, paused: bool) -> Status {
        let _op = self.ops.lock().unwrap();
        if !matches!(self.engine, Engine::X11(_)) {
            return self.status();
        }
        let mut i = self.inner.lock().unwrap();
        if paused == i.paused {
            drop(i);
            return self.status();
        }
        if paused {
            let Some(r) = i.registered.take() else {
                drop(i);
                return self.status();
            };
            i.paused = true;
            drop(i);
            self.release(r);
        } else {
            i.paused = false;
            let saved = i.setting.shortcut.clone();
            drop(i);
            if let Some(combo) = saved.as_deref().and_then(|s| Combo::parse(s).ok()) {
                let result = self.register(&combo);
                let mut i = self.inner.lock().unwrap();
                let mut dead = None;
                match result.and_then(|fresh| Self::accept(&mut i, fresh, &label(&combo)).map_err(|(r, f)| (dead = Some(r), f).1)) {
                    Ok(r) => i.registered = Some(r),
                    Err(f) => i.failure = Some(f),
                }
                drop(i);
                if let Some(r) = dead {
                    self.release(r);
                }
            }
        }
        self.after_change(app)
    }

    /// Releases the shortcut as the app exits.
    pub fn shutdown(&self) {
        let r = self.inner.lock().unwrap().registered.take();
        if let Some(r) = r {
            self.release(r);
        }
    }

    fn after_change<R: Runtime>(&self, app: &AppHandle<R>) -> Status {
        // Hyprland's portal never sets a key: it lists the shortcut for a `global` bind under a name it makes up.
        let portal_bound = matches!(self.inner.lock().unwrap().registered, Some(Registered::Portal(_)));
        if portal_bound && desktop() == "hyprland" {
            let name = hyprland_name();
            self.inner.lock().unwrap().hyprland_name = name;
        }
        let status = self.status();
        let _ = app.emit(STATUS_EVENT, status.clone());
        status
    }

    /// The window gained or lost focus.
    pub fn focus_changed(&self, focused: bool) {
        *self.blurred_at.lock().unwrap() = (!focused).then(std::time::Instant::now);
    }

    fn just_blurred(&self) -> bool {
        self.blurred_at.lock().unwrap().is_some_and(|at| at.elapsed() < GRAB_FOCUS_GRACE)
    }

    fn hide_when_active(&self) -> bool {
        self.inner.lock().unwrap().setting.hide_when_active
    }

    fn backend(&self) -> Backend {
        match self.engine {
            Engine::X11(_) => Backend::X11,
            Engine::Portal(_) => Backend::Portal,
            Engine::None(_) => Backend::None,
        }
    }

    /// The registration `matches` ended without the app asking (the desktop closed it, the portal restarted, a layout
    /// change lost the key): it no longer counts as working, and Retry registers the saved shortcut again. Whether one
    /// did.
    fn lost(&self, loss: Loss, why: String) -> bool {
        let mut i = self.inner.lock().unwrap();
        let matches = |r: &Registered| match (&loss, r) {
            (Loss::Session(s), Registered::Portal(b)) => *s == b.session,
            (Loss::Portal, Registered::Portal(_)) => true,
            (Loss::Key(k), Registered::X11(r)) => k == r,
            _ => false,
        };
        let current = i.registered.as_ref().is_some_and(matches);
        // Kept for a registration being made now, which `accept` then refuses.
        match loss {
            Loss::Portal => i.losses.portal_epoch += 1,
            Loss::Session(s) if !current => i.losses.sessions.push(s),
            Loss::Key(k) if !current => i.losses.keys.push(k),
            _ => {}
        }
        if !current {
            return false;
        }
        i.registered = None;
        i.hyprland_name = None;
        if let Some(saved) = i.setting.shortcut.clone() {
            i.failure = Some(Failure { shortcut: saved, kind: FailureKind::Failed, message: why });
        }
        true
    }

    fn is_current_session(&self, session: &str) -> bool {
        matches!(&self.inner.lock().unwrap().registered, Some(Registered::Portal(b)) if b.session == session)
    }
}

/// How a shortcut is written in the setting.
fn label(c: &Combo) -> String {
    let mods = [(c.ctrl, "Ctrl"), (c.alt, "Alt"), (c.shift, "Shift"), (c.sup, "Super")];
    mods.iter().filter(|(on, _)| *on).map(|(_, m)| *m).chain([c.key.as_str()]).collect::<Vec<_>>().join("+")
}

/// What Hyprland lists the shortcut as (`<app id>:hermes-chat`), from `hyprctl globalshortcuts`.
fn hyprland_name() -> Option<String> {
    let out = std::process::Command::new("hyprctl").args(["-j", "globalshortcuts"]).output().ok()?;
    hyprland_name_in(&String::from_utf8_lossy(&out.stdout))
}

fn hyprland_name_in(json: &str) -> Option<String> {
    let list: Vec<serde_json::Value> = serde_json::from_str(json).ok()?;
    list.iter()
        .filter(|s| s["description"].as_str() == Some(DESCRIPTION))
        .filter_map(|s| s["name"].as_str())
        .find(|n| n.rsplit_once(':').is_some_and(|(_, id)| id == SHORTCUT_ID))
        .map(str::to_owned)
}

fn portal_event<R: Runtime>(app: &AppHandle<R>, e: portal::Event) {
    let Some(summon) = app.try_state::<Summon>() else { return };
    match e {
        portal::Event::Activated { session, id, token } => {
            if id == SHORTCUT_ID && summon.is_current_session(&session) {
                activate(app, summon.hide_when_active(), token, false);
            }
        }
        portal::Event::Closed { session, why } => {
            let loss = session.map_or(Loss::Portal, Loss::Session);
            if summon.lost(loss, why) {
                let _ = app.emit(STATUS_EVENT, summon.status());
            }
        }
        portal::Event::Changed { session, triggers } => {
            let mut i = summon.inner.lock().unwrap();
            if let Some(Registered::Portal(b)) = &mut i.registered {
                if b.session == session {
                    if let Some((_, t)) = triggers.into_iter().find(|(id, _)| id == SHORTCUT_ID) {
                        b.trigger = t;
                    }
                }
            }
            drop(i);
            let _ = app.emit(STATUS_EVENT, summon.status());
        }
    }
}

/// A press of the X11 grab.
fn on_x11_press<R: Runtime>(app: &AppHandle<R>) {
    if let Some(summon) = app.try_state::<Summon>() {
        let was_focused = summon.just_blurred();
        activate(app, summon.hide_when_active(), None, was_focused);
    }
}

/// Brings the one window forward, or hides it when it is already in front and `hide_if_active`. `token`: a Wayland
/// activation token from the desktop, so the compositor lets the window take focus. `was_focused`: the window had
/// focus just before the press, whatever it says now (the X11 grab's own FocusOut).
pub fn activate<R: Runtime>(app: &AppHandle<R>, hide_if_active: bool, token: Option<String>, was_focused: bool) {
    let Some(window) = app.get_webview_window("main") else { return };
    let app = app.clone();
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        let focused = was_focused || w.is_focused().unwrap_or(false);
        let in_front = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && focused;
        if in_front && hide_if_active {
            let _ = w.hide();
            return;
        }
        let _ = w.unminimize();
        let _ = w.show();
        match (token, w.gtk_window()) {
            (Some(token), Ok(gtk)) => {
                use gtk::prelude::GtkWindowExt;
                gtk.set_startup_id(&token);
                gtk.present();
            }
            _ => {
                let _ = w.set_focus();
            }
        }
        let _ = app.emit(SUMMONED_EVENT, ());
        if !in_front && wayland() {
            std::thread::spawn(nudge_compositor);
        }
    });
}

/// Hyprland and Sway keep focus where it is when an app asks for it without a token; their own IPC moves it, to the
/// workspace the window is on.
fn nudge_compositor() {
    let pid = std::process::id();
    let (cmd, args): (&str, Vec<String>) = match desktop() {
        "hyprland" => ("hyprctl", vec!["dispatch".into(), "focuswindow".into(), format!("pid:{pid}")]),
        "sway" => ("swaymsg", vec![format!("[pid={pid}] focus")]),
        _ => return,
    };
    std::thread::sleep(std::time::Duration::from_millis(80));
    if let Err(e) = std::process::Command::new(cmd).args(&args).output() {
        eprintln!("hermes-chat: couldn't ask {cmd} to focus the window: {e}");
    }
}

#[tauri::command]
pub fn summon_status(summon: tauri::State<'_, Summon>) -> Status {
    summon.status()
}

// Async, on a blocking thread: registering may wait on the desktop, and the X11 grab runs on the main thread.
#[tauri::command]
pub async fn summon_set(app: AppHandle, shortcut: Option<String>) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Summon>().set(&app, shortcut)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn summon_retry(app: AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Summon>().retry(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn summon_set_hide(app: AppHandle, hide: bool) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Summon>().set_hide(&app, hide)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn summon_pause(app: AppHandle, paused: bool) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Summon>().pause(&app, paused)).await.map_err(|e| e.to_string())
}

/// Whether choosing the shortcut already saved leaves things as they are. On X11 a working grab is the key itself. The
/// portal binds again: the desktop may have set another key than the one asked for, and choosing it again (or Reset)
/// asks once more.
fn keeps_registration(backend: Backend, same: bool, working: bool) -> bool {
    same && match backend {
        Backend::X11 => working,
        Backend::Portal => false,
        Backend::None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choosing_the_saved_shortcut_again_asks_the_portal_again() {
        assert!(keeps_registration(Backend::X11, true, true));
        assert!(!keeps_registration(Backend::X11, true, false), "a saved key that failed registers again");
        assert!(!keeps_registration(Backend::Portal, true, true), "the desktop may have set another key");
        assert!(keeps_registration(Backend::None, true, false));
        assert!(!keeps_registration(Backend::X11, false, true));
    }

    fn summon_with(engine: Engine, registered: Registered) -> Summon {
        let inner = Inner {
            setting: Setting { shortcut: Some("Ctrl+Alt+H".into()), hide_when_active: false },
            registered: Some(registered),
            pending: false,
            failure: None,
            paused: false,
            hyprland_name: None,
            losses: Losses::default(),
        };
        Summon { engine, file: None, inner: Mutex::new(inner), ops: Mutex::new(()), blurred_at: Mutex::new(None) }
    }

    #[test]
    fn a_portal_session_the_desktop_ended_stops_counting_as_working_and_offers_retry() {
        let fake = portal::fake_portal::FakePortal::start(portal::fake_portal::Behavior::Grant);
        let p = Portal::start(Some(fake.address.clone()), |_| {}).unwrap();
        let bound = p.bind(SHORTCUT_ID, DESCRIPTION, "CTRL+ALT+h").unwrap();
        let summon = summon_with(Engine::Portal(p), Registered::Portal(bound.clone()));
        assert_eq!(summon.status().state, State::Working);
        // Another session's end changes nothing.
        assert!(!summon.lost(Loss::Session("/other".into()), "gone".into()));
        assert_eq!(summon.status().state, State::Working);
        assert!(summon.lost(Loss::Session(bound.session.clone()), "Your desktop ended the shortcut's registration.".into()));
        let status = summon.status();
        assert_eq!(status.state, State::Failed);
        assert_eq!(status.trigger, None);
        let failure = status.failure.unwrap();
        assert_eq!(failure.shortcut, "Ctrl+Alt+H", "Retry registers the saved shortcut");
        assert_eq!(failure.kind, FailureKind::Failed);
    }

    /// Registers the way `start` and `set` do, with `between` run after the bind succeeded and before the app takes
    /// it: whether the registration was taken.
    fn register_with_loss_between(summon: &Summon, between: impl FnOnce(&Registered)) -> bool {
        let combo = Combo::parse("Ctrl+Alt+H").unwrap();
        let fresh = summon.register(&combo).unwrap();
        between(&fresh.r);
        let mut i = summon.inner.lock().unwrap();
        match Summon::accept(&mut i, fresh, "Ctrl+Alt+H") {
            Ok(r) => {
                i.registered = Some(r);
                true
            }
            Err((r, f)) => {
                i.failure = Some(f);
                drop(i);
                summon.release(r);
                false
            }
        }
    }

    #[test]
    fn a_session_that_ends_between_its_bind_and_its_use_is_not_taken_as_working() {
        let fake = portal::fake_portal::FakePortal::start(portal::fake_portal::Behavior::Grant);
        let p = Portal::start(Some(fake.address.clone()), |_| {}).unwrap();
        let summon = summon_with(Engine::Portal(p), Registered::X11(Combo::parse("Ctrl+Alt+J").unwrap().x11_key()));
        summon.inner.lock().unwrap().registered = None;
        // The desktop closes the new session as the bind answers.
        let taken = register_with_loss_between(&summon, |r| {
            let Registered::Portal(b) = r else { panic!("a portal registration") };
            assert!(!summon.lost(Loss::Session(b.session.clone()), "ended".into()), "not the app's yet");
        });
        assert!(!taken);
        let status = summon.status();
        assert_eq!(status.state, State::Failed);
        assert_eq!(status.failure.unwrap().shortcut, "Ctrl+Alt+H");
        assert_eq!(fake.open_sessions(), Vec::<String>::new(), "the dead session is closed");
        // The portal restarts as the bind answers.
        assert!(!register_with_loss_between(&summon, |_| {
            summon.lost(Loss::Portal, "restarted".into());
        }));
        // An older session ending meanwhile doesn't spoil a new bind; nothing in between doesn't either.
        assert!(register_with_loss_between(&summon, |_| {
            summon.lost(Loss::Session("/older".into()), "ended".into());
        }));
        assert_eq!(summon.status().state, State::Working);
    }

    #[test]
    fn an_x11_key_lost_between_its_grab_and_its_use_is_not_taken_as_working() {
        let summon = summon_with(Engine::None("test".into()), Registered::X11(Combo::parse("Ctrl+Alt+J").unwrap().x11_key()));
        let key = Combo::parse("Ctrl+Alt+H").unwrap().x11_key();
        // Ctrl+Alt+H isn't the app's yet (Ctrl+Alt+J is), so its loss is kept for `accept`.
        assert!(!summon.lost(Loss::Key(key), "layout".into()));
        let mut i = summon.inner.lock().unwrap();
        let refused = Summon::accept(&mut i, Fresh { r: Registered::X11(key), epoch: 0 }, "Ctrl+Alt+H");
        assert!(refused.is_err());
        // Recorded losses are spent once a registration is taken or refused.
        assert!(Summon::accept(&mut i, Fresh { r: Registered::X11(key), epoch: 0 }, "Ctrl+Alt+H").is_ok());
    }

    #[test]
    fn parses_only_shortcuts_that_cannot_take_a_typed_key() {
        assert_eq!(label(&Combo::parse("Ctrl+Alt+H").unwrap()), "Ctrl+Alt+H");
        assert_eq!(label(&Combo::parse("Super+F12").unwrap()), "Super+F12");
        assert_eq!(label(&Combo::parse("Ctrl+Shift+Super+PrintScreen").unwrap()), "Ctrl+Shift+Super+PrintScreen");
        assert!(Combo::parse("Shift+H").is_err());
        assert!(Combo::parse("H").is_err());
        assert!(Combo::parse("F5").is_err());
        assert!(Combo::parse("Alt+Ctrl+H").is_err(), "modifiers in another order");
        assert!(Combo::parse("Ctrl+Ctrl+H").is_err());
        assert!(Combo::parse("Ctrl+F25").is_err());
        assert!(Combo::parse("Ctrl+F0").is_err());
        assert!(Combo::parse("Ctrl+h").is_err());
        assert!(Combo::parse("Ctrl+Space").is_err());
        assert!(Combo::parse("Ctrl+Alt+H; rm -rf ~").is_err());
    }

    #[test]
    fn maps_a_shortcut_to_the_x11_key_and_the_portals_trigger() {
        let c = Combo::parse("Ctrl+Alt+H").unwrap();
        assert_eq!(c.x11_key(), x11_grab::Key { keysym: 0x68, ctrl: true, alt: true, shift: false, sup: false });
        assert_eq!(c.trigger(), "CTRL+ALT+h");
        assert_eq!(Combo::parse("Shift+Super+7").unwrap().trigger(), "SHIFT+LOGO+7");
        assert_eq!(Combo::parse("Alt+PrintScreen").unwrap().trigger(), "ALT+Print");
        assert_eq!(Combo::parse("Ctrl+ScrollLock").unwrap().trigger(), "CTRL+Scroll_Lock");
        assert_eq!(Combo::parse("Super+F24").unwrap().x11_key(), x11_grab::Key { keysym: 0xffd5, ctrl: false, alt: false, shift: false, sup: true });
    }

    #[test]
    fn a_damaged_or_hand_edited_setting_turns_the_shortcut_off() {
        let dir = std::env::temp_dir().join(format!("hermes-chat-summon-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = Some(dir.join(FILE));
        assert_eq!(read_setting(&file), Setting::default());
        let s = Setting { shortcut: Some("Ctrl+Alt+J".into()), hide_when_active: true };
        write_setting(&file, &s).unwrap();
        assert_eq!(read_setting(&file), s);
        std::fs::write(dir.join(FILE), r#"{"shortcut":"Ctrl+Alt+J; touch /tmp/x","hideWhenActive":true}"#).unwrap();
        assert_eq!(read_setting(&file), Setting::default());
        std::fs::write(dir.join(FILE), "not json").unwrap();
        assert_eq!(read_setting(&file), Setting::default());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn finds_hyprlands_name_for_the_shortcut() {
        let json = r#"[{"name":"org.kde.foo:bar","description":"Other"},{"name":"hermes-chat:hermes-chat","description":"Show Hermes Chat"}]"#;
        assert_eq!(hyprland_name_in(json).as_deref(), Some("hermes-chat:hermes-chat"));
        let empty_app = r#"[{"name":":hermes-chat","description":"Show Hermes Chat"}]"#;
        assert_eq!(hyprland_name_in(empty_app).as_deref(), Some(":hermes-chat"));
        assert_eq!(hyprland_name_in("[]"), None);
        assert_eq!(hyprland_name_in("not json"), None);
    }
}
