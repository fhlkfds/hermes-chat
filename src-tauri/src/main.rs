#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `hermes-chat --screenshot` from a desktop shortcut: the Hermes Chat already running takes the screenshot.
    let screenshot = hermes_chat::remote::asked(std::env::args());
    if screenshot && hermes_chat::remote::forward().is_ok() {
        return;
    }
    hermes_chat::run(screenshot)
}
