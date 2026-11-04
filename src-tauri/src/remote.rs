//! `hermes-chat --screenshot`, for a desktop shortcut that works while another window is focused. Wayland doesn't let
//! an app listen for keys it isn't focused for, so the owner binds a key in their desktop to run that command. It
//! asks the Hermes Chat already running, over the session bus, to take a screenshot; with none running, the app starts
//! and takes one once it is signed in. Either way the request waits in Rust until a signed-in window takes it, so one
//! made at the sign-in screen isn't lost (lib.rs, `screenshot_pending_request`).
//!
//! `hermes-chat --show` and `hermes-chat --toggle` are the same idea for the global shortcut (summon.rs, ADR 0033): a
//! key bound in the desktop runs one, and the running app brings its one window forward (or, for `--toggle`, hides it
//! when it is already in front). With none running, the app starts. A plain `hermes-chat` with one already running
//! shows that one too, so there is only ever one Hermes Chat.
//!
//! The running app owns the bus name `net.l0cky12.HermesChat` and answers `Screenshot`, `Show` and `Toggle`. Only this
//! user's own programs can reach their session bus. A screenshot request only opens the picker: nothing is captured
//! until the owner picks, and nothing is sent until they send the message. `Show` and `Toggle` take the Wayland
//! activation token the desktop gave the command, if any, so the compositor lets the window take focus.

use dbus::blocking::Connection;
use dbus::channel::MatchingReceiver;
use dbus::message::{MatchRule, MessageType};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

pub const NAME: &str = "net.l0cky12.HermesChat";
const PATH: &str = "/net/l0cky12/HermesChat";
const IFACE: &str = "net.l0cky12.HermesChat";
/// The event that tells the webview a desktop shortcut asked for a screenshot.
pub const EVENT: &str = "screenshot-requested";

/// A desktop request stays pending until a live signed-in window has started handling it.
/// IDs let an acknowledgement leave a newer request alone; peeking never consumes a request.
#[derive(Default)]
pub struct Requests {
    next: AtomicU64,
    pending: Mutex<Option<(u64, Instant)>>,
}

impl Requests {
    pub fn ask(&self) {
        let mut pending = self.pending.lock().unwrap();
        *pending = Some((self.next.fetch_add(1, Ordering::Relaxed), Instant::now()));
    }

    pub fn pending(&self) -> Option<u64> {
        self.pending_at(Instant::now())
    }

    fn pending_at(&self, now: Instant) -> Option<u64> {
        let mut pending = self.pending.lock().unwrap();
        if pending.is_some_and(|(_, at)| now.duration_since(at) >= Duration::from_secs(120)) {
            *pending = None;
        }
        pending.map(|(id, _)| id)
    }

    pub fn acknowledge(&self, id: u64) {
        let mut pending = self.pending.lock().unwrap();
        if pending.is_some_and(|(current, _)| current == id) {
            *pending = None;
        }
    }
}

/// What the command line asks the running app for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Screenshot,
    /// Bring the window forward. `token`: the desktop's Wayland activation token, if it gave one.
    Show { token: Option<String> },
    /// Bring it forward, or hide it if it is already in front.
    Toggle { token: Option<String> },
}

/// Set by an update's restart (update.rs), so the new app starts even though the old one still owns the bus name.
pub const NEW_INSTANCE: &str = "HERMES_CHAT_NEW_INSTANCE";

/// The command line asks for a screenshot.
pub fn asked(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().skip(1).any(|a| a == "--screenshot")
}

/// What to ask a running Hermes Chat for, from the command line. A plain launch asks it to show itself, unless
/// `new_instance` (an update's restart, or a developer's second copy).
pub fn request_of(args: impl IntoIterator<Item = String>, token: Option<String>, new_instance: bool) -> Option<Request> {
    let args: Vec<String> = args.into_iter().skip(1).collect();
    let has = |f: &str| args.iter().any(|a| a == f);
    if has("--screenshot") {
        Some(Request::Screenshot)
    } else if has("--toggle") {
        Some(Request::Toggle { token })
    } else if has("--show") || !new_instance {
        Some(Request::Show { token })
    } else {
        None
    }
}

/// Asks the running app for a screenshot. An error when no Hermes Chat is running (or the bus can't be reached).
pub fn forward() -> Result<(), dbus::Error> {
    send(&Request::Screenshot)
}

/// Asks the running app. An error when no Hermes Chat is running (or the bus can't be reached).
pub fn send(request: &Request) -> Result<(), dbus::Error> {
    send_on(&Connection::new_session()?, request)
}

