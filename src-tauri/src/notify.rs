//! Desktop notifications. Clicking one brings the app's window forward.
//!
//! On Linux they go straight over the freedesktop Notifications D-Bus service that mako, dunst and swaync provide, and
//! a click comes with the Wayland activation token the service hands over, so the compositor lets the window take
//! focus. On Windows they are toasts, shown under the app's AppUserModelID, which the installer puts on its Start menu
//! shortcut; a copy run without installing has no such shortcut, and Windows then shows nothing.

use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How long a click on a notification still brings the app forward. Most services close it well before then.
const CLICKABLE_FOR: Duration = Duration::from_secs(30 * 60);

/// Shows a notification. Rejects when there is no notification service, or it refuses; the click is waited for on a
/// thread of its own.
pub async fn show(app: AppHandle, title: String, body: String) -> Result<(), String> {
    desktop::show(app, title, body).await
}

/// Brings the window forward, with the desktop's activation token if it gave one.
fn focus(app: &AppHandle, token: Option<String>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let w = window.clone();
    let _ = window.run_on_main_thread(move || crate::summon::raise(&w, token));
}

/// A toast's content: the title and body as text, never markup.
#[cfg_attr(not(windows), allow(dead_code))]
fn toast_xml(title: &str, body: &str) -> String {
    let text = |s: &str| {
        s.chars().fold(String::with_capacity(s.len()), |mut out, c| {
            match c {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '"' => out.push_str("&quot;"),
                '\'' => out.push_str("&apos;"),
                // XML 1.0 can't carry other control characters at all.
                c if c.is_control() && !matches!(c, '\n' | '\t') => {}
                c => out.push(c),
            }
            out
        })
    };
    format!(
        r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
        text(title),
        text(body)
    )
}

#[cfg(target_os = "linux")]
mod desktop {
    use super::CLICKABLE_FOR;
    use dbus::arg::{PropMap, Variant};
    use dbus::blocking::Connection;
    use dbus::message::MatchRule;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use tauri::AppHandle;

    const SERVICE: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    const CALL_TIMEOUT: Duration = Duration::from_secs(5);

    enum Signal {
        Token(u32, String),
        Action(u32, String),
        Closed(u32),
    }

    pub(super) async fn show(app: AppHandle, title: String, body: String) -> Result<(), String> {
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
                        Signal::Action(n, key) if n == id && key == "default" => return super::focus(&app, token),
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
}

#[cfg(windows)]
mod desktop {
    use super::CLICKABLE_FOR;
    use std::sync::mpsc;
    use tauri::AppHandle;
    use windows::core::{Ref, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        ToastDismissalReason, ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification, ToastNotificationManager,
    };

    /// A development build has no Start menu shortcut of its own, so its toasts borrow PowerShell's, which every
    /// Windows has.
    const DEV_APP_ID: &str = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe";

    enum Event {
        Clicked,
        Gone,
    }

    pub(super) async fn show(app: AppHandle, title: String, body: String) -> Result<(), String> {
        let (posted, outcome) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let (events, received) = mpsc::channel();
            let toast = match post(&app, &title, &body, events) {
                Ok(toast) => toast,
                Err(e) => {
                    let _ = posted.send(Err(format!("Windows wouldn't show the notification: {}", e.message())));
                    return;
                }
            };
            let _ = posted.send(Ok(()));
            // The click handler lives as long as the toast does, so it is kept until clicked, closed or stale.
            if let Ok(Event::Clicked) = received.recv_timeout(CLICKABLE_FOR) {
                super::focus(&app, None);
            }
            drop(toast);
        });
        outcome.await.map_err(|_| "The notification thread ended.".to_owned())?
    }

    fn post(app: &AppHandle, title: &str, body: &str, events: mpsc::Sender<Event>) -> windows::core::Result<ToastNotification> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(super::toast_xml(title, body)))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        let tx = events.clone();
        toast.Activated(&TypedEventHandler::new(move |_, _| {
            let _ = tx.send(Event::Clicked);
            Ok(())
        }))?;
        let tx = events.clone();
        toast.Dismissed(&TypedEventHandler::new(
            move |_: Ref<ToastNotification>, args: Ref<ToastDismissedEventArgs>| {
                // A toast that timed out moves to the notification centre, where a click still counts.
                if args.ok().and_then(|a| a.Reason()).ok() != Some(ToastDismissalReason::TimedOut) {
                    let _ = tx.send(Event::Gone);
                }
                Ok(())
            },
        ))?;
        toast.Failed(&TypedEventHandler::new(move |_: Ref<ToastNotification>, _: Ref<ToastFailedEventArgs>| {
            let _ = events.send(Event::Gone);
            Ok(())
        }))?;
        let id = if tauri::is_dev() { DEV_APP_ID.to_owned() } else { app.config().identifier.clone() };
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(id))?.Show(&toast)?;
        Ok(toast)
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod desktop {
    pub(super) async fn show(_: tauri::AppHandle, _: String, _: String) -> Result<(), String> {
        Err("Desktop notifications aren't made on this system.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_toast_shows_its_text_as_text() {
        assert_eq!(
            toast_xml("Hermes <done>", "Tom & \"Jerry\"'s\u{7}\nnext"),
            "<toast><visual><binding template=\"ToastGeneric\"><text>Hermes &lt;done&gt;</text>\
             <text>Tom &amp; &quot;Jerry&quot;&apos;s\nnext</text></binding></visual></toast>"
        );
    }
}
