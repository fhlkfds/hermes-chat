//! Web pages in the Preview on Linux (ADR 0081): a WebKitGTK view of their own, laid over the Preview pane where the
//! frame was (ADR 0007). The page is the top level of its view, so a site that refuses framing (`X-Frame-Options`,
//! CSP `frame-ancestors`) shows.
//!
//! The view isn't Tauri's. Tauri puts its IPC bootstrap and the per-launch invoke key into every webview it makes, and
//! that key is what keeps the app's own frames from its commands (ADR 0007). This view has no Tauri script, no IPC
//! handler and none of the app's URI schemes, and its web context is new and ephemeral: the page shares no storage
//! with the app, and its cookies last only while the app runs.
//!
//! The webview names the page and where it shows; Rust checks the address as the pane does (`web_page::web_url`).

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// A rectangle in the window's CSS pixels, which are GTK's logical pixels: the app's page is never zoomed.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where the page shows, and the parts of that the app's own layers cover (a menu, a dialog, a toast): the page
/// leaves those bare, so the layer shows and takes the pointer.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Placement {
    pub rect: Rect,
    #[serde(default)]
    pub holes: Vec<Rect>,
}

/// What the page says, sent to the webview as `{ kind, … }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PageEvent {
    /// The page's first response arrived, so it has something to show.
    Shown,
    /// It couldn't load, or its web process ended. The view hides; the pane says why.
    Failed { message: String },
}

/// A rectangle in whole pixels, `(x, y, width, height)`. Edges are rounded rather than sizes, so a rectangle and the
/// one beside it still meet.
pub fn pixels(r: &Rect) -> (i32, i32, i32, i32) {
    let (x0, y0) = (r.x.round(), r.y.round());
    let (x1, y1) = ((r.x + r.width).round(), (r.y + r.height).round());
    (x0 as i32, y0 as i32, (x1 - x0).max(0.0) as i32, (y1 - y0).max(0.0) as i32)
}

/// The holes of `placement`, in whole pixels from the page's own top-left corner, cut to the page. Holes that miss it
/// are left out.
pub fn holes_in_page(placement: &Placement) -> Vec<(i32, i32, i32, i32)> {
    let (px, py, pw, ph) = pixels(&placement.rect);
    placement
        .holes
        .iter()
        .filter_map(|hole| {
            let (hx, hy, hw, hh) = pixels(hole);
            let (x0, y0) = (hx.max(px), hy.max(py));
            let (x1, y1) = ((hx + hw).min(px + pw), (hy + hh).min(py + ph));
            (x1 > x0 && y1 > y0).then(|| (x0 - px, y0 - py, x1 - x0, y1 - y0))
        })
        .collect()
}

/// Shows `url` in the view, which is created the first time. `key` names this page from now on: a `place` or `close`
/// for any other key is ignored, so a page that went away can't move or close the next one.
pub fn open(app: &tauri::AppHandle, key: String, url: &str, on_event: Channel<PageEvent>) -> Result<(), String> {
    let url = crate::web_page::web_url(url)?;
    imp::open(app, key, url.to_string(), on_event)
}

/// Shows the page at `placement`, or hides it (`None`), if `key` is the page shown.
pub fn place(app: &tauri::AppHandle, key: String, placement: Option<Placement>) {
    imp::place(app, key, placement)
}

