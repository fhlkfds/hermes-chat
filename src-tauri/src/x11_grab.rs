//! The global shortcut's key grab on an X11 session (summon.rs, ADR 0033). One thread owns a connection to the X
//! server, grabs and releases keys on the root window, and reports presses.
//!
//! Every grab and release waits for the server's answer, so a key another app has is reported as taken (`BadAccess`)
//! and a released key is free the moment `ungrab` returns. A key is grabbed by its keycode in the keyboard group (layout)
//! in use, and grabbed again when the owner switches layout or the keymap changes; one that can't be is reported lost. tauri-plugin-global-shortcut's X11 backend leaves its
//! XUngrabKey in the write buffer, so a released key stayed grabbed until some later request flushed it.

use std::sync::mpsc;
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::errors::ReplyError;
use x11rb::protocol::xproto::{ConnectionExt, GrabMode, KeyButMask, ModMask};
use x11rb::protocol::{xkb, ErrorKind, Event};
use x11rb::rust_connection::RustConnection;

/// A key with its modifiers, as the X server sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Key {
    pub keysym: u32,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub sup: bool,
}

impl Key {
    fn mods(&self) -> ModMask {
        let mut m = ModMask::from(0u16);
        for (on, bit) in [(self.ctrl, ModMask::CONTROL), (self.alt, ModMask::M1), (self.shift, ModMask::SHIFT), (self.sup, ModMask::M4)] {
            if on {
                m |= bit;
            }
        }
        m
    }
}

