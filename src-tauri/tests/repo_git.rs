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

#[tokio::test]
async fn paths_outside_the_checkout_are_refused() {
    let d = repo("outside");
    let elsewhere = Dir::new("outside-secret");
    write(elsewhere.path(), "secret.txt", b"not yours\n");
    std::os::unix::fs::symlink(elsewhere.path(), d.path().join("link")).unwrap();
    for path in ["../outside-secret/secret.txt", "link/secret.txt", "./notes.txt", "a//b", "/etc/passwd"] {
        let e = ask(Request::Diff { repo: d.s(), path: path.into(), orig_path: None, side: DiffSide::Untracked, context: 3 }).await.unwrap_err();
        assert_eq!(kind(e), "bad-path", "{path}");
    }
    // A link inside the checkout is still diffed, as a link: its target's name, never what it points at.
    let link = diff(&d, "link", None, DiffSide::Untracked, 3).await;
    assert!(!link["diff"].as_str().unwrap().contains("not yours"));
}

#[tokio::test]
async fn the_owners_diff_settings_dont_change_what_is_shown() {
    let d = repo("noprefix");
    git(d.path(), &["config", "diff.noprefix", "true"]);
    git(d.path(), &["config", "diff.external", "false"]);
    let t = diff(&d, "notes.txt", None, DiffSide::Unstaged, 3).await;
    assert_eq!(t["diff"], "", "no change yet");
    git(d.path(), &["config", "--unset", "diff.noprefix"]);
    git(d.path(), &["config", "diff.srcPrefix", "x/nested/"]);
    git(d.path(), &["config", "diff.dstPrefix", "y/nested/"]);
    write(d.path(), "notes.txt", b"changed\n");
    let t = diff(&d, "notes.txt", None, DiffSide::Unstaged, 3).await;
    assert!(t["diff"].as_str().unwrap().contains("--- a/notes.txt\n+++ b/notes.txt"), "{}", t["diff"]);
}

// ── stage 2: staging and committing ─────────────────────────────────────────

use hermes_chat::repo_git::{Expect, FileStamp};

fn expect_of(v: &Value) -> Expect {
    Expect { head: v["head"].as_str().map(Into::into), index: v["index"].as_str().unwrap().into(), raw_sha: None }
}

fn stamp_of(s: &Value, path: &str) -> FileStamp {
    FileStamp { path: path.into(), worktree: entry(s, path)["worktree"].as_str().map(Into::into) }
}

fn staged_names(d: &Dir) -> String {
    git(d.path(), &["diff", "--cached", "--name-only"])
}

async fn preview(d: &Dir) -> Value {
    ask(Request::Preview { repo: d.s() }).await.unwrap()
}

async fn commit(d: &Dir, p: &Value, message: &str) -> Result<Value, RepoError> {
    let expect = Expect { raw_sha: p["rawSha"].as_str().map(Into::into), ..expect_of(p) };
    ask(Request::Commit { repo: d.s(), message: message.into(), expect }).await
}

fn hook(d: &Dir, name: &str, body: &str) {
    let p = d.path().join(".git/hooks").join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A repository with two changed files and an untracked one.
fn busy(name: &str) -> Dir {
    let d = repo(name);
    write(d.path(), "other.txt", b"a\n");
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "two files"]);
    write(d.path(), "notes.txt", b"one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    write(d.path(), "other.txt", b"b\n");
    write(d.path(), "new.txt", b"new\n");
    d
}

#[tokio::test]
async fn staging_takes_only_the_files_named() {
    let d = busy("stage-one");
    let s = status(&d).await;
    let r = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt"), stamp_of(&s, "new.txt")], expect: expect_of(&s) }).await.unwrap();
    assert_eq!(staged_names(&d), "new.txt\nnotes.txt");
    assert_ne!(r["index"], s["index"], "the new index stamp comes back");
}

#[tokio::test]
async fn a_file_changed_after_it_was_read_is_not_staged() {
    let d = busy("stage-stale-file");
    let s = status(&d).await;
    // Another agent writes to the file after the screen read it.
    write(d.path(), "notes.txt", b"rewritten by an agent\n");
    let e = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn nothing_is_staged_when_the_index_moved_meanwhile() {
    let d = busy("stage-stale-index");
    let s = status(&d).await;
    git(d.path(), &["add", "other.txt"]);
    let e = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(staged_names(&d), "other.txt");
}

#[tokio::test]
async fn a_deleted_file_is_staged_as_deleted() {
    let d = busy("stage-delete");
    std::fs::remove_file(d.path().join("other.txt")).unwrap();
    let s = status(&d).await;
    assert_eq!(entry(&s, "other.txt")["worktree"], Value::Null);
    ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "other.txt")], expect: expect_of(&s) }).await.unwrap();
    assert_eq!(git(d.path(), &["diff", "--cached", "--name-status"]), "D\tother.txt");
}