/// Hides the page and stops it, if `key` is the page shown (ADR 0039: a page runs only while it is on screen).
pub fn close(app: &tauri::AppHandle, key: String) {
    imp::close(app, key)
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::*;

    pub fn open(_: &tauri::AppHandle, _: String, _: String, _: Channel<PageEvent>) -> Result<(), String> {
        Err("Pages open in their own view only on Linux.".into())
    }
    pub fn place(_: &tauri::AppHandle, _: String, _: Option<Placement>) {}
    pub fn close(_: &tauri::AppHandle, _: String) {}
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use gtk::prelude::*;
    use std::cell::{Cell, RefCell};
    use tauri::Manager;
    use webkit2gtk::{LoadEvent, NetworkError, PermissionRequestExt, PolicyError, URIRequestExt, WebContextExt, WebViewExt};

    thread_local! {
        /// The overlay that holds Tauri's webview and the page's, and the page's view. Made on first use. The commands
        /// that touch them have no `async`, so Tauri runs them on the main thread, GTK's.
        static VIEW: RefCell<Option<(gtk::Overlay, webkit2gtk::WebView)>> = const { RefCell::new(None) };
        /// The page shown: its key, and where its events go.
        static PAGE: RefCell<Option<(String, Channel<PageEvent>)>> = const { RefCell::new(None) };
        /// Where the overlay puts the view, in whole pixels.
        static AT: Cell<(i32, i32, i32, i32)> = const { Cell::new((0, 0, 1, 1)) };
    }

    fn is_shown(key: &str) -> bool {
        PAGE.with(|p| p.borrow().as_ref().is_some_and(|(k, _)| k == key))
    }

    fn emit(event: PageEvent) {
        if let Some(channel) = PAGE.with(|p| p.borrow().as_ref().map(|(_, c)| c.clone())) {
            let _ = channel.send(event);
        }
    }

    pub fn open(app: &tauri::AppHandle, key: String, url: String, on_event: Channel<PageEvent>) -> Result<(), String> {
        let view = view(app).ok_or("Hermes Chat's window has no place for the page.")?;
        // The page before, if any, is replaced; its channel ends here.
        let before = PAGE.with(|p| p.replace(Some((key, on_event))));
        drop(before);
        view.hide();
        view.load_uri(&url);
        Ok(())
    }

    pub fn place(_: &tauri::AppHandle, key: String, placement: Option<Placement>) {
        let Some((overlay, view)) = VIEW.with(|v| v.borrow().clone()) else { return };
        if !is_shown(&key) {
            return;
        }
        let Some(placement) = placement else {
            view.hide();
            return;
        };
        AT.with(|at| at.set(pixels(&placement.rect)));
        view.show();
        overlay.queue_resize();
        let (_, _, width, height) = pixels(&placement.rect);
        // The overlay's window for the view, which it moves and sizes; realized by the show. Its shape clips the page
        // and passes the pointer through to the app's webview below.
        if let Some(window) = view.parent_window() {
            let shape = gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(0, 0, width, height));
            for (x, y, w, h) in holes_in_page(&placement) {
                let _ = shape.subtract_rectangle(&gtk::cairo::RectangleInt::new(x, y, w, h));
            }
            window.shape_combine_region(Some(&shape), 0, 0);
            window.input_shape_combine_region(&shape, 0, 0);
        }
    }

    pub fn close(_: &tauri::AppHandle, key: String) {
        if !is_shown(&key) {
            return;
        }
        let page = PAGE.with(|p| p.take());
        if let Some((_, view)) = VIEW.with(|v| v.borrow().clone()) {
            view.hide();
            view.load_uri("about:blank");
        }
        drop(page);
    }

    /// The page's view, made the first time from Tauri's webview. `with_webview` runs at once on the main thread,
    /// holding a lock that any Tauri call on that webview takes again (a channel's send or drop does), so nothing in it
    /// touches a channel.
    fn view(app: &tauri::AppHandle) -> Option<webkit2gtk::WebView> {
        if VIEW.with(|v| v.borrow().is_none()) {
            let window = app.get_webview_window("main")?;
            window.with_webview(|w| make_view(&w.inner())).ok()?;
        }
        VIEW.with(|v| v.borrow().as_ref().map(|(_, view)| view.clone()))
    }

    /// Moves Tauri's webview into an overlay and puts the page's view over it.
    fn make_view(main: &webkit2gtk::WebView) {
        let Some(parent) = main.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else { return };
        let overlay = gtk::Overlay::new();
        overlay.connect_get_child_position(|_, _| {
            let (x, y, w, h) = AT.with(Cell::get);
            Some(gtk::gdk::Rectangle::new(x, y, w, h))
        });
        // Taking the webview out of its box drops the window's keyboard focus, which Escape and every shortcut need.
        let focused = main.has_focus();
        parent.remove(main);
        overlay.add(main);
        parent.pack_start(&overlay, true, true, 0);
        overlay.show_all();
        if focused {
            main.grab_focus();
        }

        let context = webkit2gtk::WebContext::new_ephemeral();
        // Nothing is saved from the Preview: a download stops as soon as it starts.
        context.connect_download_started(|_, download| {
            use webkit2gtk::DownloadExt;
            download.cancel();
        });
        let view = webkit2gtk::WebView::with_context(&context);
        view.set_no_show_all(true);
        view.connect_load_changed(|view, event| {
            if event == LoadEvent::Committed && view.uri().is_some_and(|u| u != "about:blank") {
                emit(PageEvent::Shown);
            }
        });
        view.connect_load_failed(|_, _, uri, error| {
            // Cancelled: another load replaced it. Interrupted: a response became a download, which stops.
            let replaced = error.matches(NetworkError::Cancelled) || error.matches(PolicyError::FrameLoadInterruptedByPolicyChange);
            if !replaced && uri != "about:blank" {
                emit(PageEvent::Failed { message: error.message().to_owned() });
            }
            true
        });
        view.connect_web_process_terminated(|_, _| {
            emit(PageEvent::Failed { message: "The page stopped: WebKit's process for it ended.".into() });
        });
        view.connect_permission_request(|_, request| {
            request.deny();
            true
        });
        // A link the owner opens in a new window (target=_blank, or the page's menu) opens here instead.
        view.connect_create(|view, action| {
            if let Some(uri) = action.clone().request().and_then(|r| r.uri()) {
                if crate::web_page::web_url(&uri).is_ok() {
                    view.load_uri(&uri);
                }
            }
            None
        });
        overlay.add_overlay(&view);
        VIEW.with(|v| *v.borrow_mut() = Some((overlay, view)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn rounds_edges_so_neighbours_still_meet() {
        assert_eq!(pixels(&rect(800.6, 91.5, 479.4, 728.2)), (801, 92, 479, 728));
        let (left, right) = (rect(0.0, 0.0, 10.4, 5.0), rect(10.4, 0.0, 10.4, 5.0));
        let (lx, _, lw, _) = pixels(&left);
        let (rx, _, _, _) = pixels(&right);
        assert_eq!(lx + lw, rx);
    }

    #[test]
    fn holes_are_cut_to_the_page_and_measured_from_its_corner() {
        let placement = Placement {
            rect: rect(800.0, 100.0, 400.0, 600.0),
            holes: vec![
                // A toast across the page's left edge.
                rect(600.0, 600.0, 300.0, 40.0),
                // A dialog's backdrop over the whole window.
                rect(0.0, 0.0, 1280.0, 820.0),
                // A menu beside the page, not over it.
                rect(500.0, 100.0, 200.0, 300.0),
            ],
        };
        assert_eq!(holes_in_page(&placement), vec![(0, 500, 100, 40), (0, 0, 400, 600)]);
    }

    #[test]
    fn placement_reads_the_webviews_json() {
        let p: Placement = serde_json::from_str(r#"{"rect":{"x":1,"y":2,"width":3,"height":4}}"#).unwrap();
        assert_eq!(p, Placement { rect: rect(1.0, 2.0, 3.0, 4.0), holes: vec![] });
        assert_eq!(serde_json::to_value(PageEvent::Failed { message: "m".into() }).unwrap(), serde_json::json!({ "kind": "failed", "message": "m" }));
    }
}
