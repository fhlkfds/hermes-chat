#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // An update's restart starts this copy while the old one is still exiting with the bus name, so it doesn't hand
    // itself over; the variable isn't passed on to anything this copy starts.
    let restarted = std::env::var_os(hermes_chat::remote::RESTARTED).is_some();
    std::env::remove_var(hermes_chat::remote::RESTARTED);
    // `hermes-chat --screenshot` from a desktop shortcut: the Hermes Chat already running takes the screenshot.
    let screenshot = hermes_chat::remote::asked(std::env::args());
    if screenshot && hermes_chat::remote::forward().is_ok() {
        return;
    }
    // Launching it again brings back the window already open, hidden to the tray or not (ADR 0034).
    if !screenshot && !restarted && hermes_chat::remote::show().is_ok() {
        return;
    }
    hermes_chat::run(screenshot)
}
