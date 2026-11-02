//! Pasted files written to disk so they can be attached.

use hermes_chat::pasted;
use std::path::PathBuf;

fn scratch(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("hermes-chat-pasted-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[tokio::test]
async fn saves_each_paste_in_its_own_folder_under_its_name() {
    let dir = scratch("save");
    let a = pasted::save(&dir, "Pasted image.png", b"\x89PNG one").await.unwrap();
    let b = pasted::save(&dir, "Pasted image.png", b"\x89PNG two").await.unwrap();
    assert_ne!(a, b);
    assert_eq!(a.file_name().unwrap(), "Pasted image.png");
    assert_eq!(a.parent().unwrap().parent().unwrap(), dir);
    assert_eq!(std::fs::read(&a).unwrap(), b"\x89PNG one");
    assert_eq!(std::fs::read(&b).unwrap(), b"\x89PNG two");
}

#[tokio::test]
async fn keeps_a_name_from_climbing_out_of_its_folder() {
    let dir = scratch("climb");
    let up = pasted::save(&dir, "../../etc/notes.txt", b"hi").await.unwrap();
    assert_eq!(up.file_name().unwrap(), "notes.txt");
    assert_eq!(up.parent().unwrap().parent().unwrap(), dir);
    let blank = pasted::save(&dir, "..", b"hi").await.unwrap();
    assert_eq!(blank.file_name().unwrap(), "pasted");
}

#[tokio::test]
async fn clearing_keeps_todays_pastes() {
    let dir = scratch("clear");
    let kept = pasted::save(&dir, "notes.txt", b"hi").await.unwrap();
    pasted::clear_old(&dir).await;
    assert!(kept.exists());
    pasted::clear_old(&dir.join("missing")).await;
}
