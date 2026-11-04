#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    use hermes_chat::remote;
    // An update's restart starts a new app while the old one is still exiting (update.rs); it must not just ask that
    // one to show itself. Not passed on to what the app starts.
    let new_instance = std::env::var_os(remote::NEW_INSTANCE).is_some();
    std::env::remove_var(remote::NEW_INSTANCE);
    // The desktop's activation token for this launch, handed on so the running window may take focus.
    let token = ["XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID"].iter().find_map(|v| std::env::var(v).ok().filter(|t| !t.is_empty()));
    // `hermes-chat --screenshot`, `--show` or `--toggle` from a desktop shortcut, or a plain launch: the Hermes Chat
    // already running does it, so there is only one.
    let screenshot = remote::asked(std::env::args());
    let request = remote::request_of(std::env::args(), token, new_instance);
    match (dbus::blocking::Connection::new_session(), request) {
        // Taken atomically before there is a window, so two launches at once can't both open one.
        (Ok(conn), Some(request)) => match remote::claim(&conn) {
            Ok(true) => remote::serve(conn, false),
            Ok(false) => {
                if remote::send(&request).is_ok() {
                    return;
                }
                eprintln!("hermes-chat: the Hermes Chat already running didn't answer, so this one starts too");
                remote::serve(conn, true);
            }
            Err(e) => eprintln!("hermes-chat: couldn't ask the session bus for {}: {e}", remote::NAME),
        },
        // An update's restart, or a development copy: start, and take the name once the other one exits.
        (Ok(conn), None) => remote::serve(conn, true),
        (Err(e), _) => eprintln!("hermes-chat: no session bus, so desktop shortcuts won't reach this window: {e}"),
    }
    hermes_chat::run(screenshot)
}