#[tokio::test]
async fn unstaging_leaves_the_working_tree_alone() {
    let d = busy("unstage");
    git(d.path(), &["add", "notes.txt", "other.txt"]);
    let s = status(&d).await;
    ask(Request::Unstage { repo: d.s(), paths: vec!["notes.txt".into()], expect: expect_of(&s) }).await.unwrap();
    assert_eq!(staged_names(&d), "other.txt");
    assert!(std::fs::read_to_string(d.path().join("notes.txt")).unwrap().contains("TWO"));
}

#[tokio::test]
async fn unstaging_works_before_the_first_commit() {
    let d = Dir::new("unborn");
    git(d.path(), &["init", "-q", "-b", "main"]);
    write(d.path(), "a.txt", b"a\n");
    git(d.path(), &["add", "a.txt"]);
    let s = status(&d).await;
    assert_eq!(s["head"], Value::Null);
    ask(Request::Unstage { repo: d.s(), paths: vec!["a.txt".into()], expect: expect_of(&s) }).await.unwrap();
    assert_eq!(staged_names(&d), "");
    assert!(d.path().join("a.txt").exists());
}

/// notes.txt with changes at its top and its bottom: two hunks with one line of context.
fn two_hunks(name: &str) -> Dir {
    let d = repo(name);
    write(d.path(), "notes.txt", b"ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
    d
}

#[tokio::test]
async fn one_hunk_can_be_staged_and_unstaged_on_its_own() {
    let d = two_hunks("hunk");
    let s = status(&d).await;
    let shown = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1).await;
    let text = shown["diff"].as_str().unwrap();
    assert_eq!(text.matches("\n@@").count(), 2, "{text}");
    ask(Request::Apply {
        repo: d.s(), path: "notes.txt".into(), hunks: vec![1], reverse: false, context: 1,
        diff_sha: shown["sha"].as_str().unwrap().into(), expect: expect_of(&s),
    })
    .await
    .unwrap();
    let cached = git(d.path(), &["diff", "--cached"]);
    assert!(cached.contains("+TEN") && !cached.contains("+ONE"), "{cached}");
    let unstaged = git(d.path(), &["diff"]);
    assert!(unstaged.contains("+ONE") && !unstaged.contains("+TEN"), "{unstaged}");

    // And back out of the index, from the staged diff.
    let s = status(&d).await;
    let staged = diff(&d, "notes.txt", None, DiffSide::Staged, 1).await;
    ask(Request::Apply {
        repo: d.s(), path: "notes.txt".into(), hunks: vec![0], reverse: true, context: 1,
        diff_sha: staged["sha"].as_str().unwrap().into(), expect: expect_of(&s),
    })
    .await
    .unwrap();
    assert_eq!(staged_names(&d), "");
    assert!(std::fs::read_to_string(d.path().join("notes.txt")).unwrap().contains("TEN"), "the working tree keeps it");
}

#[tokio::test]
async fn a_hunk_from_a_diff_with_no_context_applies_too() {
    let d = two_hunks("hunk-zero");
    let s = status(&d).await;
    let shown = diff(&d, "notes.txt", None, DiffSide::Unstaged, 0).await;
    let text = shown["diff"].as_str().unwrap();
    assert!(text.contains("@@ -1 +1 @@") && text.contains("@@ -10 +10 @@"), "{text}");
    ask(Request::Apply {
        repo: d.s(), path: "notes.txt".into(), hunks: vec![0], reverse: false, context: 0,
        diff_sha: shown["sha"].as_str().unwrap().into(), expect: expect_of(&s),
    })
    .await
    .unwrap();
    let cached = git(d.path(), &["diff", "--cached"]);
    assert!(cached.contains("+ONE") && !cached.contains("+TEN"), "{cached}");
}

