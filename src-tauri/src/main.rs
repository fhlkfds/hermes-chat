#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // A chat link the desktop opened (`hermes-chat %u`): the Hermes Chat already running opens it, and this one exits.
    let link = hermes_chat::links::from_args(std::env::args());
    if let Some(link) = &link {
        if hermes_chat::remote::forward_link(link).is_ok() {
            return;
        }
    }
    // `hermes-chat --screenshot` from a desktop shortcut: the Hermes Chat already running takes the screenshot.
    let screenshot = hermes_chat::remote::asked(std::env::args());
    if screenshot && hermes_chat::remote::forward().is_ok() {
        return;
    }
    hermes_chat::run(screenshot, link)
}
