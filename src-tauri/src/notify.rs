//! Desktop notifications, straight over the freedesktop Notifications D-Bus service that mako, dunst and swaync
//! provide. Clicking one brings the app's window forward, with the Wayland activation token the service hands over,
//! so the compositor lets it take focus.

use dbus::arg::{PropMap, Variant};
use dbus::blocking::Connection;
use dbus::message::MatchRule;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const SERVICE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const CALL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a click on a notification still brings the app forward. Most services close it well before then.
const CLICKABLE_FOR: Duration = Duration::from_secs(30 * 60);

enum Signal {
    Token(u32, String),
    Action(u32, String),
    Closed(u32),
}

/// Shows a notification. Rejects when there is no notification service, or it refuses; the click is waited for on a
/// thread of its own.
pub async fn show(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let (posted, outcome) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let (signals, received) = mpsc::channel();
        let shown = post(&title, &body, signals);
        let (conn, id) = match shown {
            Ok(shown) => shown,
            Err(e) => {
                let _ = posted.send(Err(e.to_string()));
                return;
            }
        };
        let _ = posted.send(Ok(()));
        let deadline = Instant::now() + CLICKABLE_FOR;
        let mut token = None;
        while Instant::now() < deadline && conn.process(Duration::from_secs(1)).is_ok() {
            for s in received.try_iter() {
                match s {
                    Signal::Token(n, t) if n == id => token = Some(t),
                    Signal::Action(n, key) if n == id && key == "default" => return focus(&app, token),
                    Signal::Closed(n) if n == id => return,
                    _ => {}
                }
            }
        }
    });
    outcome.await.map_err(|_| "The notification thread ended.".to_owned())?
}

/// Listens for what happens to notifications, then posts this one; listening first means no signal is missed.
fn post(title: &str, body: &str, signals: mpsc::Sender<Signal>) -> Result<(Connection, u32), dbus::Error> {
    let conn = Connection::new_session()?;
    let rule = |member: &'static str| MatchRule::new_signal(SERVICE, member).with_path(PATH);
    let tx = signals.clone();
    conn.add_match(rule("ActivationToken"), move |(id, t): (u32, String), _, _| tx.send(Signal::Token(id, t)).is_ok())?;
    let tx = signals.clone();
    conn.add_match(rule("ActionInvoked"), move |(id, key): (u32, String), _, _| tx.send(Signal::Action(id, key)).is_ok())?;
    conn.add_match(rule("NotificationClosed"), move |(id, _): (u32, u32), _, _| signals.send(Signal::Closed(id)).is_ok())?;
    let mut hints = PropMap::new();
    hints.insert("desktop-entry".into(), Variant(Box::new("hermes-chat".to_owned())));
    let proxy = conn.with_proxy(SERVICE, PATH, CALL_TIMEOUT);
    let (id,): (u32,) = proxy.method_call(
        SERVICE,
        "Notify",
        ("Hermes Chat", 0u32, "", title, body, vec!["default", "Open Hermes Chat"], hints, -1i32),
    )?;
    Ok((conn, id))
}

/// Brings the window forward. With an activation token GTK presents it through xdg-activation, which Hyprland and
/// other Wayland compositors accept as the owner's own request.
fn focus(app: &AppHandle, token: Option<String>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let Some(token) = token else {
        let _ = window.set_focus();
        return;
    };
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        use gtk::prelude::GtkWindowExt;
        if let Ok(gtk) = w.gtk_window() {
            gtk.set_startup_id(&token);
            gtk.present();
        }
    });
}