fn send_on(conn: &Connection, request: &Request) -> Result<(), dbus::Error> {
    let proxy = conn.with_proxy(NAME, PATH, Duration::from_secs(5));
    match request {
        Request::Screenshot => proxy.method_call(IFACE, "Screenshot", ()),
        Request::Show { token } => proxy.method_call(IFACE, "Show", (token.clone().unwrap_or_default(),)),
        Request::Toggle { token } => proxy.method_call(IFACE, "Toggle", (token.clone().unwrap_or_default(),)),
    }
}

/// Takes the bus name unless another Hermes Chat has it. The bus decides atomically, so of two apps starting at once
/// exactly one gets it, before either has a window. Whether this one did.
pub fn claim(conn: &Connection) -> Result<bool, dbus::Error> {
    use dbus::blocking::stdintf::org_freedesktop_dbus::RequestNameReply;
    Ok(matches!(conn.request_name(NAME, false, false, true)?, RequestNameReply::PrimaryOwner | RequestNameReply::AlreadyOwner))
}

/// Where requests go: the app's handler once it is set up, and until then a list it takes over, so a request that
/// arrives while the app starts (a second launch, a shortcut pressed early) isn't lost.
#[derive(Default)]
pub struct Inbox {
    handler: Mutex<Option<Box<dyn Fn(Request) + Send>>>,
    early: Mutex<Vec<Request>>,
}

impl Inbox {
    fn dispatch(&self, r: Request) {
        let handler = self.handler.lock().unwrap();
        match &*handler {
            Some(f) => f(r),
            None => self.early.lock().unwrap().push(r),
        }
    }

    pub fn set_handler(&self, f: impl Fn(Request) + Send + 'static) {
        let mut handler = self.handler.lock().unwrap();
        for r in self.early.lock().unwrap().drain(..) {
            f(r);
        }
        *handler = Some(Box::new(f));
    }
}

static INBOX: std::sync::LazyLock<Inbox> = std::sync::LazyLock::new(Inbox::default);

/// Sends requests to `f` from now on, after any that came while the app started.
pub fn set_handler(f: impl Fn(Request) + Send + 'static) {
    INBOX.set_handler(f);
}

/// Answers calls on `conn`, on a thread of its own. `queue`: the name is another Hermes Chat's, so this one waits in
/// line and takes over once that one exits, as after an update's restart (update.rs `relaunch`).
pub fn serve(conn: Connection, queue: bool) {
    serve_into(conn, queue, &INBOX);
}

