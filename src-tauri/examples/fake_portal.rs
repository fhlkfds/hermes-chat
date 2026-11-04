//! A stand-in for the desktop portal's GlobalShortcuts interface on a private D-Bus, for portal.rs's tests and for
//! trying the Wayland path of the global shortcut on a machine without a desktop that has one. It is not the real
//! portal: it answers as the XDG GlobalShortcuts spec says, and grants, refuses or leaves the key unset on request.
//!
//! `cargo run --example fake_portal` starts a private bus, prints `DBUS_SESSION_BUS_ADDRESS=…`, then reads commands
//! from stdin: `grant`, `deny`, `notrigger` (how later binds are answered), `press` (the shortcut of the newest
//! session), `end` (the desktop ends the newest session), `restart` (the portal restarts), `sessions`, `quit`.

use dbus::arg::{PropMap, RefArg, Variant};
use dbus::blocking::Connection;
use dbus::channel::{Channel, MatchingReceiver, Sender};
use dbus::message::{MatchRule, MessageType};
use dbus::{Message, Path};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const DEST: &str = "org.freedesktop.portal.Desktop";
const OBJECT: &str = "/org/freedesktop/portal/desktop";
const IFACE: &str = "org.freedesktop.portal.GlobalShortcuts";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Behavior {
    /// Binds and says the key is the preferred one.
    Grant,
    /// The owner refuses in the desktop's dialog.
    Deny,
    /// Binds without setting a key, as Hyprland does.
    NoTrigger,
    /// The desktop has a portal but no GlobalShortcuts.
    NoInterface,
}

#[derive(Default)]
struct Shared {
    sessions: Vec<(String, String)>, // (session path, owner's unique name)
    triggers: Vec<String>,
    outbox: Vec<Message>,
    /// Asks the serving thread to give up the bus name and take it again, as a restarted portal does.
    restart: bool,
}

pub struct FakePortal {
    pub address: String,
    daemon: Child,
    behavior: Arc<Mutex<Behavior>>,
    shared: Arc<Mutex<Shared>>,
    _dir: TempDir,
}