/// The keysym of a key the setting can name: `H`, `7`, `F12`, `PrintScreen`, `Pause`, `ScrollLock`, `Insert`.
pub fn keysym(key: &str) -> Option<u32> {
    let b = key.as_bytes();
    match key {
        "PrintScreen" => Some(0xff61),
        "Pause" => Some(0xff13),
        "ScrollLock" => Some(0xff14),
        "Insert" => Some(0xff63),
        // Letters by their unshifted keysym (XK_a…XK_z), digits as XK_0…XK_9.
        _ if b.len() == 1 && b[0].is_ascii_uppercase() => Some(b[0].to_ascii_lowercase() as u32),
        _ if b.len() == 1 && b[0].is_ascii_digit() => Some(b[0] as u32),
        _ if key.starts_with('F') && !key.starts_with("F0") => key[1..].parse::<u32>().ok().filter(|n| (1..=24).contains(n)).map(|n| 0xffbe + n - 1),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum GrabError {
    /// Another app already has the key.
    Taken,
    /// The keyboard has no key for it.
    NoKey,
    Failed(String),
}

/// What the grab reports from its thread.
#[derive(Debug, Clone, PartialEq)]
pub enum GrabEvent {
    Pressed(Key),
    /// A layout or keymap change moved the key, and grabbing it again failed; it is no longer grabbed.
    Lost(Key, String),
}

enum Job {
    Grab(Key, mpsc::Sender<Result<(), GrabError>>),
    Ungrab(Key, mpsc::Sender<()>),
}

pub struct Grabber {
    jobs: std::sync::Mutex<mpsc::Sender<Job>>,
}

/// Lock and NumLock change the state a press arrives with, so each key is grabbed with every mix of them.
const IGNORED: [u16; 4] = [0, 1 << 1, 1 << 4, (1 << 1) | (1 << 4)];

impl Grabber {
    /// Connects to the X server; `events` is called on the grab's thread for each press (not its auto-repeats) and
    /// each key lost to a layout change.
    pub fn start(events: impl Fn(GrabEvent) + Send + 'static) -> Result<Grabber, String> {
        let (ready_tx, ready) = mpsc::channel();
        let (jobs_tx, jobs) = mpsc::channel();
        std::thread::spawn(move || {
            let (conn, screen) = match RustConnection::connect(None) {
                Ok(c) => c,
                Err(e) => return drop(ready_tx.send(Err(format!("couldn't reach the X server: {e}")))),
            };
            // Hold a key and the server sends press, release, press…; with this it sends only presses until the
            // owner lets go, so holding the shortcut doesn't flicker the window.
            let _ = xkb::ConnectionExt::xkb_use_extension(&conn, 1, 0).map(|c| c.reply());
            let _ = xkb::ConnectionExt::xkb_per_client_flags(
                &conn,
                xkb::ID::USE_CORE_KBD.into(),
                xkb::PerClientFlag::DETECTABLE_AUTO_REPEAT,
                xkb::PerClientFlag::DETECTABLE_AUTO_REPEAT,
                Default::default(),
                Default::default(),
                Default::default(),
            )
            .map(|c| c.reply());
            // Layout switches and keymap changes move keys to other keycodes.
            let changes = xkb::EventType::STATE_NOTIFY | xkb::EventType::MAP_NOTIFY | xkb::EventType::NEW_KEYBOARD_NOTIFY;
            let _ = xkb::ConnectionExt::xkb_select_events(
                &conn,
                xkb::ID::USE_CORE_KBD.into(),
                0u16.into(),
                changes,
                0u16.into(),
                0u16.into(),
                &xkb::SelectEventsAux::default(),
            )
            .map(|c| c.check());
            let group = xkb::ConnectionExt::xkb_get_state(&conn, xkb::ID::USE_CORE_KBD.into())
                .ok()
                .and_then(|c| c.reply().ok())
                .map_or(0, |s| u8::from(s.group));
            let root = conn.setup().roots[screen].root;
            let _ = ready_tx.send(Ok(()));
            serve(&conn, root, group, jobs, events);
        });
        ready.recv_timeout(Duration::from_secs(5)).map_err(|_| "the X server didn't answer".to_owned())??;
        Ok(Grabber { jobs: std::sync::Mutex::new(jobs_tx) })
    }

    pub fn grab(&self, key: Key) -> Result<(), GrabError> {
        let (tx, rx) = mpsc::channel();
        self.jobs.lock().unwrap().send(Job::Grab(key, tx)).map_err(|_| GrabError::Failed("the X connection closed".into()))?;
        rx.recv().map_err(|_| GrabError::Failed("the X connection closed".into()))?
    }

    /// Releases a key; the server has let go of it when this returns.
    pub fn ungrab(&self, key: Key) {
        let (tx, rx) = mpsc::channel();
        if self.jobs.lock().unwrap().send(Job::Ungrab(key, tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(5));
        }
    }
}

fn keycode(conn: &RustConnection, keysym: u32, group: u8) -> Result<Option<u8>, String> {
    let setup = conn.setup();
    let (min, max) = (setup.min_keycode, setup.max_keycode);
    let none = xkb::MapPart::from(0u16);
    let map = xkb::ConnectionExt::xkb_get_map(
        conn,
        xkb::ID::USE_CORE_KBD.into(),
        xkb::MapPart::KEY_SYMS,
        none,
        0,
        0,
        min,
        max - min + 1,
        0,
        0,
        0,
        0,
        0u16.into(),
        0,
        0,
        0,
        0,
        0,
        0,
    )
    .map_err(|e| e.to_string())?
    .reply()
    .map_err(|e| e.to_string())?;
    let keys: Vec<KeySyms> = map
        .map
        .syms_rtrn
        .unwrap_or_default()
        .into_iter()
        .map(|k| KeySyms { group_info: k.group_info, width: k.width, syms: k.syms })
        .collect();
    Ok(find_keycode(&keys, map.first_key_sym, keysym, group))
}

/// One key's symbols from XKB's own map: `group_info` (the number of groups, and what a group past them means) and
/// `width` levels for each group, group by group.
pub struct KeySyms {
    pub group_info: u8,
    pub width: u8,
    pub syms: Vec<u32>,
}

/// The group a key uses when `group` is in effect: a key with fewer groups wraps, clamps or redirects, as XKB does.
fn effective_group(group_info: u8, group: u8) -> Option<usize> {
    let n = group_info & 0x0f;
    if n == 0 {
        return None;
    }
    if group < n {
        return Some(group as usize);
    }
    Some(match group_info & 0xc0 {
        0x40 => n - 1,
        0x80 => Some((group_info >> 4) & 0x03).filter(|r| *r < n).unwrap_or(0),
        _ => group % n,
    } as usize)
}

/// The keycode that types `keysym`, at any level, in keyboard group `group` (0 for the first layout). A keysym the
/// group has on no key isn't looked for in other layouts: grabbing a key from another layout would look working and
/// never fire.
pub fn find_keycode(keys: &[KeySyms], first: u8, keysym: u32, group: u8) -> Option<u8> {
    keys.iter()
        .position(|k| {
            let w = k.width as usize;
            effective_group(k.group_info, group).is_some_and(|g| k.syms.get(g * w..(g + 1) * w).is_some_and(|l| l.contains(&keysym)))
        })
        .map(|i| first + i as u8)
}

fn grab(conn: &RustConnection, root: u32, group: u8, grabbed: &mut Vec<(Key, u8)>, key: Key) -> Result<(), GrabError> {
    let code = keycode(conn, key.keysym, group).map_err(GrabError::Failed)?.ok_or(GrabError::NoKey)?;
    let mods = key.mods();
    for (i, extra) in IGNORED.iter().enumerate() {
        let sent = conn.grab_key(false, root, mods | ModMask::from(*extra), code, GrabMode::ASYNC, GrabMode::ASYNC);
        let answer = sent.map_err(|e| ReplyError::from(e)).and_then(|c| c.check());
        if let Err(e) = answer {
            // Undo the part that was grabbed, so a refused key leaves nothing behind.
            for extra in &IGNORED[..i] {
                if let Ok(c) = conn.ungrab_key(code, root, mods | ModMask::from(*extra)) {
                    let _ = c.check();
                }
            }
            return Err(match e {
                ReplyError::X11Error(x) if x.error_kind == ErrorKind::Access => GrabError::Taken,
                e => GrabError::Failed(e.to_string()),
            });
        }
    }
    grabbed.push((key, code));
    Ok(())
}

fn ungrab(conn: &RustConnection, root: u32, grabbed: &mut Vec<(Key, u8)>, key: Key) {
    let Some(at) = grabbed.iter().position(|(k, _)| *k == key) else { return };
    let (_, code) = grabbed.remove(at);
    for extra in IGNORED {
        // Checked, which also flushes: the key is free once this returns.
        if let Ok(c) = conn.ungrab_key(code, root, key.mods() | ModMask::from(extra)) {
            if let Err(e) = c.check() {
                eprintln!("hermes-chat: couldn't release the global shortcut: {e}");
            }
        }
    }
}

/// Grabs each key again at its keycode in `group`, after a layout or keymap change.
fn regrab(conn: &RustConnection, root: u32, group: u8, grabbed: &mut Vec<(Key, u8)>, events: &impl Fn(GrabEvent)) {
    for (key, code) in grabbed.clone() {
        if keycode(conn, key.keysym, group).ok().flatten() == Some(code) {
            continue;
        }
        ungrab(conn, root, grabbed, key);
        if let Err(e) = grab(conn, root, group, grabbed, key) {
            let why = match e {
                GrabError::Taken => "another app has it in this keyboard layout".to_owned(),
                GrabError::NoKey => "this keyboard layout has no key for it".to_owned(),
                GrabError::Failed(e) => e,
            };
            events(GrabEvent::Lost(key, why));
        }
    }
}

fn serve(conn: &RustConnection, root: u32, mut group: u8, jobs: mpsc::Receiver<Job>, events: impl Fn(GrabEvent)) {
    let mut grabbed: Vec<(Key, u8)> = vec![];
    let held = KeyButMask::CONTROL | KeyButMask::SHIFT | KeyButMask::MOD1 | KeyButMask::MOD4;
    let mut down: Option<u8> = None;
    loop {
        loop {
            match conn.poll_for_event() {
                Ok(Some(Event::KeyPress(e))) => {
                    let state = u16::from(e.state & held);
                    let hit = grabbed.iter().find(|(k, code)| *code == e.detail && u16::from(k.mods()) == state);
                    if let (Some((key, _)), true) = (hit, down != Some(e.detail)) {
                        down = Some(e.detail);
                        events(GrabEvent::Pressed(*key));
                    }
                }
                Ok(Some(Event::XkbStateNotify(e))) if u8::from(e.group) != group => {
                    group = u8::from(e.group);
                    regrab(conn, root, group, &mut grabbed, &events);
                }
                Ok(Some(Event::XkbMapNotify(_) | Event::XkbNewKeyboardNotify(_) | Event::MappingNotify(_))) => {
                    regrab(conn, root, group, &mut grabbed, &events);
                }
                Ok(Some(Event::KeyRelease(e))) if down == Some(e.detail) => down = None,
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(e) => return eprintln!("hermes-chat: the X connection closed, so the global shortcut stopped: {e}"),
            }
        }
        match jobs.recv_timeout(Duration::from_millis(20)) {
            Ok(Job::Grab(key, reply)) => {
                let _ = reply.send(grab(conn, root, group, &mut grabbed, key));
            }
            Ok(Job::Ungrab(key, reply)) => {
                ungrab(conn, root, &mut grabbed, key);
                let _ = reply.send(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                for (key, _) in grabbed.clone() {
                    ungrab(conn, root, &mut grabbed, key);
                }
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_keys_by_their_x11_keysyms() {
        assert_eq!(keysym("H"), Some(0x68)); // XK_h
        assert_eq!(keysym("0"), Some(0x30));
        assert_eq!(keysym("F1"), Some(0xffbe));
        assert_eq!(keysym("F12"), Some(0xffc9));
        assert_eq!(keysym("F24"), Some(0xffd5));
        assert_eq!(keysym("PrintScreen"), Some(0xff61));
        assert_eq!(keysym("ScrollLock"), Some(0xff14));
        assert_eq!(keysym("F25"), None);
        assert_eq!(keysym("F0"), None);
        assert_eq!(keysym("h"), None);
    }

    #[test]
    fn finds_the_key_in_the_layout_in_use() {
        const A: u32 = 0x61;
        const Q: u32 = 0x71;
        const ONE: u32 = 0x31;
        let key = |groups: u8, width: u8, syms: &[u32]| KeySyms { group_info: groups, width, syms: syms.to_vec() };
        // us,fr,de,ru, four levels a group. Keycode 24 types q (us), a (fr), q (de), й (ru); 38 the other way round.
        let keys = [
            key(4, 4, &[Q, 0x51, 0, 0, A, 0x41, 0xe6, 0xc6, Q, 0x51, 0x40, 0, 0x6ca, 0x6ea, 0, 0]),
            key(4, 4, &[A, 0x41, 0, 0, Q, 0x51, 0, 0, A, 0x41, 0, 0, 0x6c6, 0x6e6, 0, 0]),
            // Keycode 26: 1 ! (us), & 1 (fr): the digit is fr's second level. One group wide and no more.
            key(2, 2, &[ONE, 0x21, 0x26, ONE]),
            // Keycode 27: a key with one group, which every layout uses.
            key(1, 2, &[0xff61, 0]),
        ];
        let at = |sym, group| find_keycode(&keys, 24, sym, group);
        assert_eq!(at(A, 0), Some(25), "us");
        assert_eq!(at(A, 1), Some(24), "fr");
        assert_eq!(at(A, 2), Some(25), "de");
        assert_eq!(at(Q, 1), Some(25));
        assert_eq!(at(ONE, 1), Some(26), "a second level counts");
        // A key with fewer groups wraps, as XKB does: group 3 on a two-group key is its second.
        assert_eq!(at(0x26, 3), Some(26));
        assert_eq!(at(0xff61, 2), Some(27));
        // ru has no a or q on any key: not borrowed from another layout.
        assert_eq!(at(A, 3), None);
        assert_eq!(at(Q, 3), None);
    }

    #[test]
    fn a_group_past_a_keys_own_is_wrapped_clamped_or_redirected() {
        assert_eq!(effective_group(2, 3), Some(1));
        assert_eq!(effective_group(2 | 0x40, 3), Some(1));
        assert_eq!(effective_group(3 | 0x80 | (1 << 4), 3), Some(1));
        assert_eq!(effective_group(3 | 0x80 | (3 << 4), 3), Some(0));
        assert_eq!(effective_group(0, 0), None);
    }
}
