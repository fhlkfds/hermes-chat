//! The XDG desktop portal's GlobalShortcuts interface, for the global shortcut on Wayland (summon.rs, ADR 0033).
//! Wayland doesn't let an app grab keys, so the app asks the desktop instead: KDE Plasma and GNOME ask the owner to
//! confirm the key, and Hyprland (xdg-desktop-portal-hyprland) lists the shortcut for a `global` bind in its config.
//!
//! A portal session belongs to the D-Bus connection that made it, and the desktop reports a press only to that
//! connection, so one thread owns the connection for the app's lifetime and does every call. Each change binds in a
//! new session and closes the old one only once the new one is bound, so a refused change leaves the old key working.

use dbus::arg::{PropMap, RefArg, Variant};
use dbus::blocking::Connection;
use dbus::channel::Channel;
use dbus::message::MatchRule;
use dbus::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

pub const DEST: &str = "org.freedesktop.portal.Desktop";
pub const OBJECT: &str = "/org/freedesktop/portal/desktop";
pub const IFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST: &str = "org.freedesktop.portal.Request";
const SESSION: &str = "org.freedesktop.portal.Session";
const CALL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a bind may wait for the owner to answer the desktop's dialog.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

/// A shortcut the desktop bound. `trigger`: the key it says it set, if it says (Hyprland never does).
#[derive(Debug, Clone, PartialEq)]
pub struct Bound {
    pub session: String,
    pub trigger: Option<String>,
}

/// Why a bind didn't happen. `Denied`: the owner said no, or cancelled the desktop's dialog.
#[derive(Debug, Clone, PartialEq)]
pub enum BindError {
    Denied,
    Failed(String),
}

/// What the desktop tells the app outside a call.
pub enum Event {
    /// The shortcut was pressed. `token`: an xdg-activation token, so the compositor lets the window take focus.
    Activated { session: String, id: String, token: Option<String> },
    /// The owner changed the key in the desktop's settings.
    Changed { session: String, triggers: Vec<(String, Option<String>)> },
    /// The desktop ended a session (`session`), or every session: the portal restarted or the connection closed. Its
    /// shortcut no longer works.
    Closed { session: Option<String>, why: String },
}

enum Job {
    Bind { id: String, description: String, trigger: String, reply: mpsc::Sender<Result<Bound, BindError>> },
    Close { session: String, reply: mpsc::Sender<()> },
}

/// The thread that talks to the portal.
pub struct Portal {
    jobs: Mutex<mpsc::Sender<Job>>,
}

impl Portal {
    /// Connects and checks the desktop offers GlobalShortcuts. `address`: a bus other than the session bus (tests).
    /// An error says why there's no portal to use.
    pub fn start(address: Option<String>, events: impl Fn(Event) + Send + Sync + 'static) -> Result<Portal, String> {
        let (ready_tx, ready) = mpsc::channel();
        let (jobs_tx, jobs) = mpsc::channel();
        std::thread::spawn(move || {
            let conn = match connect(address.as_deref()).and_then(|c| version(&c).map(|v| (c, v))) {
                Ok((conn, _)) => conn,
                Err(e) => return drop(ready_tx.send(Err(e))),
            };
            let events: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(events);
            if let Err(e) = listen(&conn, events.clone()) {
                return drop(ready_tx.send(Err(format!("couldn't listen to the desktop portal: {e}"))));
            }
            let _ = ready_tx.send(Ok(()));
            serve(&conn, jobs, events);
        });
        ready.recv_timeout(CALL_TIMEOUT * 2).map_err(|_| "the desktop portal didn't answer".to_owned())??;
        Ok(Portal { jobs: Mutex::new(jobs_tx) })
    }

    /// Binds one shortcut in a new session. Blocks until the desktop answers, which may wait on the owner.
    pub fn bind(&self, id: &str, description: &str, trigger: &str) -> Result<Bound, BindError> {
        let (reply, answer) = mpsc::channel();
        let job = Job::Bind { id: id.into(), description: description.into(), trigger: trigger.into(), reply };
        self.jobs.lock().unwrap().send(job).map_err(|_| BindError::Failed("the desktop portal connection closed".into()))?;
        answer.recv().map_err(|_| BindError::Failed("the desktop portal connection closed".into()))?
    }

    /// Ends a session, which releases its shortcut.
    pub fn close(&self, session: &str) {
        let (reply, done) = mpsc::channel();
        if self.jobs.lock().unwrap().send(Job::Close { session: session.into(), reply }).is_ok() {
            let _ = done.recv_timeout(CALL_TIMEOUT * 2);
        }
    }
}

