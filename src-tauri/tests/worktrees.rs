//! Managed worktrees (repo_worktrees_helper.py, ADR 0040), run as the server runs them: the exact remote command
//! string through `sh -c`, against real Git repositories in a temporary folder. Only ssh itself is left out.

use hermes_chat::repo_git::{self, ChatRef, RepoError, Request};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use tokio::process::Command;

/// A temporary folder holding the repository `repo/`, and so also the `repo.worktrees/` made beside it.
struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("hc-wt-{name}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(p.join("repo")).unwrap();
        Dir(p)
    }
    fn repo(&self) -> PathBuf {
        self.0.join("repo")
    }
    fn s(&self) -> String {
        self.repo().to_string_lossy().into_owned()
    }
    fn tree(&self, name: &str) -> PathBuf {
        self.0.join("repo.worktrees").join(name)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = StdCommand::new("chmod").args(["-R", "u+rwX"]).arg(&self.0).status();
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git_in(cwd: &Path, args: &[&str]) -> std::process::Output {
    StdCommand::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ALLOW_PROTOCOL", "file")
        .output()
        .unwrap()
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = git_in(cwd, args);
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn write(dir: &Path, name: &str, body: &str) {
    let p = dir.join(name);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap()
}

/// A repository with one commit on `main`, and `.env` ignored.
fn repo(name: &str) -> Dir {
    let d = Dir::new(name);
    let r = d.repo();
    git(&r, &["init", "-q", "-b", "main"]);
    git(&r, &["config", "user.email", "owner@example.com"]);
    git(&r, &["config", "user.name", "Owner"]);
    write(&r, "app.txt", "one\n");
    write(&r, ".gitignore", ".env\nnode_modules/\n");
    git(&r, &["add", "."]);
    git(&r, &["commit", "-qm", "first"]);
    d
}

fn commit(dir: &Path, file: &str, body: &str, msg: &str) -> String {
    write(dir, file, body);
    git(dir, &["add", "--", file]);
    git(dir, &["commit", "-qm", msg]);
    git(dir, &["rev-parse", "HEAD"])
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

fn kind(e: RepoError) -> String {
    serde_json::to_value(e).unwrap()["kind"].as_str().unwrap().to_owned()
}

const ID: &str = "0b5c1f3e-7a2d-4c61-9e0f-1a2b3c4d5e6f";
const ID2: &str = "1c6d2a4f-8b3e-4d72-af10-2b3c4d5e6f70";

fn plan_req(d: &Dir, branch: &str, new: bool, base: Option<&str>) -> Request {
    Request::WorktreePlan { repo: d.s(), branch: branch.into(), new_branch: new, base: base.map(Into::into) }
}

async fn plan(d: &Dir, branch: &str, new: bool, base: Option<&str>) -> Value {
    ask(plan_req(d, branch, new, base)).await.unwrap()
}

fn create_req(d: &Dir, id: &str, branch: &str, new: bool, base: Option<&str>, stamp: &str) -> Request {
    Request::WorktreeCreate {
        repo: d.s(),
        id: id.into(),
        branch: branch.into(),
        new_branch: new,
        base: base.map(Into::into),
        stamp: stamp.into(),
        by: "Hermes Chat on test".into(),
    }
}

/// Plans and makes a worktree on a new branch from `main`.
async fn made(d: &Dir, id: &str, branch: &str) -> Value {
    let p = plan(d, branch, true, Some("main")).await;
    ask(create_req(d, id, branch, true, Some("main"), p["stamp"].as_str().unwrap())).await.unwrap()
}

async fn list(d: &Dir) -> Value {
    ask(Request::WorktreeList { repo: d.s() }).await.unwrap()
}

fn row<'a>(l: &'a Value, path: &Path) -> &'a Value {
    let p = path.to_string_lossy();
    l["worktrees"].as_array().unwrap().iter().find(|w| w["path"] == *p).unwrap_or_else(|| panic!("no {p} in {l}"))
}

async fn removal(d: &Dir, id: &str) -> Value {
    ask(Request::WorktreeRemoval { repo: d.s(), id: id.into() }).await.unwrap()
}

async fn remove(d: &Dir, id: &str) -> Result<Value, RepoError> {
    let facts = removal(d, id).await;
    ask(Request::WorktreeRemove { repo: d.s(), id: id.into(), stamp: facts["stamp"].as_str().unwrap().into() }).await
}

fn chat(id: &str) -> ChatRef {
    ChatRef { scope: "https://hermes.test\ndefault".into(), chat: id.into(), title: "Fix login".into() }
}

#[tokio::test]
async fn a_new_branch_starts_at_the_base_beside_the_repository_and_is_locked_as_managed() {
    let d = repo("new");
    let main = git(&d.repo(), &["rev-parse", "HEAD"]);
    let p = plan(&d, "fix/login", true, Some("main")).await;
    assert_eq!(p["path"], d.tree("fix-login").to_string_lossy().as_ref());
    assert_eq!(p["baseSha"], main.as_str());
    assert_eq!(p["subject"], "first");
    let made = ask(create_req(&d, ID, "fix/login", true, Some("main"), p["stamp"].as_str().unwrap())).await.unwrap();
    assert_eq!(made["record"]["state"], "ready");
    let tree = d.tree("fix-login");
    assert_eq!(git(&tree, &["rev-parse", "HEAD"]), main);
    assert_eq!(git(&tree, &["branch", "--show-current"]), "fix/login");
    // --no-track: the new branch doesn't track the base, so a push can't go to main.
    assert!(!git_in(&tree, &["config", "branch.fix/login.merge"]).status.success());
    let l = list(&d).await;
    let w = row(&l, &tree);
    assert_eq!(w["record"]["id"], ID);
    assert_eq!(w["locked"], format!("hermes-chat {ID}"));
    assert_eq!(w["changes"]["untracked"], 0);
    // Never inside the repository, where Hermes's sweep removes idle trees.
    assert!(!d.repo().join(".worktrees").exists());
    // The record is beside the repository's Git data, not in any working tree.
    assert!(d.repo().join(".git/hermes-chat/worktrees.json").exists());
    assert_eq!(git(&d.repo(), &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn an_existing_branch_is_checked_out_as_it_is() {
    let d = repo("existing");
    git(&d.repo(), &["branch", "feature/a"]);
    let tip = commit(&d.repo(), "app.txt", "main moved\n", "main moves on");
    let p = plan(&d, "feature/a", false, None).await;
    assert_ne!(p["baseSha"], tip.as_str());
    ask(create_req(&d, ID, "feature/a", false, None, p["stamp"].as_str().unwrap())).await.unwrap();
    assert_eq!(read(&d.tree("feature-a"), "app.txt"), "one\n");
    // Checked out once only.
    assert_eq!(kind(ask(plan_req(&d, "feature/a", false, None)).await.unwrap_err()), "checked-out");
    assert_eq!(kind(ask(plan_req(&d, "main", false, None)).await.unwrap_err()), "checked-out");
}

#[tokio::test]
async fn names_and_refs_are_checked_before_anything_is_made() {
    let d = repo("names");
    git(&d.repo(), &["branch", "taken"]);
    assert_eq!(kind(ask(plan_req(&d, "taken", true, Some("main"))).await.unwrap_err()), "branch-exists");
    assert_eq!(kind(ask(plan_req(&d, "nope", false, None)).await.unwrap_err()), "no-branch");
    assert_eq!(kind(ask(plan_req(&d, "x", true, Some("no-such-ref"))).await.unwrap_err()), "bad-ref");
    assert_eq!(kind(ask(plan_req(&d, "x", true, Some("--output=/tmp/x"))).await.unwrap_err()), "bad-ref");
    assert_eq!(kind(ask(plan_req(&d, "-x", true, Some("main"))).await.unwrap_err()), "bad-branch");
    assert_eq!(kind(ask(plan_req(&d, "a..b", true, Some("main"))).await.unwrap_err()), "bad-branch");
    // Hermes's sweep deletes these once no worktree has them.
    assert_eq!(kind(ask(plan_req(&d, "pr-12", true, Some("main"))).await.unwrap_err()), "bad-branch");
    assert_eq!(kind(ask(plan_req(&d, "hermes/hermes-1a2b", true, Some("main"))).await.unwrap_err()), "bad-branch");
    // A folder already there is never made over.
    std::fs::create_dir_all(d.tree("busy")).unwrap();
    assert_eq!(kind(ask(plan_req(&d, "busy", true, Some("main"))).await.unwrap_err()), "path-exists");
    assert!(!d.0.join("repo.worktrees/x").exists());
}

#[tokio::test]
async fn a_dirty_source_checkout_keeps_its_changes_and_the_worktree_starts_clean() {
    let d = repo("dirty-source");
    write(&d.repo(), "app.txt", "edited, not committed\n");
    write(&d.repo(), "scratch.txt", "untracked\n");
    let p = plan(&d, "clean", true, Some("main")).await;
    assert_eq!(p["source"]["changed"], 1);
    assert_eq!(p["source"]["untracked"], 1);
    ask(create_req(&d, ID, "clean", true, Some("main"), p["stamp"].as_str().unwrap())).await.unwrap();
    let tree = d.tree("clean");
    assert_eq!(read(&tree, "app.txt"), "one\n");
    assert!(!tree.join("scratch.txt").exists());
    assert_eq!(read(&d.repo(), "app.txt"), "edited, not committed\n");
}

#[tokio::test]
async fn a_create_from_an_older_preview_is_refused() {
    let d = repo("stale-plan");
    let p = plan(&d, "late", true, Some("main")).await;
    commit(&d.repo(), "app.txt", "moved\n", "main moved");
    let e = ask(create_req(&d, ID, "late", true, Some("main"), p["stamp"].as_str().unwrap())).await.unwrap_err();
    assert_eq!(kind(e), "stale");
    assert!(!d.tree("late").exists());
    assert!(list(&d).await["unfinished"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_create_sent_again_after_its_answer_was_lost_finishes_the_same_worktree() {
    let d = repo("again");
    let p = plan(&d, "retry", true, Some("main")).await;
    let req = create_req(&d, ID, "retry", true, Some("main"), p["stamp"].as_str().unwrap());
    let first = ask(req.clone()).await.unwrap();
    // The plan's stamp is stale now (the folder exists), but the same id answers with the worktree it made.
    let again = ask(req).await.unwrap();
    assert_eq!(first["record"]["id"], again["record"]["id"]);
    let trees = git(&d.repo(), &["worktree", "list", "--porcelain"]);
    assert_eq!(trees.matches("worktree ").count(), 2);
}

#[tokio::test]
async fn a_create_cut_off_part_way_is_listed_and_finished_by_sending_it_again() {
    let d = repo("cut-off");
    let p = plan(&d, "half", true, Some("main")).await;
    let req = create_req(&d, ID, "half", true, Some("main"), p["stamp"].as_str().unwrap());
    ask(req.clone()).await.unwrap();
    // As if the connection dropped after `git worktree add` and before the lock and the record were finished.
    let file = d.repo().join(".git/hermes-chat/worktrees.json");
    let mut reg: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    reg["worktrees"][ID]["state"] = "creating".into();
    std::fs::write(&file, reg.to_string()).unwrap();
    git(&d.repo(), &["worktree", "unlock", d.tree("half").to_str().unwrap()]);
    let l = list(&d).await;
    assert_eq!(row(&l, &d.tree("half"))["record"]["state"], "creating");
    let done = ask(req).await.unwrap();
    assert_eq!(done["record"]["state"], "ready");
    assert_eq!(row(&list(&d).await, &d.tree("half"))["locked"], format!("hermes-chat {ID}"));

    // A record left with no worktree at all is listed as unfinished, and can be forgotten without touching anything.
    reg["worktrees"][ID2] = serde_json::json!({"id": ID2, "path": d.tree("ghost").to_string_lossy(), "branch": "ghost", "newBranch": true,
        "base": "main", "baseSha": git(&d.repo(), &["rev-parse", "HEAD"]), "setup": [], "state": "creating", "protected": false, "chats": [],
        "createdAt": 1, "createdBy": "t"});
    reg["worktrees"][ID]["state"] = "ready".into();
    std::fs::write(&file, reg.to_string()).unwrap();
    let l = list(&d).await;
    assert_eq!(l["unfinished"][0]["id"], ID2);
    ask(Request::WorktreeForget { repo: d.s(), id: ID2.into() }).await.unwrap();
    assert!(list(&d).await["unfinished"].as_array().unwrap().is_empty());
    // A worktree that's there can't be forgotten.
    assert_eq!(kind(ask(Request::WorktreeForget { repo: d.s(), id: ID.into() }).await.unwrap_err()), "stale");
}

#[tokio::test]
async fn setup_copies_ignored_files_once_skips_source_files_and_a_failed_step_can_be_retried() {
    let d = repo("setup");
    let r = d.repo();
    write(&r, ".env", "TOKEN=synthetic\n");
    write(&r, "node_modules/pkg/index.js", "module.exports = 1\n");
    write(&r, "local.cfg", "not ignored\n");
    write(&r, ".worktreeinclude", "# what a worktree needs\n.env\nnode_modules/\nlocal.cfg\napp.txt\n../outside\nmissing.txt\n");
    let made = made(&d, ID, "setup").await;
    let steps = made["record"]["setup"].as_array().unwrap().clone();
    let state = |i: usize| steps[i]["state"].as_str().unwrap().to_owned();
    assert_eq!((steps[0]["action"].as_str().unwrap(), state(0)), ("copy", "pending".into()));
    assert_eq!((steps[1]["action"].as_str().unwrap(), state(1)), ("link", "pending".into()));
    // Not ignored, so part of the source: never copied.
    for s in &steps[2..6] {
        assert_eq!(s["state"], "skipped", "{s}");
    }
    let tree = d.tree("setup");
    // A step that fails (its source can't be read) stays failed, with why, until it's tried again.
    StdCommand::new("chmod").args(["000"]).arg(r.join(".env")).status().unwrap();
    let after = ask(Request::WorktreeSetup { repo: d.s(), id: ID.into(), step: 0 }).await.unwrap();
    assert_eq!(after["record"]["setup"][0]["state"], "failed");
    assert!(after["record"]["setup"][0]["message"].as_str().unwrap().contains("ermission"));
    assert!(!tree.join(".env").exists());
    StdCommand::new("chmod").args(["600"]).arg(r.join(".env")).status().unwrap();
    let after = ask(Request::WorktreeSetup { repo: d.s(), id: ID.into(), step: 0 }).await.unwrap();
    assert_eq!(after["record"]["setup"][0]["state"], "done");
    assert_eq!(read(&tree, ".env"), "TOKEN=synthetic\n");
    let after = ask(Request::WorktreeSetup { repo: d.s(), id: ID.into(), step: 1 }).await.unwrap();
    assert_eq!(after["record"]["setup"][1]["state"], "done");
    assert!(std::fs::symlink_metadata(tree.join("node_modules")).unwrap().file_type().is_symlink());
    // Once: a step that's done isn't run again, even if its file changed since.
    write(&r, ".env", "TOKEN=changed\n");
    ask(Request::WorktreeSetup { repo: d.s(), id: ID.into(), step: 0 }).await.unwrap();
    assert_eq!(read(&tree, ".env"), "TOKEN=synthetic\n");
    // The copy is ignored. The link isn't, because `node_modules/` matches only a real folder; the step says so.
    assert_eq!(git(&tree, &["status", "--porcelain"]), "?? node_modules");
    assert!(after["record"]["setup"][1]["message"].as_str().unwrap().contains("untracked"));
}

#[tokio::test]
async fn removal_previews_files_and_commits_keeps_changes_in_a_ref_and_restore_puts_them_back() {
    let d = repo("remove-dirty");
    write(&d.repo(), ".env", "TOKEN=synthetic\n");
    write(&d.repo(), ".worktreeinclude", ".env\n");
    made(&d, ID, "work").await;
    let tree = d.tree("work");
    ask(Request::WorktreeSetup { repo: d.s(), id: ID.into(), step: 0 }).await.unwrap();
    let ahead = commit(&tree, "app.txt", "committed here\n", "unpushed work");
    write(&tree, "app.txt", "edited after\n");
    write(&tree, "new.txt", "untracked\n");
    let f = removal(&d, ID).await;
    assert!(f["blockers"].as_array().unwrap().is_empty(), "{f}");
    let files: Vec<_> = f["files"].as_array().unwrap().iter().map(|x| (x["status"].as_str().unwrap(), x["path"].as_str().unwrap())).collect();
    assert_eq!(files, [("changed", "app.txt"), ("untracked", "new.txt")]);
    assert_eq!(f["ignored"], serde_json::json!([".env"]));
    // No remote: every commit on the branch is unpushed. The branch is kept, so they are too.
    assert_eq!(f["unpushed"][0]["sha"], ahead.as_str());
    let done = remove(&d, ID).await.unwrap();
    assert!(!tree.exists());
    let kept = &done["record"]["removed"]["kept"];
    let reference = kept["ref"].as_str().unwrap();
    assert!(reference.starts_with(&format!("refs/hermes-chat/recovery/{ID}/")));
    // The branch is never deleted, and still holds the unpushed commit.
    assert_eq!(git(&d.repo(), &["rev-parse", "refs/heads/work"]), ahead);
    // The kept commit holds both changes, on top of the branch.
    assert_eq!(git(&d.repo(), &["show", &format!("{reference}:app.txt")]), "edited after");
    assert_eq!(git(&d.repo(), &["show", &format!("{reference}:new.txt")]), "untracked");
    assert_eq!(git(&d.repo(), &["rev-parse", &format!("{reference}^")]), ahead);
    let l = list(&d).await;
    assert_eq!(l["removed"][0]["id"], ID);

    let back = ask(Request::WorktreeRestore { repo: d.s(), id: ID.into() }).await.unwrap();
    assert_eq!(back["record"]["state"], "ready");
    assert_eq!(read(&tree, "app.txt"), "edited after\n");
    assert_eq!(read(&tree, "new.txt"), "untracked\n");
    assert_eq!(git(&tree, &["rev-parse", "HEAD"]), ahead);
    assert_eq!(row(&list(&d).await, &tree)["locked"], format!("hermes-chat {ID}"));
    // The setup's ignored copy went with the folder, so its step is to run again.
    assert_eq!(back["record"]["setup"][0]["state"], "pending");
    assert!(!tree.join(".env").exists());
    // The ref stays: nothing kept is ever deleted.
    assert_eq!(git(&d.repo(), &["rev-parse", reference]), kept["commit"].as_str().unwrap());
}

#[tokio::test]
async fn a_clean_worktree_is_removed_without_a_recovery_ref() {
    let d = repo("remove-clean");
    made(&d, ID, "tidy").await;
    let done = remove(&d, ID).await.unwrap();
    assert!(done["record"]["removed"]["kept"].is_null());
    assert!(!d.tree("tidy").exists());
    assert_eq!(git(&d.repo(), &["for-each-ref", "refs/hermes-chat"]), "");
    git(&d.repo(), &["rev-parse", "refs/heads/tidy"]);
}

#[tokio::test]
async fn restore_is_refused_when_the_branch_moved_and_the_kept_changes_stay() {
    let d = repo("moved");
    made(&d, ID, "moving").await;
    write(&d.tree("moving"), "wip.txt", "wip\n");
    let done = remove(&d, ID).await.unwrap();
    git(&d.repo(), &["branch", "-f", "moving", "main~0"]);
    commit(&d.repo(), "app.txt", "x\n", "main");
    git(&d.repo(), &["branch", "-f", "moving", "main"]);
    let e = ask(Request::WorktreeRestore { repo: d.s(), id: ID.into() }).await.unwrap_err();
    assert_eq!(kind(e), "moved");
    assert!(!d.tree("moving").exists());
    git(&d.repo(), &["rev-parse", done["record"]["removed"]["kept"]["ref"].as_str().unwrap()]);
}

#[tokio::test]
async fn unpushed_commits_are_counted_against_the_remote() {
    let d = repo("remote");
    let bare = d.0.join("origin.git");
    git(&d.0, &["init", "-q", "--bare", bare.to_str().unwrap()]);
    git(&d.repo(), &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&d.repo(), &["push", "-q", "origin", "main"]);
    made(&d, ID, "pushme").await;
    let tree = d.tree("pushme");
    assert_eq!(row(&list(&d).await, &tree)["unpushed"], 0);
    commit(&tree, "a.txt", "a\n", "one");
    commit(&tree, "b.txt", "b\n", "two");
    assert_eq!(row(&list(&d).await, &tree)["unpushed"], 2);
    let f = removal(&d, ID).await;
    let subjects: Vec<_> = f["unpushed"].as_array().unwrap().iter().map(|c| c["subject"].as_str().unwrap()).collect();
    assert_eq!(subjects, ["two", "one"]);
    git(&tree, &["push", "-q", "origin", "pushme"]);
    assert_eq!(row(&list(&d).await, &tree)["unpushed"], 0);
}

#[tokio::test]
async fn a_detached_head_with_commits_no_branch_has_is_kept_in_a_ref() {
    let d = repo("detached");
    made(&d, ID, "det").await;
    let tree = d.tree("det");
    git(&tree, &["switch", "-q", "--detach"]);
    let lonely = commit(&tree, "x.txt", "x\n", "on no branch");
    let f = removal(&d, ID).await;
    assert_eq!(f["keepHead"], true);
    let done = remove(&d, ID).await.unwrap();
    let reference = done["record"]["removed"]["kept"]["ref"].as_str().unwrap().to_owned();
    assert_eq!(git(&d.repo(), &["rev-parse", &reference]), lonely);
}

#[tokio::test]
async fn protected_shared_locked_and_submodule_worktrees_are_not_removed() {
    let d = repo("blocked");
    made(&d, ID, "keep").await;
    let tree = d.tree("keep");
    let blockers = |f: &Value| f["blockers"].as_array().unwrap().iter().map(|b| b["kind"].as_str().unwrap().to_owned()).collect::<Vec<_>>();

    ask(Request::WorktreeProtect { repo: d.s(), id: ID.into(), protected: true }).await.unwrap();
    assert_eq!(blockers(&removal(&d, ID).await), ["protected"]);
    assert_eq!(kind(remove(&d, ID).await.unwrap_err()), "blocked");
    ask(Request::WorktreeProtect { repo: d.s(), id: ID.into(), protected: false }).await.unwrap();

    ask(Request::WorktreeAttach { repo: d.s(), id: ID.into(), chat: chat("s1") }).await.unwrap();
    ask(Request::WorktreeAttach { repo: d.s(), id: ID.into(), chat: chat("s2") }).await.unwrap();
    // Attaching the same chat again doesn't count it twice.
    ask(Request::WorktreeAttach { repo: d.s(), id: ID.into(), chat: chat("s2") }).await.unwrap();
    assert_eq!(row(&list(&d).await, &tree)["record"]["chats"].as_array().unwrap().len(), 2);
    assert_eq!(blockers(&removal(&d, ID).await), ["shared"]);
    ask(Request::WorktreeDetach { repo: d.s(), id: ID.into(), scope: chat("s1").scope, chat: "s1".into() }).await.unwrap();
    assert_eq!(kind(remove(&d, ID).await.unwrap_err()), "blocked");
    assert!(tree.exists());
    ask(Request::WorktreeDetach { repo: d.s(), id: ID.into(), scope: chat("s2").scope, chat: "s2".into() }).await.unwrap();

    // Another tool's lock.
    git(&d.repo(), &["worktree", "unlock", tree.to_str().unwrap()]);
    git(&d.repo(), &["worktree", "lock", "--reason", "agent pid=4242", tree.to_str().unwrap()]);
    assert_eq!(blockers(&removal(&d, ID).await), ["locked"]);
    git(&d.repo(), &["worktree", "unlock", tree.to_str().unwrap()]);

    // A checked-out submodule: Git would delete its own changes and commits with the worktree.
    let sub = d.0.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    git(&sub, &["init", "-q", "-b", "main"]);
    git(&sub, &["-c", "user.email=a@b", "-c", "user.name=A", "commit", "-q", "--allow-empty", "-m", "s"]);
    git(&tree, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.to_str().unwrap(), "lib"]);
    let f = removal(&d, ID).await;
    assert_eq!(blockers(&f), ["submodule"]);
    assert_eq!(kind(remove(&d, ID).await.unwrap_err()), "blocked");
    assert!(tree.join("lib/.git").exists());
    // The repository's own checkout is never offered: it has no record.
    assert!(row(&list(&d).await, &d.repo())["record"].is_null());
}

#[tokio::test]
async fn a_chat_attached_after_the_preview_stops_the_removal() {
    let d = repo("race");
    made(&d, ID, "race").await;
    let facts = removal(&d, ID).await;
    assert!(facts["blockers"].as_array().unwrap().is_empty());
    // Another task starts using it between the preview and the confirmation.
    ask(Request::WorktreeAttach { repo: d.s(), id: ID.into(), chat: chat("other-task") }).await.unwrap();
    let e = ask(Request::WorktreeRemove { repo: d.s(), id: ID.into(), stamp: facts["stamp"].as_str().unwrap().into() }).await.unwrap_err();
    assert_eq!(kind(e), "blocked");
    assert!(d.tree("race").exists());
    assert_eq!(row(&list(&d).await, &d.tree("race"))["record"]["state"], "ready");
}

#[tokio::test]
async fn a_worktree_changed_after_the_preview_is_not_removed() {
    let d = repo("changed");
    made(&d, ID, "changed").await;
    let facts = removal(&d, ID).await;
    write(&d.tree("changed"), "late.txt", "written after the preview\n");
    let e = ask(Request::WorktreeRemove { repo: d.s(), id: ID.into(), stamp: facts["stamp"].as_str().unwrap().into() }).await.unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(read(&d.tree("changed"), "late.txt"), "written after the preview\n");
    assert_eq!(row(&list(&d).await, &d.tree("changed"))["locked"], format!("hermes-chat {ID}"));
}

#[tokio::test]
async fn worktrees_made_by_other_tools_are_listed_but_have_no_record() {
    let d = repo("others");
    let other = d.0.join("by-hand");
    git(&d.repo(), &["worktree", "add", "-q", "-b", "by-hand", other.to_str().unwrap()]);
    let l = list(&d).await;
    assert!(row(&l, &other)["record"].is_null());
    assert_eq!(row(&l, &d.repo())["main"], true);
    // Opening a linked worktree lists the same repository.
    let from_tree = ask(Request::WorktreeList { repo: other.to_string_lossy().into() }).await.unwrap();
    assert_eq!(from_tree["main"], d.s());
    assert_eq!(row(&from_tree, &other)["current"], true);
}

#[tokio::test]
async fn a_record_from_a_newer_app_is_read_but_never_written() {
    let d = repo("newer");
    made(&d, ID, "n").await;
    let file = d.repo().join(".git/hermes-chat/worktrees.json");
    let mut reg: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    reg["v"] = 2.into();
    std::fs::write(&file, reg.to_string()).unwrap();
    assert_eq!(list(&d).await["newer"], true);
    let e = ask(Request::WorktreeProtect { repo: d.s(), id: ID.into(), protected: true }).await.unwrap_err();
    assert_eq!(kind(e), "unsupported");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), reg.to_string());
}

fn registry(d: &Dir) -> Value {
    serde_json::from_str(&std::fs::read_to_string(d.repo().join(".git/hermes-chat/worktrees.json")).unwrap()).unwrap()
}

fn set_registry(d: &Dir, reg: &Value) {
    std::fs::write(d.repo().join(".git/hermes-chat/worktrees.json"), reg.to_string()).unwrap();
}

#[tokio::test]
async fn a_file_written_while_the_changes_are_kept_stops_the_removal() {
    let d = repo("writer");
    made(&d, ID, "busy").await;
    let tree = d.tree("busy");
    write(&tree, "wip.txt", "before\n");
    let facts = removal(&d, ID).await;
    // The helper pauses between keeping the changes and checking them again; an editor writes meanwhile.
    let mut cmd = helper();
    cmd.env("HERMES_REPO_TEST_PAUSE_AFTER_KEEP", "1.5");
    let req = Request::WorktreeRemove { repo: d.s(), id: ID.into(), stamp: facts["stamp"].as_str().unwrap().into() };
    let removing = tokio::spawn(async move { repo_git::run(cmd, &req).await });
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    write(&tree, "late.txt", "written while the changes were kept\n");
    let e = removing.await.unwrap().unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(read(&tree, "late.txt"), "written while the changes were kept\n");
    assert_eq!(read(&tree, "wip.txt"), "before\n");
    let rec = &registry(&d)["worktrees"][ID];
    assert_eq!(rec["state"], "ready");
    // What was kept before the write is still named, and still there.
    let kept = rec["keptRefs"][0].as_str().unwrap();
    assert_eq!(git(&d.repo(), &["show", &format!("{kept}:wip.txt")]), "before");
    assert_eq!(row(&list(&d).await, &tree)["locked"], format!("hermes-chat {ID}"));
}

#[tokio::test]
async fn staged_content_unlike_the_working_file_is_kept_and_restored_to_the_index() {
    let d = repo("staged");
    made(&d, ID, "stage").await;
    let tree = d.tree("stage");
    write(&tree, "app.txt", "staged version\n");
    git(&tree, &["add", "app.txt"]);
    // The working file goes back to HEAD's content: only the index has the staged version.
    write(&tree, "app.txt", "one\n");
    let done = remove(&d, ID).await.unwrap();
    let kept = &done["record"]["removed"]["kept"];
    let staged = kept["staged"].as_str().unwrap();
    assert_eq!(git(&d.repo(), &["show", &format!("{staged}:app.txt")]), "staged version");
    assert_eq!(git(&d.repo(), &["rev-parse", &format!("{}^", kept["commit"].as_str().unwrap())]), staged);
    ask(Request::WorktreeRestore { repo: d.s(), id: ID.into() }).await.unwrap();
    assert_eq!(read(&tree, "app.txt"), "one\n");
    assert_eq!(git(&tree, &["show", ":app.txt"]), "staged version");
}

#[tokio::test]
async fn repositories_nested_in_a_worktree_stop_its_removal() {
    let d = repo("nested");
    made(&d, ID, "nest").await;
    let tree = d.tree("nest");
    let blockers = |f: &Value| f["blockers"].as_array().unwrap().iter().map(|b| b["kind"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    // An untracked clone.
    std::fs::create_dir_all(tree.join("vendor/lib")).unwrap();
    git(&tree.join("vendor/lib"), &["init", "-q"]);
    assert_eq!(blockers(&removal(&d, ID).await), ["nested"]);
    std::fs::remove_dir_all(tree.join("vendor")).unwrap();
    // One inside an ignored folder.
    std::fs::create_dir_all(tree.join("node_modules/pkg")).unwrap();
    git(&tree.join("node_modules/pkg"), &["init", "-q"]);
    let f = removal(&d, ID).await;
    assert_eq!(blockers(&f), ["nested"]);
    assert!(f["blockers"][0]["message"].as_str().unwrap().contains("node_modules/pkg"));
    assert_eq!(kind(remove(&d, ID).await.unwrap_err()), "blocked");
    assert!(tree.join("node_modules/pkg/.git").exists());
}

#[tokio::test]
async fn an_ignored_file_made_after_the_preview_is_never_deleted_unseen() {
    let d = repo("ignored-late");
    made(&d, ID, "late").await;
    let facts = removal(&d, ID).await;
    write(&d.tree("late"), ".env", "SECRET=written after the preview\n");
    let e = ask(Request::WorktreeRemove { repo: d.s(), id: ID.into(), stamp: facts["stamp"].as_str().unwrap().into() }).await.unwrap_err();
    assert_eq!(kind(e), "stale");
    assert!(d.tree("late").join(".env").exists());
    assert_eq!(removal(&d, ID).await["ignored"], serde_json::json!([".env"]));
}

#[tokio::test]
async fn a_removal_cut_off_after_the_folder_went_is_finished_with_what_it_kept() {
    let d = repo("cut-removal");
    made(&d, ID, "cut").await;
    let tree = d.tree("cut");
    write(&tree, "wip.txt", "wip\n");
    // As if the helper died right after recording what it kept and removing the folder.
    git(&d.repo(), &["worktree", "unlock", tree.to_str().unwrap()]);
    git(&d.repo(), &["update-ref", "refs/hermes-chat/recovery/x/1", "HEAD"]);
    git(&d.repo(), &["worktree", "remove", "--force", tree.to_str().unwrap()]);
    let mut reg = registry(&d);
    reg["worktrees"][ID]["state"] = "removing".into();
    reg["worktrees"][ID]["removing"] = serde_json::json!({"at": 5, "head": null, "branch": "cut", "kept": {"ref": "refs/hermes-chat/recovery/x/1", "commit": "c", "staged": null}, "files": 1, "unpushed": 0});
    set_registry(&d, &reg);
    let l = list(&d).await;
    assert_eq!(l["unfinished"][0]["state"], "removing");
    let done = ask(Request::WorktreeRemove { repo: d.s(), id: ID.into(), stamp: String::new() }).await.unwrap();
    assert_eq!(done["record"]["state"], "removed");
    assert_eq!(done["record"]["removed"]["kept"]["ref"], "refs/hermes-chat/recovery/x/1");
    assert_eq!(list(&d).await["removed"][0]["id"], ID);
}

#[tokio::test]
async fn a_restore_cut_off_part_way_is_finished_by_restoring_again() {
    let d = repo("cut-restore");
    made(&d, ID, "back").await;
    let tree = d.tree("back");
    write(&tree, "wip.txt", "wip\n");
    remove(&d, ID).await.unwrap();
    // As if the helper died after making the worktree again and before putting the changes back.
    let mut reg = registry(&d);
    let mut gone = reg["worktrees"][ID]["removed"].clone();
    gone["applied"] = false.into();
    reg["worktrees"][ID]["state"] = "restoring".into();
    reg["worktrees"][ID]["restoring"] = gone;
    set_registry(&d, &reg);
    git(&d.repo(), &["worktree", "add", "-q", tree.to_str().unwrap(), "back"]);
    assert!(!tree.join("wip.txt").exists());
    assert_eq!(row(&list(&d).await, &tree)["record"]["state"], "restoring");
    let back = ask(Request::WorktreeRestore { repo: d.s(), id: ID.into() }).await.unwrap();
    assert_eq!(back["record"]["state"], "ready");
    assert_eq!(read(&tree, "wip.txt"), "wip\n");
    assert_eq!(row(&list(&d).await, &tree)["locked"], format!("hermes-chat {ID}"));
}