struct TempDir(std::path::PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl FakePortal {
    pub fn start(behavior: Behavior) -> FakePortal {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("hermes-chat-fake-portal-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("bus.conf");
        std::fs::write(
            &config,
            format!(
                r#"<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir={}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>"#,
                dir.display()
            ),
        )
        .unwrap();
        let mut daemon = Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("dbus-daemon");
        let mut line = String::new();
        use std::io::BufRead;
        std::io::BufReader::new(daemon.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let address = line.trim().to_owned();
        let behavior = Arc::new(Mutex::new(behavior));
        let shared: Arc<Mutex<Shared>> = Arc::default();
        let (ready_tx, ready) = std::sync::mpsc::channel();
        {
            let (address, behavior, shared) = (address.clone(), behavior.clone(), shared.clone());
            std::thread::spawn(move || serve(&address, behavior, shared, ready_tx));
        }
        ready.recv_timeout(Duration::from_secs(10)).expect("fake portal ready");
        FakePortal { address, daemon, behavior, shared, _dir: TempDir(dir) }
    }

    pub fn set_behavior(&self, b: Behavior) {
        *self.behavior.lock().unwrap() = b;
    }

    pub fn preferred_triggers(&self) -> Vec<String> {
        self.shared.lock().unwrap().triggers.clone()
    }

    pub fn open_sessions(&self) -> Vec<String> {
        // Close calls are handled on the portal's thread; give one in flight a moment.
        std::thread::sleep(Duration::from_millis(300));
        self.shared.lock().unwrap().sessions.iter().map(|(s, _)| s.clone()).collect()
    }

    /// Emits a press of `id` in `session`, as the desktop does when the owner presses the key.
    pub fn press(&self, session: &str, id: &str, token: Option<&str>) {
        let mut shared = self.shared.lock().unwrap();
        let owner = shared.sessions.iter().find(|(s, _)| s == session).map(|(_, o)| o.clone());
        let mut options = PropMap::new();
        if let Some(t) = token {
            options.insert("activation_token".into(), Variant(Box::new(t.to_owned()) as Box<dyn RefArg>));
        }
        let mut m = Message::new_signal(OBJECT, IFACE, "Activated").unwrap().append3(Path::new(session.to_owned()).unwrap(), id, 0u64).append1(options);
        if let Some(o) = owner {
            m.set_destination(Some(o.into()));
        }
        shared.outbox.push(m);
    }

    /// Ends a session from the desktop's side: it is gone, and its owner is told with `Session.Closed`.
    pub fn end_session(&self, session: &str) {
        let mut shared = self.shared.lock().unwrap();
        let owner = shared.sessions.iter().find(|(s, _)| s == session).map(|(_, o)| o.clone());
        shared.sessions.retain(|(s, _)| s != session);
        let mut m = Message::new_signal(session.to_owned(), "org.freedesktop.portal.Session", "Closed").unwrap();
        if let Some(o) = owner {
            m.set_destination(Some(o.into()));
        }
        shared.outbox.push(m);
    }

    /// Gives up the portal's bus name and takes it again, dropping every session, as a portal restart does.
    pub fn restart(&self) {
        let mut shared = self.shared.lock().unwrap();
        shared.sessions.clear();
        shared.restart = true;
    }

    pub fn newest_session(&self) -> Option<String> {
        self.shared.lock().unwrap().sessions.last().map(|(s, _)| s.clone())
    }
}

impl Drop for FakePortal {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}

fn serve(address: &str, behavior: Arc<Mutex<Behavior>>, shared: Arc<Mutex<Shared>>, ready: std::sync::mpsc::Sender<()>) {
    let mut ch = Channel::open_private(address).unwrap();
    ch.register().unwrap();
    let conn = Connection::from(ch);
    conn.request_name(DEST, false, true, false).unwrap();
    let s = shared.clone();
    conn.start_receive(
        MatchRule::new_method_call(),
        Box::new(move |msg, conn| {
            if msg.msg_type() != MessageType::MethodCall {
                return true;
            }
            let b = *behavior.lock().unwrap();
            let sender = msg.sender().map(|s| s.to_string()).unwrap_or_default();
            let escaped = sender.trim_start_matches(':').replace('.', "_");
            let iface = msg.interface().map(|i| i.to_string()).unwrap_or_default();
            let member = msg.member().map(|m| m.to_string()).unwrap_or_default();
            let error = |name: &str, text: &str| msg.error(&name.into(), &std::ffi::CString::new(text).unwrap());
            let mut later = vec![];
            let reply = match (iface.as_str(), member.as_str()) {
                ("org.freedesktop.DBus.Properties", "Get") => {
                    let (i, p): (String, String) = msg.read2().unwrap_or_default();
                    if b == Behavior::NoInterface || i != IFACE || p != "version" {
                        error("org.freedesktop.DBus.Error.UnknownInterface", "No such interface")
                    } else {
                        msg.method_return().append1(Variant(1u32))
                    }
                }
                (IFACE, "CreateSession") if b != Behavior::NoInterface => {
                    let options: PropMap = msg.read1().unwrap_or_default();
                    let token = |k: &str| options.get(k).and_then(|v| v.0.as_str()).unwrap_or("t").to_owned();
                    let request = format!("{OBJECT}/request/{escaped}/{}", token("handle_token"));
                    let session = format!("{OBJECT}/session/{escaped}/{}", token("session_handle_token"));
                    s.lock().unwrap().sessions.push((session.clone(), sender.clone()));
                    let mut results = PropMap::new();
                    results.insert("session_handle".into(), Variant(Box::new(session) as Box<dyn RefArg>));
                    later.push(response(&request, &sender, 0, results));
                    msg.method_return().append1(Path::new(request).unwrap())
                }
                (IFACE, "BindShortcuts") if b != Behavior::NoInterface => {
                    let (_session, shortcuts, _parent, options): (Path, Vec<(String, PropMap)>, String, PropMap) = msg.read4().unwrap();
                    let token = options.get("handle_token").and_then(|v| v.0.as_str()).unwrap_or("b").to_owned();
                    let request = format!("{OBJECT}/request/{escaped}/{token}");
                    let mut listed: Vec<(String, PropMap)> = vec![];
                    for (id, props) in shortcuts {
                        let preferred = props.get("preferred_trigger").and_then(|v| v.0.as_str()).unwrap_or("").to_owned();
                        s.lock().unwrap().triggers.push(preferred.clone());
                        let mut out = PropMap::new();
                        out.insert("description".into(), Variant(Box::new(props.get("description").and_then(|v| v.0.as_str()).unwrap_or("").to_owned())));
                        let trigger = if b == Behavior::Grant { format!("Press {preferred}") } else { String::new() };
                        out.insert("trigger_description".into(), Variant(Box::new(trigger)));
                        listed.push((id, out));
                    }
                    let mut results = PropMap::new();
                    let code = if b == Behavior::Deny { 1 } else { 0 };
                    if code == 0 {
                        results.insert("shortcuts".into(), Variant(Box::new(listed) as Box<dyn RefArg>));
                    }
                    later.push(response(&request, &sender, code, results));
                    msg.method_return().append1(Path::new(request).unwrap())
                }
                ("org.freedesktop.portal.Session", "Close") => {
                    let path = msg.path().map(|p| p.to_string()).unwrap_or_default();
                    s.lock().unwrap().sessions.retain(|(p, _)| *p != path);
                    msg.method_return()
                }
                ("org.freedesktop.portal.Request", "Close") => msg.method_return(),
                _ => error("org.freedesktop.DBus.Error.UnknownMethod", "Unknown method"),
            };
            let _ = conn.send(reply);
            for m in later {
                let _ = conn.send(m);
            }
            true
        }),
    );
    let _ = ready.send(());
    loop {
        if conn.process(Duration::from_millis(50)).is_err() {
            return;
        }
        let (out, restart) = {
            let mut s = shared.lock().unwrap();
            (std::mem::take(&mut s.outbox), std::mem::take(&mut s.restart))
        };
        for m in out {
            let _ = conn.send(m);
        }
        if restart {
            let _ = conn.release_name(DEST);
            let _ = conn.request_name(DEST, false, true, false);
        }
    }
}

fn response(path: &str, to: &str, code: u32, results: PropMap) -> Message {
    let mut m = Message::new_signal(path.to_owned(), "org.freedesktop.portal.Request", "Response").unwrap().append2(code, results);
    m.set_destination(Some(to.to_owned().into()));
    m
}

#[allow(dead_code)]
fn main() {
    let portal = FakePortal::start(Behavior::Grant);
    println!("DBUS_SESSION_BUS_ADDRESS={}", portal.address);
    let stdin = std::io::stdin();
    let mut line = String::new();
    while { line.clear(); stdin.read_line(&mut line).map(|n| n > 0).unwrap_or(false) } {
        match line.trim() {
            "grant" => portal.set_behavior(Behavior::Grant),
            "deny" => portal.set_behavior(Behavior::Deny),
            "notrigger" => portal.set_behavior(Behavior::NoTrigger),
            "end" => match portal.newest_session() {
                Some(s) => portal.end_session(&s),
                None => eprintln!("no session"),
            },
            "restart" => portal.restart(),
            "press" => match portal.newest_session() {
                Some(s) => portal.press(&s, "hermes-chat", None),
                None => eprintln!("no session"),
            },
            "sessions" => println!("{:?} triggers={:?}", portal.open_sessions(), portal.preferred_triggers()),
            "quit" => break,
            other => eprintln!("unknown command: {other}"),
        }
    }
}
