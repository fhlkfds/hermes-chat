//! Which pages may use the microphone. Dictation (src/ui/Voice.tsx) is the only thing that records, and only from the
//! app's own page; a link in a reply can navigate the webview to any other site, which must not get the microphone.

use url::Url;

/// Whether `page` is the app itself: its bundled page (`tauri://localhost`, or `http(s)://tauri.localhost` where wry
/// serves it that way), or in a dev build the Vite server it loads from (`dev_url`), compared by origin.
pub fn is_app_page(page: &Url, dev_url: Option<&Url>) -> bool {
    let bundled = match page.scheme() {
        "tauri" => page.host_str() == Some("localhost"),
        "http" | "https" => page.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    bundled || dev_url.is_some_and(|dev| dev.origin() == page.origin() && page.origin().is_tuple())
}