#[tokio::test]
async fn a_hunk_from_a_diff_that_changed_is_refused() {
    let d = two_hunks("hunk-stale");
    let s = status(&d).await;
    let shown = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1).await;
    write(d.path(), "notes.txt", b"ONE\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nTEN\n");
    let e = ask(Request::Apply {
        repo: d.s(), path: "notes.txt".into(), hunks: vec![1], reverse: false, context: 1,
        diff_sha: shown["sha"].as_str().unwrap().into(), expect: expect_of(&s),
    })
    .await
    .unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn the_preview_is_exactly_what_the_commit_holds() {
    let d = busy("commit");
    git(d.path(), &["add", "notes.txt"]);
    git(d.path(), &["mv", "other.txt", "renamed.txt"]);
    let p = preview(&d).await;
    let files: Vec<_> = p["files"].as_array().unwrap().iter().map(|f| format!("{} {}", f["status"].as_str().unwrap(), f["path"].as_str().unwrap())).collect();
    assert_eq!(files, ["M notes.txt", "D other.txt", "A renamed.txt"]);
    assert_eq!(p["renames"]["renamed.txt"]["from"], "other.txt");
    assert!(p["diff"].as_str().unwrap().contains("+TWO"));
    assert_eq!(p["author"], "Owner <owner@example.com>");
    let before = git(d.path(), &["rev-parse", "HEAD"]);

    let message = "Shout the second line\n\nAnd rename other.txt.\n# kept verbatim\n";
    let c = commit(&d, &p, message).await.unwrap();
    assert_eq!(c["matches"], true);
    assert_eq!(git(d.path(), &["rev-parse", "HEAD^"]), before);
    assert_eq!(git(d.path(), &["log", "-1", "--format=%B"]), message.trim_end());
    // What wasn't staged stayed out: the moved file's unstaged edit, and the untracked file.
    assert_eq!(git(d.path(), &["status", "--porcelain"]), "M renamed.txt\n?? new.txt");
}

#[tokio::test]
async fn a_concurrent_change_to_the_index_stops_the_commit() {
    let d = busy("commit-race-index");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    // Another agent stages a file between the preview and Commit.
    git(d.path(), &["add", "new.txt"]);
    let before = git(d.path(), &["rev-parse", "HEAD"]);
    let e = commit(&d, &p, "Only notes").await.unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), before);
}

#[tokio::test]
async fn a_concurrent_commit_stops_the_commit() {
    let d = busy("commit-race-head");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    git(d.path(), &["commit", "-qm", "someone else"]);
    git(d.path(), &["add", "other.txt"]);
    let e = commit(&d, &p, "Mine").await.unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(git(d.path(), &["log", "-1", "--format=%s"]), "someone else");
}

#[tokio::test]
async fn a_failing_hook_refuses_the_commit_and_says_why() {
    let d = busy("commit-hook");
    hook(&d, "pre-commit", "echo 'lint: notes.txt has shouting' >&2\nexit 1");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    assert_eq!(p["hooks"], serde_json::json!(["pre-commit"]));
    let before = git(d.path(), &["rev-parse", "HEAD"]);
    let e = commit(&d, &p, "Shout").await.unwrap_err();
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["kind"], "hook");
    assert!(v["output"].as_str().unwrap().contains("lint: notes.txt has shouting"), "{v}");
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), before);
    assert_eq!(staged_names(&d), "notes.txt", "the staged change is still staged");
}

