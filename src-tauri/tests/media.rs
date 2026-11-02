//! Which pages may use the microphone (src/media.rs).

use hermes_chat::media::is_app_page;
use url::Url;

fn url(s: &str) -> Url {
    Url::parse(s).unwrap()
}

#[test]
fn the_bundled_app_page_may_use_the_microphone() {
    for page in ["tauri://localhost/", "tauri://localhost/index.html", "http://tauri.localhost/", "https://tauri.localhost/x"] {
        assert!(is_app_page(&url(page), None), "{page}");
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
