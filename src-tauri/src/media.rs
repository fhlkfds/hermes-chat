//! Which pages may use the microphone. Dictation (src/ui/Voice.tsx) is the only thing that records, and only from the
//! app's own page; a link in a reply can navigate the webview to any other site, which must not get the microphone.

use url::Url;

/// Whether `page` is the app itself, by exact origin: its bundled page, or in a dev build the Vite server it loads
/// from (`dev_url`). The bundled page is `tauri://localhost` on Linux and macOS; wry serves it as
/// `http(s)://tauri.localhost` on Windows and Android only, and on its default port, so that form counts nowhere else:
/// on Linux `tauri.localhost` is just a loopback name any local service can answer on.
pub fn is_app_page(page: &Url, dev_url: Option<&Url>) -> bool {
    let default_port = page.port().is_none();
    let bundled = match page.scheme() {
        "tauri" => page.host_str() == Some("localhost") && default_port,
        "http" | "https" if cfg!(any(windows, target_os = "android")) => page.host_str() == Some("tauri.localhost") && default_port,
        _ => false,
    };
    bundled || dev_url.is_some_and(|dev| dev.origin() == page.origin() && page.origin().is_tuple())
}
