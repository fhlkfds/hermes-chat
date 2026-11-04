//! The Repository screen's helper (repo_git_helper.py), run as the server runs it: the exact remote command string
//! through `sh -c`, against real Git repositories in a temporary folder. Only ssh itself is left out.

use hermes_chat::repo_git::{self, DiffSide, RepoError, Request};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use tokio::process::Command;

struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("hc-repo-{name}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        Dir(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn s(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = StdCommand::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success() || args[0] == "merge", "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn write(dir: &Path, name: &str, body: &[u8]) {
    let p = dir.join(name);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(p, body).unwrap();
}

/// A repository with one commit on `main`.
fn repo(name: &str) -> Dir {
    let d = Dir::new(name);
    git(d.path(), &["init", "-q", "-b", "main"]);
    git(d.path(), &["config", "user.email", "owner@example.com"]);
    git(d.path(), &["config", "user.name", "Owner"]);
    write(d.path(), "notes.txt", b"one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "first"]);
    d
}

fn helper() -> Command {
    let mut c = Command::new("sh");
    c.arg("-c").arg(repo_git::remote_command());
    c.env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1");
    c
}

async fn ask(req: Request) -> Result<Value, RepoError> {
    repo_git::run(helper(), &req).await
}

async fn status(d: &Dir) -> Value {
    ask(Request::Status { repo: d.s() }).await.unwrap()
}

async fn diff(d: &Dir, path: &str, orig: Option<&str>, side: DiffSide, context: u32) -> Value {
    ask(Request::Diff { repo: d.s(), path: path.into(), orig_path: orig.map(Into::into), side, context }).await.unwrap()
}

fn entry<'a>(s: &'a Value, path: &str) -> &'a Value {
    s["entries"].as_array().unwrap().iter().find(|e| e["path"] == path).unwrap_or_else(|| panic!("no {path} in {s}"))
}

fn kind(e: RepoError) -> String {
    serde_json::to_value(e).unwrap()["kind"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn staged_and_unstaged_changes_in_one_file_have_their_own_diffs() {
    let d = repo("both");
    write(d.path(), "notes.txt", b"one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    git(d.path(), &["add", "notes.txt"]);
    write(d.path(), "notes.txt", b"one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n");

    let s = status(&d).await;
    let e = entry(&s, "notes.txt");
    assert_eq!((e["x"].as_str(), e["y"].as_str()), (Some("M"), Some("M")));
    assert_eq!(e["staged"], serde_json::json!([1, 1]));
    assert_eq!(e["unstaged"], serde_json::json!([1, 1]));
    assert_eq!(s["top"], Value::String(std::fs::canonicalize(d.path()).unwrap().to_string_lossy().into_owned()));
    assert_eq!(s["branch"]["head"], "main");

    let staged = diff(&d, "notes.txt", None, DiffSide::Staged, 1).await;
    let staged = staged["diff"].as_str().unwrap();
    assert!(staged.contains("+TWO") && !staged.contains("NINE"), "{staged}");
    let unstaged = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1).await;
    let unstaged = unstaged["diff"].as_str().unwrap();
    assert!(unstaged.contains("+NINE") && !unstaged.contains("+TWO"), "{unstaged}");
    // One line of context, as asked.
    assert!(unstaged.contains("@@ -8,3 +8,3 @@"), "{unstaged}");
}

#[tokio::test]
async fn the_context_asked_for_is_the_context_shown() {
    let d = repo("context");
    write(d.path(), "notes.txt", b"one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\n");
    let none = diff(&d, "notes.txt", None, DiffSide::Unstaged, 0).await;
    assert!(none["diff"].as_str().unwrap().contains("@@ -5 +5 @@"));
    let all = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1_000_000).await;
    assert!(all["diff"].as_str().unwrap().contains("@@ -1,10 +1,10 @@"));
}

#[tokio::test]
async fn untracked_and_binary_files_are_marked() {
    let d = repo("binary");
    write(d.path(), "logo.bin", b"\x89PNG\x00\x01\x02");
    git(d.path(), &["add", "logo.bin"]);
    git(d.path(), &["commit", "-qm", "logo"]);
    write(d.path(), "logo.bin", b"\x89PNG\x00\x03\x04");
    write(d.path(), "new/blob.dat", b"\x00\x00\x00");
    write(d.path(), "new/readme.md", b"# hi\n");

    let s = status(&d).await;
    let logo = entry(&s, "logo.bin");
    assert_eq!(logo["unstaged"], Value::Null, "binary has no line counts: {logo}");
    assert_eq!(entry(&s, "new/blob.dat")["binary"], true);
    assert_eq!(entry(&s, "new/readme.md")["binary"], false);
    assert_eq!(entry(&s, "new/readme.md")["kind"], "untracked");

    let d1 = diff(&d, "logo.bin", None, DiffSide::Unstaged, 3).await;
    assert!(d1["diff"].as_str().unwrap().contains("Binary files a/logo.bin and b/logo.bin differ"));
    let d2 = diff(&d, "new/readme.md", None, DiffSide::Untracked, 3).await;
    let t = d2["diff"].as_str().unwrap();
    assert!(t.contains("new file mode") && t.contains("+# hi"), "{t}");
}

#[tokio::test]
async fn a_staged_rename_keeps_its_old_path() {
    let d = repo("rename");
    git(d.path(), &["mv", "notes.txt", "docs.txt"]);
    let s = status(&d).await;
    let e = entry(&s, "docs.txt");
    assert_eq!(e["kind"], "renamed");
    assert_eq!(e["origPath"], "notes.txt");
    assert!(s["entries"].as_array().unwrap().iter().all(|e| e["path"] != "notes.txt"));
    let t = diff(&d, "docs.txt", Some("notes.txt"), DiffSide::Staged, 3).await;
    let t = t["diff"].as_str().unwrap();
    assert!(t.contains("rename from notes.txt") && t.contains("rename to docs.txt"), "{t}");
}

#[tokio::test]
async fn a_merge_conflict_is_reported_with_its_stages() {
    let d = repo("conflict");
    git(d.path(), &["checkout", "-qb", "other"]);
    write(d.path(), "notes.txt", b"one\nOTHER\n");
    git(d.path(), &["commit", "-qam", "other"]);
    git(d.path(), &["checkout", "-q", "main"]);
    write(d.path(), "notes.txt", b"one\nMAIN\n");
    git(d.path(), &["commit", "-qam", "main"]);
    git(d.path(), &["merge", "-q", "other"]);

    let s = status(&d).await;
    assert_eq!(s["operation"], "merge");
    let e = entry(&s, "notes.txt");
    assert_eq!(e["kind"], "unmerged");
    assert_eq!((e["x"].as_str(), e["y"].as_str()), (Some("U"), Some("U")));
    let c = diff(&d, "notes.txt", None, DiffSide::Conflict, 3).await;
    assert!(c["diff"].as_str().unwrap().contains("diff --cc notes.txt"));
    assert_eq!(c["stages"], serde_json::json!([1, 2, 3]));
}

#[tokio::test]
async fn paths_are_literal_never_patterns() {
    let d = repo("literal");
    write(d.path(), "a.txt", b"a\n");
    write(d.path(), "b.txt", b"b\n");
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "two"]);
    write(d.path(), "a.txt", b"A\n");
    write(d.path(), "b.txt", b"B\n");
    // A file really called "*.txt" is untracked; the pattern must not reach a.txt or b.txt.
    write(d.path(), "*.txt", b"star\n");
    let star = diff(&d, "*.txt", None, DiffSide::Untracked, 3).await;
    let t = star["diff"].as_str().unwrap();
    assert!(t.contains("+star") && !t.contains("a.txt") && !t.contains("b.txt"), "{t}");
    let tracked = ask(Request::Diff { repo: d.s(), path: "*.txt".into(), orig_path: None, side: DiffSide::Unstaged, context: 3 }).await.unwrap();
    assert_eq!(tracked["diff"], "", "an unstaged diff of '*.txt' is empty, not a.txt and b.txt");
}

