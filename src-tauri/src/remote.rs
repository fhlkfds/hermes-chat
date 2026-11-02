//! `hermes-chat --screenshot`, for a desktop shortcut that works while another window is focused. Wayland doesn't let
//! an app listen for keys it isn't focused for, so the owner binds a key in their desktop to run that command. It
//! asks the Hermes Chat already running, over the session bus, to take a screenshot; with none running, the app starts
//! and takes one once it is signed in. Either way the request waits in Rust until a signed-in window takes it, so one
//! made at the sign-in screen isn't lost (lib.rs, `screenshot_take_request`).
//!
//! The running app owns the bus name `net.l0cky12.HermesChat` and answers one method, `Screenshot`. Only this user's
//! own programs can reach their session bus, and a request only opens the picker: nothing is captured until the owner
//! picks, and nothing is sent until they send the message.

use dbus::blocking::Connection;
use dbus::channel::MatchingReceiver;
use dbus::message::{MatchRule, MessageType};
use std::time::Duration;

pub const NAME: &str = "net.l0cky12.HermesChat";
const PATH: &str = "/net/l0cky12/HermesChat";
const IFACE: &str = "net.l0cky12.HermesChat";
/// The event that tells the webview a desktop shortcut asked for a screenshot.
pub const EVENT: &str = "screenshot-requested";

/// The command line asks for a screenshot.
pub fn asked(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().skip(1).any(|a| a == "--screenshot")
}

/// Asks the running app for a screenshot. An error when no Hermes Chat is running (or the bus can't be reached).
pub fn forward() -> Result<(), dbus::Error> {
    let conn = Connection::new_session()?;
    conn.with_proxy(NAME, PATH, Duration::from_secs(5)).method_call(IFACE, "Screenshot", ())
}

/// Takes the bus name and answers `Screenshot` calls with `asked`, on a thread of its own. If another Hermes Chat
/// already has the name, the desktop shortcut goes to that one, and this one just doesn't listen.
pub fn serve(asked: impl Fn() + Send + 'static) {
    std::thread::spawn(move || {
        let conn = match Connection::new_session() {
            Ok(c) => c,
            Err(e) => return eprintln!("hermes-chat: no session bus, so the desktop screenshot shortcut won't reach this window: {e}"),
        };
        use dbus::blocking::stdintf::org_freedesktop_dbus::RequestNameReply;
        match conn.request_name(NAME, false, false, true) {
            Ok(RequestNameReply::PrimaryOwner) | Ok(RequestNameReply::AlreadyOwner) => {}
            Ok(_) => return eprintln!("hermes-chat: another Hermes Chat is running; the desktop screenshot shortcut goes to it"),
            Err(e) => return eprintln!("hermes-chat: couldn't take {NAME}: {e}"),
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
                        asked();
                        msg.method_return()
                    }
                    (Some("org.freedesktop.DBus.Peer"), Some("Ping"), _) => msg.method_return(),
                    _ => msg.error(
                        &"org.freedesktop.DBus.Error.UnknownMethod".into(),
                        &std::ffi::CString::new("Hermes Chat only answers Screenshot.").unwrap(),
                    ),
                };
                use dbus::channel::Sender;
                let _ = conn.send(reply);
                true
            }),
        );
        loop {
            if let Err(e) = conn.process(Duration::from_secs(3600)) {
                return eprintln!("hermes-chat: the desktop screenshot shortcut stopped listening: {e}");
            }
        }
    });
}