#[tokio::test]
async fn hook_output_is_kept_and_a_hook_that_changes_the_commit_is_reported() {
    let d = busy("commit-hook-adds");
    hook(&d, "pre-commit", "echo 'formatting'\ngit add other.txt");
    hook(&d, "post-commit", "echo 'post-commit ran'");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let c = commit(&d, &p, "Shout").await.unwrap();
    assert_eq!(c["matches"], false);
    let files: Vec<_> = c["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_owned()).collect();
    assert_eq!(files, ["notes.txt", "other.txt"]);
    let out = c["output"].as_str().unwrap();
    assert!(out.contains("formatting") && out.contains("post-commit ran"), "{out}");
}

#[tokio::test]
async fn nothing_staged_commits_nothing_rather_than_everything() {
    let d = busy("commit-empty");
    let p = preview(&d).await;
    assert_eq!(p["files"], serde_json::json!([]));
    let e = commit(&d, &p, "Everything?").await.unwrap_err();
    assert_eq!(kind(e), "nothing-staged");
    assert_eq!(git(d.path(), &["log", "--format=%s"]).lines().count(), 2);
}

#[tokio::test]
async fn a_missing_identity_is_its_own_failure() {
    let d = busy("commit-ident");
    git(d.path(), &["config", "--unset", "user.name"]);
    git(d.path(), &["config", "--unset", "user.email"]);
    git(d.path(), &["config", "user.useConfigOnly", "true"]);
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    assert_eq!(p["author"], Value::Null);
    assert_eq!(kind(commit(&d, &p, "Who?").await.unwrap_err()), "identity");
}

#[tokio::test]
async fn an_empty_message_is_refused() {
    let d = busy("commit-message");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    assert_eq!(kind(commit(&d, &p, "  \n").await.unwrap_err()), "empty-message");
}

#[tokio::test]
async fn a_hunk_that_isnt_there_is_refused() {
    let d = two_hunks("hunk-missing");
    let s = status(&d).await;
    let shown = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1).await;
    let e = ask(Request::Apply {
        repo: d.s(), path: "notes.txt".into(), hunks: vec![5], reverse: false, context: 1,
        diff_sha: shown["sha"].as_str().unwrap().into(), expect: expect_of(&s),
    })
    .await
    .unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn hunks_apply_under_the_owners_whitespace_and_prefix_settings() {
    let d = repo("hunk-config");
    git(d.path(), &["config", "diff.noprefix", "true"]);
    git(d.path(), &["config", "apply.whitespace", "error"]);
    write(d.path(), "notes.txt", b"one  \ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    let s = status(&d).await;
    let shown = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1).await;
    ask(Request::Apply {
        repo: d.s(), path: "notes.txt".into(), hunks: vec![0], reverse: false, context: 1,
        diff_sha: shown["sha"].as_str().unwrap().into(), expect: expect_of(&s),
    })
    .await
    .unwrap();
    assert!(git(d.path(), &["diff", "--cached"]).contains("+one  "), "staged exactly as shown, trailing spaces kept");
}

#[tokio::test]
async fn folders_and_submodules_are_never_staged_whole() {
    let d = busy("stage-folder");
    write(d.path(), "dir/secret.env", b"TOKEN=x\n");
    let s = status(&d).await;
    for path in ["dir", "src"] {
        std::fs::create_dir_all(d.path().join(path)).unwrap();
        let e = ask(Request::Stage { repo: d.s(), files: vec![FileStamp { path: path.into(), worktree: None }], expect: expect_of(&s) }).await.unwrap_err();
        assert_eq!(kind(e), "bad-path", "{path}");
    }
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn a_commit_during_a_merge_is_refused() {
    let d = repo("commit-merge");
    git(d.path(), &["checkout", "-qb", "other"]);
    write(d.path(), "notes.txt", b"one\nOTHER\n");
    git(d.path(), &["commit", "-qam", "other"]);
    git(d.path(), &["checkout", "-q", "main"]);
    write(d.path(), "notes.txt", b"one\nMAIN\n");
    git(d.path(), &["commit", "-qam", "main"]);
    git(d.path(), &["merge", "-q", "other"]);
    write(d.path(), "notes.txt", b"one\nBOTH\n");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let before = git(d.path(), &["rev-parse", "HEAD"]);
    assert_eq!(kind(commit(&d, &p, "Merge").await.unwrap_err()), "operation");
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), before);
}

#[tokio::test]
async fn a_commit_that_fails_for_another_reason_isnt_blamed_on_a_hook() {
    let d = busy("commit-not-hook");
    hook(&d, "pre-commit", "echo 'pre-commit: fine'");
    git(d.path(), &["config", "commit.gpgSign", "true"]);
    git(d.path(), &["config", "gpg.program", "false"]);
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let e = serde_json::to_value(commit(&d, &p, "Signed?").await.unwrap_err()).unwrap();
    assert_eq!(e["kind"], "git", "{e}");
    assert!(e["output"].as_str().unwrap().contains("gpg"), "{e}");
}