fn connect(address: Option<&str>) -> Result<Connection, String> {
    let conn = match address {
        None => Connection::new_session().map_err(|e| format!("no session bus: {e}"))?,
        Some(a) => {
            let mut ch = Channel::open_private(a).map_err(|e| e.to_string())?;
            ch.register().map_err(|e| e.to_string())?;
            Connection::from(ch)
        }
    };
    Ok(conn)
}

/// The interface's version; an error when the desktop has no GlobalShortcuts portal.
fn version(conn: &Connection) -> Result<u32, String> {
    use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
    conn.with_proxy(DEST, OBJECT, CALL_TIMEOUT)
        .get::<u32>(IFACE, "version")
        .map_err(|e| match e.name() {
            Some("org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner") => "no desktop portal is running".to_owned(),
            Some("org.freedesktop.DBus.Error.UnknownInterface" | "org.freedesktop.DBus.Error.UnknownProperty" | "org.freedesktop.DBus.Error.InvalidArgs") => {
                "the desktop portal here has no GlobalShortcuts".to_owned()
            }
            _ => format!("the desktop portal didn't answer ({})", e.message().unwrap_or("no reply")),
        })
}

fn listen(conn: &Connection, events: Arc<dyn Fn(Event) + Send + Sync>) -> Result<(), dbus::Error> {
    let e = events.clone();
    conn.add_match(MatchRule::new_signal(SESSION, "Closed"), move |(): (), _, msg| {
        if let Some(path) = msg.path() {
            e(Event::Closed { session: Some(path.to_string()), why: "Your desktop ended the shortcut's registration.".into() });
        }
        true
    })?;
    // The portal restarting drops every session it had.
    let e = events.clone();
    let owner = MatchRule::new_signal("org.freedesktop.DBus", "NameOwnerChanged").with_sender("org.freedesktop.DBus");
    conn.add_match(owner, move |(name, old, _new): (String, String, String), _, _| {
        if name == DEST && !old.is_empty() {
            e(Event::Closed { session: None, why: "The desktop portal restarted, so the shortcut's registration ended.".into() });
        }
        true
    })?;
    let e = events.clone();
    conn.add_match(
        MatchRule::new_signal(IFACE, "Activated").with_path(OBJECT),
        move |(session, id, _, options): (Path<'static>, String, u64, PropMap), _, _| {
            let token = options.get("activation_token").and_then(|v| v.0.as_str()).filter(|t| !t.is_empty()).map(str::to_owned);
            e(Event::Activated { session: session.to_string(), id, token });
            true
        },
    )?;
    conn.add_match(
        MatchRule::new_signal(IFACE, "ShortcutsChanged").with_path(OBJECT),
        move |(session, shortcuts): (Path<'static>, Vec<(String, PropMap)>), _, _| {
            let triggers = shortcuts.iter().map(|(id, props)| (id.clone(), trigger_of(props))).collect();
            events(Event::Changed { session: session.to_string(), triggers });
            true
        },
    )?;
    Ok(())
}

fn serve(conn: &Connection, jobs: mpsc::Receiver<Job>, events: Arc<dyn Fn(Event) + Send + Sync>) {
    let mut n = 0u32;
    loop {
        if conn.process(Duration::from_millis(100)).is_err() {
            events(Event::Closed { session: None, why: "The connection to the desktop portal closed.".into() });
            return eprintln!("hermes-chat: the desktop portal connection closed; the global shortcut stopped");
        }
        match jobs.try_recv() {
            Ok(Job::Bind { id, description, trigger, reply }) => {
                n += 1;
                let _ = reply.send(bind(conn, n, &id, &description, &trigger));
            }
            Ok(Job::Close { session, reply }) => {
                close(conn, &session);
                let _ = reply.send(());
            }
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => return,
        }
    }
}