#[tokio::test]
async fn ahead_and_behind_come_from_the_upstream() {
    let remote = Dir::new("bare");
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    let d = repo("ahead");
    git(d.path(), &["remote", "add", "origin", &remote.s()]);
    git(d.path(), &["push", "-qu", "origin", "main"]);
    write(d.path(), "notes.txt", b"changed\n");
    git(d.path(), &["commit", "-qam", "local"]);
    let s = status(&d).await;
    assert_eq!(s["branch"]["upstream"], "origin/main");
    assert_eq!(s["branch"]["ahead"], 1);
    assert_eq!(s["branch"]["behind"], 0);
}

#[tokio::test]
async fn bad_folders_are_told_apart() {
    let plain = Dir::new("plain");
    assert_eq!(kind(ask(Request::Status { repo: plain.s() }).await.unwrap_err()), "not-repo");
    assert_eq!(kind(ask(Request::Status { repo: format!("{}/missing", plain.s()) }).await.unwrap_err()), "not-found");
    assert_eq!(kind(ask(Request::Status { repo: "relative/path".into() }).await.unwrap_err()), "bad-path");
    let d = repo("gone");
    let gone = ask(Request::Diff { repo: d.s(), path: "nope.txt".into(), orig_path: None, side: DiffSide::Untracked, context: 3 }).await;
    assert_eq!(kind(gone.unwrap_err()), "stale");
}

#[tokio::test]
async fn what_a_login_script_prints_first_is_ignored() {
    let d = repo("noise");
    let mut c = Command::new("sh");
    c.arg("-c").arg(format!("echo 'Welcome {{\"ok\": false}}'; {}", repo_git::remote_command()));
    let s = repo_git::run(c, &Request::Status { repo: d.s() }).await.unwrap();
    assert_eq!(s["branch"]["head"], "main");
}

#[tokio::test]
async fn a_server_without_python_is_unsupported() {
    let d = repo("nopython");
    let mut c = Command::new("/bin/sh");
    c.arg("-c").arg(repo_git::remote_command()).env("PATH", "/nonexistent");
    let e = repo_git::run(c, &Request::Status { repo: d.s() }).await.unwrap_err();
    assert_eq!(kind(e), "unsupported");
}
