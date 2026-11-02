//! Which pages may use the microphone (src/media.rs).

use hermes_chat::media::is_app_page;
use url::Url;

fn url(s: &str) -> Url {
    Url::parse(s).unwrap()
}

#[test]
fn the_bundled_app_page_may_use_the_microphone() {
    for page in ["tauri://localhost/", "tauri://localhost/index.html?x=1#y"] {
        assert!(is_app_page(&url(page), None), "{page}");
    }
}

/// wry's `http(s)://tauri.localhost` form of the bundled page exists on Windows and Android only. On Linux that name is
/// any local service on loopback, and on no platform does another port count.
#[test]
fn tauri_localhost_over_http_counts_only_where_wry_serves_the_app_there() {
    let windows_like = cfg!(any(windows, target_os = "android"));
    for page in ["http://tauri.localhost/", "https://tauri.localhost/x"] {
        assert_eq!(is_app_page(&url(page), None), windows_like, "{page}");
    }
    for page in ["http://tauri.localhost:18121/", "https://tauri.localhost:4443/", "tauri://localhost:8080/"] {
        assert!(!is_app_page(&url(page), None), "{page}");
    }
}

#[test]
fn any_other_page_may_not() {
    let dev = url("http://localhost:1420/");
    for page in [
        "https://example.com/",
        "https://tauri.localhost.example.com/",
        "tauri://evil/",
        "http://localhost:1421/",
        "https://localhost:1420/",
        "http://127.0.0.1:1420/",
        "about:blank",
        "data:text/html,hi",
        "file:///home/liam/x.html",
    ] {
        assert!(!is_app_page(&url(page), Some(&dev)), "{page}");
    }
}

#[test]
fn the_dev_server_counts_only_when_given() {
    let page = url("http://localhost:1420/some/route?x=1");
    assert!(is_app_page(&page, Some(&url("http://localhost:1420/"))));
    assert!(!is_app_page(&page, None));
}