fn bind(conn: &Connection, n: u32, id: &str, description: &str, trigger: &str) -> Result<Bound, BindError> {
    let pid = std::process::id();
    let token = format!("hermes_chat_{pid}_{n}");
    let mut options = PropMap::new();
    options.insert("handle_token".into(), Variant(Box::new(format!("{token}_s"))));
    options.insert("session_handle_token".into(), Variant(Box::new(token.clone())));
    let (code, results) = request(conn, &format!("{token}_s"), |proxy| proxy.method_call(IFACE, "CreateSession", (options,)))?;
    if code != 0 {
        return Err(answer_error(code, "start a session"));
    }
    let session = results
        .get("session_handle")
        .and_then(|v| v.0.as_str())
        .map(str::to_owned)
        .ok_or_else(|| BindError::Failed("the desktop portal didn't say which session it made".into()))?;
    let bound = (|| {
        let path = Path::new(session.clone()).map_err(|e| BindError::Failed(e))?;
        let mut props = PropMap::new();
        props.insert("description".into(), Variant(Box::new(description.to_owned())));
        props.insert("preferred_trigger".into(), Variant(Box::new(trigger.to_owned())));
        let mut options = PropMap::new();
        options.insert("handle_token".into(), Variant(Box::new(format!("{token}_b"))));
        let shortcuts = vec![(id.to_owned(), props)];
        let (code, results) = request(conn, &format!("{token}_b"), |proxy| proxy.method_call(IFACE, "BindShortcuts", (path, shortcuts, "", options)))?;
        if code != 0 {
            return Err(answer_error(code, "bind the shortcut"));
        }
        let listed = shortcuts_of(&results);
        match listed.into_iter().find(|(i, _)| i == id) {
            Some((_, trigger)) => Ok(Bound { session: session.clone(), trigger }),
            None => Err(BindError::Denied),
        }
    })();
    if bound.is_err() {
        close(conn, &session);
    }
    bound
}

/// Calls a method that answers through a Request object, and waits for the answer. Listening starts before the call,
/// at the path the portal will use, so a fast answer isn't missed.
fn request(
    conn: &Connection,
    token: &str,
    call: impl FnOnce(&dbus::blocking::Proxy<'_, &Connection>) -> Result<(Path<'static>,), dbus::Error>,
) -> Result<(u32, PropMap), BindError> {
    let sender = conn.unique_name().trim_start_matches(':').replace('.', "_");
    let expected = format!("{OBJECT}/request/{sender}/{token}");
    let answer: Arc<Mutex<Option<(u32, PropMap)>>> = Arc::default();
    let watch = |path: String| {
        let a = answer.clone();
        let rule = MatchRule::new_signal(REQUEST, "Response").with_path(Path::new(path).unwrap_or_default());
        conn.add_match(rule, move |(code, results): (u32, PropMap), _, _| {
            *a.lock().unwrap() = Some((code, results));
            false
        })
    };
    let first = watch(expected.clone()).map_err(|e| BindError::Failed(e.to_string()))?;
    let proxy = conn.with_proxy(DEST, OBJECT, CALL_TIMEOUT);
    let (handle,) = match call(&proxy) {
        Ok(h) => h,
        Err(e) => {
            let _ = conn.remove_match(first);
            return Err(BindError::Failed(e.message().unwrap_or("the desktop portal refused the call").to_owned()));
        }
    };
    // Older portals pick the path themselves.
    let other = (handle.to_string() != expected).then(|| watch(handle.to_string()).ok()).flatten();
    let deadline = Instant::now() + ANSWER_TIMEOUT;
    let result = loop {
        if let Some(a) = answer.lock().unwrap().take() {
            break Ok(a);
        }
        if Instant::now() >= deadline {
            let _ = conn.with_proxy(DEST, handle.clone(), CALL_TIMEOUT).method_call::<(), _, _, _>(REQUEST, "Close", ());
            break Err(BindError::Failed("the desktop didn't answer within two minutes".into()));
        }
        if let Err(e) = conn.process(Duration::from_millis(100)) {
            break Err(BindError::Failed(e.to_string()));
        }
    };
    let _ = conn.remove_match(first);
    if let Some(t) = other {
        let _ = conn.remove_match(t);
    }
    result
}

fn answer_error(code: u32, what: &str) -> BindError {
    match code {
        1 => BindError::Denied,
        _ => BindError::Failed(format!("the desktop couldn't {what}")),
    }
}

fn close(conn: &Connection, session: &str) {
    let Ok(path) = Path::new(session.to_owned()) else { return };
    if let Err(e) = conn.with_proxy(DEST, path, CALL_TIMEOUT).method_call::<(), _, _, _>(SESSION, "Close", ()) {
        eprintln!("hermes-chat: couldn't end the global shortcut's portal session: {e}");
    }
}

fn trigger_of(props: &PropMap) -> Option<String> {
    props.get("trigger_description").and_then(|v| v.0.as_str()).map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned)
}

/// The `shortcuts` a BindShortcuts answer lists: `a(sa{sv})`, each id with its trigger description.
fn shortcuts_of(results: &PropMap) -> Vec<(String, Option<String>)> {
    let Some(list) = results.get("shortcuts") else { return vec![] };
    let Some(items) = list.0.as_iter() else { return vec![] };
    let mut out = vec![];
    for item in items {
        let Some(mut fields) = item.as_iter() else { continue };
        let (Some(id), Some(props)) = (fields.next().and_then(|f| f.as_str().map(str::to_owned)), fields.next()) else { continue };
        let mut trigger = None;
        if let Some(mut kv) = props.as_iter() {
            while let (Some(k), Some(v)) = (kv.next(), kv.next()) {
                if k.as_str() == Some("trigger_description") {
                    trigger = v.as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned);
                }
            }
        }
        out.push((id, trigger));
    }
    out
}