fn serve_into(conn: Connection, queue: bool, inbox: &'static Inbox) {
    std::thread::spawn(move || {
        if queue {
            use dbus::blocking::stdintf::org_freedesktop_dbus::RequestNameReply;
            match conn.request_name(NAME, false, false, false) {
                Ok(RequestNameReply::PrimaryOwner) | Ok(RequestNameReply::AlreadyOwner) => {}
                Ok(RequestNameReply::InQueue) => {
                    eprintln!("hermes-chat: another Hermes Chat is running; desktop shortcuts go to it until it closes")
                }
                Ok(_) => return eprintln!("hermes-chat: another Hermes Chat is running; desktop shortcuts go to it"),
                Err(e) => return eprintln!("hermes-chat: couldn't take {NAME}: {e}"),
            }
        }
        conn.start_receive(
            MatchRule::new_method_call(),
            Box::new(move |msg, conn| {
                if msg.msg_type() != MessageType::MethodCall {
                    return true;
                }
                let iface = msg.interface().map(|i| i.to_string());
                let member = msg.member().map(|m| m.to_string());
                let path = msg.path().map(|p| p.to_string());
                let reply = match (iface.as_deref(), member.as_deref(), path.as_deref()) {
                    (Some(IFACE) | None, Some("Screenshot"), Some(PATH)) => {
                        inbox.dispatch(Request::Screenshot);
                        msg.method_return()
                    }
                    (Some(IFACE) | None, Some(m @ ("Show" | "Toggle")), Some(PATH)) => {
                        let token = msg.read1::<&str>().ok().filter(|t| !t.is_empty()).map(str::to_owned);
                        inbox.dispatch(if m == "Show" { Request::Show { token } } else { Request::Toggle { token } });
                        msg.method_return()
                    }
                    (Some("org.freedesktop.DBus.Peer"), Some("Ping"), _) => msg.method_return(),
                    _ => msg.error(
                        &"org.freedesktop.DBus.Error.UnknownMethod".into(),
                        &std::ffi::CString::new("Hermes Chat only answers Screenshot, Show and Toggle.").unwrap(),
                    ),
                };
                use dbus::channel::Sender;
                let _ = conn.send(reply);
                true
            }),
        );
        loop {
            if let Err(e) = conn.process(Duration::from_secs(3600)) {
                return eprintln!("hermes-chat: desktop shortcuts stopped reaching this window: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peeking_preserves_a_request_until_a_live_window_acknowledges_it() {
        let requests = Requests::default();
        requests.ask();
        let first = requests.pending().unwrap();
        assert_eq!(requests.pending(), Some(first));
        requests.ask();
        let second = requests.pending().unwrap();
        assert_ne!(first, second);
        requests.acknowledge(first);
        assert_eq!(requests.pending(), Some(second));
        requests.acknowledge(second);
        assert_eq!(requests.pending(), None);
    }

    #[test]
    fn reads_what_the_command_line_asks_a_running_app_for() {
        let args = |a: &[&str]| std::iter::once("hermes-chat").chain(a.iter().copied()).map(str::to_owned).collect::<Vec<_>>();
        let tok = Some("t".to_owned());
        assert_eq!(request_of(args(&["--screenshot"]), tok.clone(), false), Some(Request::Screenshot));
        assert_eq!(request_of(args(&["--show"]), tok.clone(), false), Some(Request::Show { token: tok.clone() }));
        assert_eq!(request_of(args(&["--toggle"]), None, false), Some(Request::Toggle { token: None }));
        // A plain launch shows the running one; an update's restart starts anew.
        assert_eq!(request_of(args(&[]), None, false), Some(Request::Show { token: None }));
        assert_eq!(request_of(args(&[]), None, true), None);
        // Asked for explicitly, the running one is asked even from a restart.
        assert_eq!(request_of(args(&["--toggle"]), None, true), Some(Request::Toggle { token: None }));
    }

    fn private_bus() -> crate::portal::fake_portal::FakePortal {
        crate::portal::fake_portal::FakePortal::start(crate::portal::fake_portal::Behavior::Grant)
    }

    fn connect(address: &str) -> Connection {
        let mut ch = dbus::channel::Channel::open_private(address).unwrap();
        ch.register().unwrap();
        Connection::from(ch)
    }

    #[test]
    fn of_apps_starting_at_once_exactly_one_owns_the_name() {
        let bus = private_bus();
        let start = std::sync::Arc::new(std::sync::Barrier::new(8));
        let launches: Vec<_> = (0..8)
            .map(|_| {
                let (address, start) = (bus.address.clone(), start.clone());
                std::thread::spawn(move || {
                    let conn = connect(&address);
                    start.wait();
                    let owner = claim(&conn).unwrap();
                    // Kept alive until every launch has asked, as a running app keeps it.
                    std::thread::sleep(Duration::from_millis(500));
                    owner
                })
            })
            .collect();
        let owners = launches.into_iter().map(|t| t.join().unwrap()).filter(|o| *o).count();
        assert_eq!(owners, 1);
    }

    #[test]
    fn a_second_launch_reaches_the_first_while_it_is_still_starting() {
        let bus = private_bus();
        let first = connect(&bus.address);
        assert!(claim(&first).unwrap());
        let inbox: &'static Inbox = Box::leak(Box::default());
        serve_into(first, false, inbox);
        // The second launch can't take the name, so it asks the first, whose window isn't set up yet.
        let second = connect(&bus.address);
        assert!(!claim(&second).unwrap());
        send_on(&second, &Request::Show { token: Some("tok".into()) }).unwrap();
        send_on(&second, &Request::Toggle { token: None }).unwrap();
        // Once it is, it gets both, in order.
        let got = std::sync::Arc::new(Mutex::new(vec![]));
        let g = got.clone();
        inbox.set_handler(move |r| g.lock().unwrap().push(r));
        send_on(&second, &Request::Screenshot).unwrap();
        assert_eq!(
            *got.lock().unwrap(),
            vec![Request::Show { token: Some("tok".into()) }, Request::Toggle { token: None }, Request::Screenshot]
        );
    }

    #[test]
    fn an_unhandled_request_expires_after_two_minutes() {
        let requests = Requests::default();
        requests.ask();
        assert_eq!(
            requests.pending_at(Instant::now() + Duration::from_secs(120)),
            None
        );
    }
}
