//! This computer's clipboard text, for copy and paste with the Screen's Bot Desktop (ADR 0193). The Screen moves text
//! when the pointer or the focus crosses the screen, where the webview's `navigator.clipboard` refuses to read or
//! write. WebKitGTK refuses a read even during a key press (NotAllowedError, tried in the app), so GTK's clipboard is
//! read and written here instead, on the main thread it belongs to.

use std::time::Duration;
use tokio::sync::oneshot;

/// How long the clipboard's owner has to hand over its text.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

/// The clipboard's text. Empty when it holds none, or nothing owns it.
pub async fn read(app: &tauri::AppHandle) -> Result<String, String> {
    let (tx, rx) = oneshot::channel();
    app.run_on_main_thread(move || {
        gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).request_text(move |_, text| {
            let _ = tx.send(text.unwrap_or_default().to_owned());
        });
    })
    .map_err(|e| e.to_string())?;
    match tokio::time::timeout(ANSWER_TIMEOUT, rx).await {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(_)) => Err("The clipboard went away before it gave its text.".into()),
        Err(_) => Err(format!("The clipboard didn't give its text within {} seconds.", ANSWER_TIMEOUT.as_secs())),
    }
}

/// Puts `text` on the clipboard. GTK serves it to other apps from then on, while this one runs.
pub async fn write(app: &tauri::AppHandle, text: String) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    app.run_on_main_thread(move || {
        gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).set_text(&text);
        let _ = tx.send(());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "The app's main loop stopped before it set the clipboard.".to_owned())
}
