#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    use hermes_chat::remote;
    // An update's restart starts a new app while the old one is still exiting (update.rs); it must not just ask that
    // one to show itself. Not passed on to what the app starts.
    let new_instance = std::env::var_os(remote::NEW_INSTANCE).is_some();
    std::env::remove_var(remote::NEW_INSTANCE);
    // The desktop's activation token for this launch, handed on so the running window may take focus.
    let token = ["XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID"].iter().find_map(|v| std::env::var(v).ok().filter(|t| !t.is_empty()));
    // `hermes-chat --screenshot`, `--show` or `--toggle` from a desktop shortcut, a chat link the desktop opened
    // (`hermes-chat %u`), or a plain launch: the Hermes Chat already running does it, so there is only one.
    let screenshot = remote::asked(std::env::args());
    // Kept for this app's own window if it is the one that starts (links.rs).
    let link = hermes_chat::links::from_args(std::env::args());
    if remote::hand_over(remote::request_of(std::env::args(), token, new_instance)) {
        return;
    }
    hermes_chat::run(screenshot, link)
}