#[tokio::test]
async fn nothing_another_agent_stages_during_the_commit_gets_in() {
    let d = busy("commit-concurrent");
    // The hook plays an agent working in the same checkout: mid-commit it tries to stage new.txt in the real index.
    hook(&d, "pre-commit", "if env -u GIT_INDEX_FILE git add new.txt 2>/dev/null; then echo 'agent staged new.txt'; else echo 'agent blocked by the index lock'; fi");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let c = commit(&d, &p, "Only notes").await.unwrap();
    assert!(c["output"].as_str().unwrap().contains("agent blocked by the index lock"), "{c}");
    let files: Vec<_> = c["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_owned()).collect();
    assert_eq!(files, ["notes.txt"]);
    assert_eq!(c["matches"], true);
    assert!(!d.path().join(".git/index.lock").exists(), "the lock is let go");
    assert_eq!(git(d.path(), &["status", "--porcelain", "--", "new.txt"]), "?? new.txt");
}

#[tokio::test]
async fn a_held_index_lock_changes_nothing() {
    let d = busy("index-locked");
    let s = status(&d).await;
    std::fs::write(d.path().join(".git/index.lock"), b"").unwrap();
    let e = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap_err();
    assert_eq!(kind(e), "locked");
    assert!(d.path().join(".git/index.lock").exists(), "someone else's lock is left alone");
    std::fs::remove_file(d.path().join(".git/index.lock")).unwrap();
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn a_mode_change_after_reading_is_a_change() {
    use std::os::unix::fs::PermissionsExt;
    let d = busy("stage-chmod");
    let s = status(&d).await;
    std::fs::set_permissions(d.path().join("notes.txt"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let e = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap_err();
    assert_eq!(kind(e), "stale");
    // Read again, it stages with the mode it now has, and the bytes that were read.
    let s = status(&d).await;
    ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap();
    assert!(git(d.path(), &["ls-files", "--stage", "notes.txt"]).starts_with("100755 "));
    assert_eq!(git(d.path(), &["show", ":notes.txt"]), std::fs::read_to_string(d.path().join("notes.txt")).unwrap().trim_end());
}

#[tokio::test]
async fn a_deleted_file_is_still_staged_as_deleted_and_a_link_as_a_link() {
    let d = busy("stage-kinds");
    std::os::unix::fs::symlink("notes.txt", d.path().join("alias")).unwrap();
    let s = status(&d).await;
    ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "alias")], expect: expect_of(&s) }).await.unwrap();
    assert!(git(d.path(), &["ls-files", "--stage", "alias"]).starts_with("120000 "));
    assert_eq!(git(d.path(), &["show", ":alias"]), "notes.txt");
}

#[tokio::test]
async fn an_interrupted_commit_that_landed_leaves_the_index_matching_it() {
    use tokio::io::AsyncWriteExt;
    let d = busy("commit-interrupted");
    let marker = d.path().join(".git/post-commit-started");
    let pidfile = d.path().join(".git/post-commit-pid");
    // A formatter stages its change during the commit, then a slow post-commit hook keeps Git busy.
    hook(&d, "pre-commit", "printf 'formatted\\n' > notes.txt && git add notes.txt");
    hook(&d, "post-commit", &format!("echo $$ > '{}'; touch '{}'; sleep 30", pidfile.display(), marker.display()));
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let before = git(d.path(), &["rev-parse", "HEAD"]);
    let req = Request::Commit {
        repo: d.s(),
        message: "Interrupted".into(),
        expect: Expect { raw_sha: p["rawSha"].as_str().map(Into::into), ..expect_of(&p) },
    };
    let mut child = helper().stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(&serde_json::to_vec(&req).unwrap()).await.unwrap();
    drop(stdin);
    for _ in 0..200 {
        if marker.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(marker.exists(), "the post-commit hook started");
    // What a dropped ssh does: the helper gets a signal while Git is still in the post-commit hook.
    unsafe { libc::kill(child.id().unwrap() as i32, libc::SIGTERM) };
    let _ = child.wait().await;
    if let Ok(pid) = std::fs::read_to_string(&pidfile) {
        unsafe { libc::kill(pid.trim().parse().unwrap(), libc::SIGKILL) };
    }
    assert_ne!(git(d.path(), &["rev-parse", "HEAD"]), before, "the commit landed");
    assert_eq!(git(d.path(), &["show", "HEAD:notes.txt"]), "formatted");
    assert_eq!(git(d.path(), &["diff", "--cached", "--name-only"]), "", "the index matches the commit, with the hook's change");
    assert!(!d.path().join(".git/index.lock").exists(), "the lock is let go");
}

#[tokio::test]
async fn the_mode_staged_is_the_one_read_even_if_a_filter_changes_it() {
    let d = busy("stage-filter-chmod");
    std::fs::write(d.path().join(".git/info/attributes"), "notes.txt filter=chmodder\n").unwrap();
    // git status runs clean filters too, so the filter only changes the mode once the flag exists: during staging.
    git(d.path(), &["config", "filter.chmodder.clean", "sh -c '[ -e .git/chmod-now ] && chmod +x \"$1\"; cat' sh %f"]);
    let s = status(&d).await;
    assert!(!git(d.path(), &["ls-files", "--stage", "notes.txt"]).is_empty());
    std::fs::write(d.path().join(".git/chmod-now"), b"").unwrap();
    ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap();
    assert!(git(d.path(), &["ls-files", "--stage", "notes.txt"]).starts_with("100644 "), "{}", git(d.path(), &["ls-files", "--stage", "notes.txt"]));
    use std::os::unix::fs::PermissionsExt;
    assert!(std::fs::metadata(d.path().join("notes.txt")).unwrap().permissions().mode() & 0o111 != 0, "the filter did run");
}