#[cfg(test)]
#[path = "../examples/fake_portal.rs"]
#[allow(dead_code)]
pub(crate) mod fake_portal;

#[cfg(test)]
mod tests {
    use super::*;
    use fake_portal::{Behavior, FakePortal};

    fn start(behavior: Behavior) -> (FakePortal, Portal, mpsc::Receiver<Event>) {
        let fake = FakePortal::start(behavior);
        let (tx, rx) = mpsc::channel();
        let portal = Portal::start(Some(fake.address.clone()), move |e| drop(tx.send(e))).expect("portal");
        (fake, portal, rx)
    }

    #[test]
    fn binds_a_shortcut_and_reports_the_key_the_desktop_set_and_its_presses() {
        let (fake, portal, events) = start(Behavior::Grant);
        let bound = portal.bind("hermes-chat", "Show Hermes Chat", "CTRL+ALT+h").unwrap();
        assert_eq!(bound.trigger.as_deref(), Some("Press CTRL+ALT+h"));
        assert_eq!(fake.preferred_triggers(), vec!["CTRL+ALT+h".to_owned()]);
        fake.press(&bound.session, "hermes-chat", Some("tok-1"));
        match events.recv_timeout(Duration::from_secs(5)).unwrap() {
            Event::Activated { session, id, token } => {
                assert_eq!(session, bound.session);
                assert_eq!(id, "hermes-chat");
                assert_eq!(token.as_deref(), Some("tok-1"));
            }
            _ => panic!("expected a press"),
        }
        portal.close(&bound.session);
        assert_eq!(fake.open_sessions(), Vec::<String>::new());
    }

    fn closed(events: &mpsc::Receiver<Event>) -> (Option<String>, String) {
        loop {
            match events.recv_timeout(Duration::from_secs(5)).expect("a Closed event") {
                Event::Closed { session, why } => return (session, why),
                _ => continue,
            }
        }
    }

    #[test]
    fn reports_a_session_the_desktop_ended_and_binds_again_after() {
        let (fake, portal, events) = start(Behavior::Grant);
        let bound = portal.bind("hermes-chat", "Show Hermes Chat", "CTRL+ALT+h").unwrap();
        fake.end_session(&bound.session);
        assert_eq!(closed(&events).0.as_deref(), Some(bound.session.as_str()));
        // Retry binds in a new session.
        let again = portal.bind("hermes-chat", "Show Hermes Chat", "CTRL+ALT+h").unwrap();
        assert_ne!(again.session, bound.session);
        assert_eq!(fake.open_sessions(), vec![again.session]);
    }

    #[test]
    fn reports_every_session_lost_when_the_portal_restarts() {
        let (fake, portal, events) = start(Behavior::Grant);
        portal.bind("hermes-chat", "Show Hermes Chat", "CTRL+ALT+h").unwrap();
        fake.restart();
        let (session, why) = closed(&events);
        assert_eq!(session, None);
        assert!(why.contains("restarted"), "{why}");
        // The restarted portal binds again.
        assert!(portal.bind("hermes-chat", "Show Hermes Chat", "CTRL+ALT+h").is_ok());
    }

    #[test]
    fn a_refusal_is_denied_and_leaves_no_session_open() {
        let (fake, portal, _events) = start(Behavior::Deny);
        assert_eq!(portal.bind("hermes-chat", "Show Hermes Chat", "CTRL+ALT+h"), Err(BindError::Denied));
        assert_eq!(fake.open_sessions(), Vec::<String>::new());
    }

    #[test]
    fn a_desktop_that_sets_no_key_is_bound_without_a_trigger() {
        let (_fake, portal, _events) = start(Behavior::NoTrigger);
        let bound = portal.bind("hermes-chat", "Show Hermes Chat", "CTRL+ALT+h").unwrap();
        assert_eq!(bound.trigger, None);
    }

    #[test]
    fn a_desktop_without_global_shortcuts_is_reported() {
        let fake = FakePortal::start(Behavior::NoInterface);
        let err = Portal::start(Some(fake.address.clone()), |_| {}).err().unwrap();
        assert_eq!(err, "the desktop portal here has no GlobalShortcuts");
    }
}
