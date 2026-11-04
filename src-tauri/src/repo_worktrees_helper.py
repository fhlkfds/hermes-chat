

# ── worktrees (ADR 0042) ────────────────────────────────────────────────────
# Worktrees of the server's repository that Hermes Chat makes and manages. Each is made with the exact base, branch and
# folder the owner saw first, set up once from the repository's own `.worktreeinclude`, listed with its chats, changes
# and unpushed commits, and removed only after a preview, with its changes kept in a recovery ref first. Branches are
# never deleted. Nothing is reset.
#
# Which worktrees are managed here, and which chats use each, is kept beside the repository, in its common Git
# directory (`hermes-chat/worktrees.json`), changed only under an exclusive lock on `hermes-chat/worktrees.lock`. So
# every computer and window sees one record, and a removal can't race a chat being attached.
#
# Worktrees go in `<repo>.worktrees/<branch>` beside the repository, never in `<repo>/.worktrees/`: Hermes's own sweep
# archives and removes idle trees there (hermes_cli/worktree_ops.py, _prune_stale_worktrees), and a quiet chat never
# makes a worktree disposable.

import fcntl
import time

REGISTRY_VERSION = 1
# `git worktree lock --reason`: a locked worktree isn't pruned, and `git worktree remove` refuses it without -f -f.
LOCK_REASON = "hermes-chat "
# Branches Hermes's sweep deletes with `git branch -D` once no worktree has them (_prune_orphaned_branches). A branch
# kept after a removal here must never be one of those.
SWEPT = re.compile(r"^(hermes/hermes-|pr-)")
WT_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_INCLUDE = 100
MAX_LISTED = 500
ZERO = "0" * 40


def now():
    return int(time.time() * 1000)


def check_id(value):
    if not isinstance(value, str) or not WT_ID.match(value):
        raise Refusal("internal", "That isn't a worktree id.")
    return value


def short_text(value, limit, what):
    if not isinstance(value, str) or not value or len(value) > limit or "\0" in value:
        raise Refusal("internal", "%s is missing or too long." % what)
    return value


def same_path(a, b):
    return os.path.realpath(a) == os.path.realpath(b)


def parse_worktrees(raw):
    trees = []
    for line in text(raw).split("\n"):
        if line.startswith("worktree "):
            trees.append({"path": line[9:], "head": None, "branch": None, "detached": False, "bare": False, "locked": None, "prunable": False})
        elif not trees:
            continue
        elif line.startswith("HEAD "):
            trees[-1]["head"] = line[5:]
        elif line.startswith("branch refs/heads/"):
            trees[-1]["branch"] = line[len("branch refs/heads/"):]
        elif line == "detached":
            trees[-1]["detached"] = True
        elif line == "bare":
            trees[-1]["bare"] = True
        elif line == "locked" or line.startswith("locked "):
            trees[-1]["locked"] = line[7:]
        elif line == "prunable" or line.startswith("prunable "):
            trees[-1]["prunable"] = True
    for i, t in enumerate(trees):
        t["main"] = i == 0
    return trees


def repo_trees(repo):
    """The checkout `repo` is in, the repository's common Git directory, and its worktrees, its own checkout first."""
    top, _ = checkout(repo)
    trees = parse_worktrees(git_ok(["worktree", "list", "--porcelain"], top))
    if not trees or trees[0]["bare"]:
        raise Refusal("unsupported", "This is a bare repository. Worktrees are made here from a repository with its own checkout.")
    common = text(git_ok(["rev-parse", "--path-format=absolute", "--git-common-dir"], top)).strip()
    return top, common, trees


def tree_at(trees, path):
    return next((t for t in trees if same_path(t["path"], path)), None)


# ── the record ──────────────────────────────────────────────────────────────


class Registry:
    """The repository's record of managed worktrees. Reads take no lock: the file is only ever replaced whole. Writes
    happen inside `with Registry(common) as reg:`, which holds the lock from the read to the save."""

    def __init__(self, common):
        self.dir = os.path.join(common, "hermes-chat")
        self.file = os.path.join(self.dir, "worktrees.json")
        self.fd = None
        self.data = None

    def read(self):
        try:
            with open(self.file, "rb") as f:
                data = json.loads(f.read().decode("utf-8"))
        except FileNotFoundError:
            return {"v": REGISTRY_VERSION, "worktrees": {}}
        except (OSError, ValueError) as e:
            raise Refusal("registry", "The record of this repository's worktrees (%s) can't be read: %s. Nothing was changed." % (self.file, e))
        if not isinstance(data, dict) or not isinstance(data.get("worktrees"), dict) or not isinstance(data.get("v"), int):
            raise Refusal("registry", "The record of this repository's worktrees (%s) isn't one Hermes Chat wrote. Nothing was changed." % self.file)
        return data

    def __enter__(self):
        os.makedirs(self.dir, 0o700, exist_ok=True)
        self.fd = os.open(os.path.join(self.dir, "worktrees.lock"), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            deadline = time.time() + 30
            while True:
                try:
                    fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.time() > deadline:
                        raise Refusal("busy", "Another Hermes Chat is changing this repository's worktrees. Nothing was changed; try again in a moment.")
                    time.sleep(0.1)
            self.data = self.read()
            if self.data["v"] > REGISTRY_VERSION:
                raise Refusal("unsupported", "A newer Hermes Chat keeps this repository's worktrees. Update this one to change them.")
        except BaseException:
            os.close(self.fd)
            raise
        return self

    def __exit__(self, *exc):
        os.close(self.fd)
        return False

    def get(self, wid, states):
        rec = self.data["worktrees"].get(wid)
        if rec is None:
            raise Refusal("not-found", "Hermes Chat has no record of that worktree now. Refresh the list.")
        if rec["state"] not in states:
            raise Refusal("stale", "That worktree is %s now. Refresh the list." % rec["state"])
        return rec

    def save(self):
        self.data["v"] = REGISTRY_VERSION
        fd, tmp = tempfile.mkstemp(dir=self.dir, prefix=".worktrees.")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(json.dumps(self.data, indent=1, sort_keys=True).encode("utf-8"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.file)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        dfd = os.open(self.dir, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)


# ── reading a worktree ──────────────────────────────────────────────────────


def changes(path):
    """Every change in the worktree at `path`, from `git status`: [{status, path}], status one of staged, changed,
    both (staged and changed again), conflict, untracked. Submodules are never hidden."""
    out = git_ok(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"], path)
    found = []
    recs = out.split(b"\0")
    i = 0
    while i < len(recs):
        r = recs[i]
        i += 1
        if not r:
            continue
        kind = r[:1]
        if kind == b"?":
            found.append({"status": "untracked", "path": text(r[2:])})
        elif kind == b"u":
            found.append({"status": "conflict", "path": text(r.split(b" ", 10)[10])})
        elif kind in (b"1", b"2"):
            fields = r.split(b" ", 8 if kind == b"1" else 9)
            x, y = fields[1][:1], fields[1][1:2]
            status = "both" if x != b"." and y != b"." else "staged" if x != b"." else "changed"
            found.append({"status": status, "path": text(fields[-1])})
            if kind == b"2":
                i += 1  # a rename's old path
    return found


def counts(found):
    c = {"staged": 0, "changed": 0, "untracked": 0, "conflicts": 0}
    for f in found:
        s = f["status"]
        if s == "untracked":
            c["untracked"] += 1
        elif s == "conflict":
            c["conflicts"] += 1
        else:
            c["staged"] += s in ("staged", "both")
            c["changed"] += s in ("changed", "both")
    return c


def has_remote(top):
    return bool(text(git_ok(["remote"], top)).strip())


def unpushed(path):
    """Commits at HEAD that no remote-tracking branch has, as of the last fetch: [{sha, subject}], newest first."""
    out = git_ok(["log", "--format=%H%x1f%s", "-n", str(MAX_LISTED + 1), "HEAD", "--not", "--remotes"], path)
    rows = []
    for line in text(out).splitlines():
        sha, _, subject = line.partition("\x1f")
        rows.append({"sha": sha, "subject": subject})
    return rows


def resolve(top, rev):
    code, out, _ = git(["rev-parse", "--verify", "--quiet", "--end-of-options", rev + "^{commit}"], top)
    return text(out).strip() if code == 0 and text(out).strip() else None


def branch_exists(top, name):
    return git(["show-ref", "--verify", "--quiet", "refs/heads/" + name], top)[0] == 0


def subject(top, sha):
    code, out, _ = git(["log", "-1", "--format=%s", sha, "--"], top)
    return text(out).strip() if code == 0 else ""


# ── planning ────────────────────────────────────────────────────────────────


def check_branch(top, name):
    if not isinstance(name, str) or not name or name != name.strip() or name.startswith("-") or "\0" in name or len(name) > 200:
        raise Refusal("bad-branch", "Enter a branch name, such as fix/login-timeout.")
    if git(["check-ref-format", "refs/heads/" + name], top)[0] != 0 or "@{" in name:
        raise Refusal("bad-branch", "%s isn't a name Git allows for a branch." % name)
    if SWEPT.match(name):
        raise Refusal(
            "bad-branch",
            "Hermes deletes branches named hermes/hermes-… and pr-… on its own once no worktree has them, so this branch could be lost after cleanup. Choose another name.",
        )
    return name


def check_base(base):
    if not isinstance(base, str) or not base or base != base.strip() or base.startswith("-") or "\0" in base or len(base) > 255:
        raise Refusal("bad-ref", "Enter the branch, tag or commit to start from, such as main or origin/main.")
    return base


def folder_name(branch):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", branch).strip(".-")[:80].rstrip(".-")


def include_steps(main):
    """The setup a new worktree gets: each entry of the repository's `.worktreeinclude` (Hermes's own list of ignored
    files a worktree needs, such as .env), copied from the repository's own checkout if it's a file or linked if it's a
    folder, as Hermes does for its worktrees. An entry Git doesn't ignore is part of the source and is never copied:
    a source change reaches a worktree only through a commit."""
    f = os.path.join(main, ".worktreeinclude")
    if not os.path.isfile(f):
        return []
    with open(f, "rb") as h:
        raw = h.read(256 * 1024)
    root = os.path.realpath(main)
    steps = []
    for line in raw.decode("utf-8-sig", "replace").splitlines():
        entry = line.strip().rstrip("/")
        if not entry or entry.startswith("#"):
            continue
        if len(steps) == MAX_INCLUDE:
            break
        step = {"entry": entry, "action": "skip", "state": "skipped", "message": ""}
        steps.append(step)
        try:
            safe_rel(entry, main)
        except Refusal:
            step["message"] = "It isn't a path inside the repository."
            continue
        src = os.path.join(main, entry)
        if not os.path.lexists(src):
            step["message"] = "There's no %s in %s." % (entry, main)
            continue
        real = os.path.realpath(src)
        if real != root and not real.startswith(root + os.sep):
            step["message"] = "It links outside the repository."
            continue
        # check-ignore takes path names, not pathspecs, so it runs without --literal-pathspecs (which it refuses).
        ignored_code = run(["git", "check-ignore", "-q", "--", entry], main)[0]
        if ignored_code == 1:
            step["message"] = "Git doesn't ignore it, so it's part of the source. Source changes are never copied into a worktree."
            continue
        if ignored_code != 0:
            step["message"] = "Git couldn't say whether it's ignored, so it isn't copied."
            continue
        step.update(action="link" if os.path.isdir(src) else "copy", state="pending")
    return steps


def plan_for(top, trees, req):
    """Exactly what a create would do: the branch, the commit it starts at, the folder, and the setup steps. The stamp
    covers all of them, so a create made from an older preview is refused."""
    main = trees[0]["path"]
    branch = check_branch(top, req.get("branch"))
    new = req.get("newBranch") is True
    exists = branch_exists(top, branch)
    if new:
        if exists:
            raise Refusal("branch-exists", "There's already a branch %s. Choose Existing branch to check it out, or another name." % branch)
        base = check_base(req.get("base"))
        sha = resolve(top, base)
        if not sha:
            raise Refusal("bad-ref", "There's no branch, tag or commit %s in this repository." % base)
    else:
        if not exists:
            raise Refusal("no-branch", "There's no branch %s here. Choose New branch to make it." % branch)
        holder = next((t for t in trees if t["branch"] == branch), None)
        if holder:
            raise Refusal("checked-out", "%s is already checked out in %s. A branch can be checked out in only one worktree." % (branch, holder["path"]))
        base = branch
        sha = resolve(top, "refs/heads/" + branch)
    name = folder_name(branch)
    if not name:
        raise Refusal("bad-branch", "%s doesn't make a folder name." % branch)
    parent = os.path.join(os.path.dirname(main), os.path.basename(main) + ".worktrees")
    path = os.path.join(parent, name)
    if os.path.lexists(parent) and (os.path.islink(parent) or not os.path.isdir(parent)):
        raise Refusal("bad-path", "%s isn't a plain folder, so worktrees aren't made in it." % parent)
    if os.path.lexists(path):
        raise Refusal("path-exists", "%s already exists on the server. Nothing is made over it; choose another branch name." % path)
    plan = {"repo": main, "path": path, "branch": branch, "newBranch": new, "base": base, "baseSha": sha, "setup": include_steps(main)}
    plan["stamp"] = hashlib.sha256(json.dumps(plan, sort_keys=True).encode("utf-8")).hexdigest()
    return plan


def gitlinks(top, sha):
    out = git_ok(["ls-tree", "-r", "-z", "--full-tree", sha], top)
    return [text(r.split(b"\t", 1)[1]) for r in out.split(b"\0") if r.startswith(b"160000 ")]


def op_worktree_plan(req):
    top, _, trees = repo_trees(req.get("repo"))
    plan = plan_for(top, trees, req)
    subs = gitlinks(top, plan["baseSha"])
    plan.update(
        subject=subject(top, plan["baseSha"]),
        # The checkout the owner opened keeps its changes: a worktree starts from a commit, never from them.
        source=dict(counts(changes(top)), path=top),
        submodules=subs[:MAX_INCLUDE],
        submoduleCount=len(subs),
    )
    return plan


# ── making one ──────────────────────────────────────────────────────────────


def lock_tree(main, rec):
    code, _, err = git(["worktree", "lock", "--reason", LOCK_REASON + rec["id"], "--", rec["path"]], main, read_only=False)
    if code != 0 and "already locked" not in text(err):
        raise Refusal("git", text(err).strip() or "git worktree lock failed.", text(err))


def add_tree(main, trees, rec, detach_at=None):
    """`git worktree add` for the record, unless an interrupted run already made it. Then it's locked as ours."""
    tree = tree_at(trees, rec["path"])
    output = ""
    if tree is None:
        if os.path.lexists(rec["path"]):
            raise Refusal("path-exists", "%s exists on the server but isn't a worktree of this repository. Nothing was made over it." % rec["path"])
        parent = os.path.dirname(rec["path"])
        if os.path.islink(parent):
            raise Refusal("bad-path", "%s isn't a plain folder, so worktrees aren't made in it." % parent)
        os.makedirs(parent, 0o755, exist_ok=True)
        if detach_at:
            args = ["worktree", "add", "--detach", "--", rec["path"], detach_at]
        elif rec["newBranch"] and not branch_exists(main, rec["branch"]):
            # --no-track: a branch made from origin/main would otherwise track main, and a push could go there.
            args = ["worktree", "add", "--no-track", "-b", rec["branch"], "--", rec["path"], rec["baseSha"]]
        else:
            if rec["newBranch"] and resolve(main, "refs/heads/" + rec["branch"]) != rec["baseSha"]:
                raise Refusal("stale", "The branch %s appeared meanwhile at another commit. Nothing was made." % rec["branch"])
            args = ["worktree", "add", "--", rec["path"], rec["branch"]]
        # Hooks (post-checkout) run as Git runs them, with the SSH user's config; their output is shown.
        code, out, _ = git(args, main, read_only=False, timeout=600, merge_output=True)
        output = text(out)
        if code != 0:
            raise Refusal("git", output.strip().splitlines()[-1] if output.strip() else "git worktree add failed.", output)
    elif tree["locked"] not in (None, LOCK_REASON + rec["id"]) or (not detach_at and tree["branch"] != rec["branch"]):
        raise Refusal("stale", "Another worktree is at %s now. Nothing was changed." % rec["path"])
    lock_tree(main, rec)
    return output


def op_worktree_create(req):
    top, common, trees = repo_trees(req.get("repo"))
    wid = check_id(req.get("id"))
    main = trees[0]["path"]
    with Registry(common) as reg:
        rec = reg.data["worktrees"].get(wid)
        fresh = rec is None
        if fresh:
            plan = plan_for(top, trees, req)
            if plan["stamp"] != req.get("stamp"):
                raise Refusal("stale", "Something changed since the preview: the base moved, the branch or folder appeared, or .worktreeinclude changed. Nothing was made. Look at the preview again.")
            rec = {
                "id": wid,
                "path": plan["path"],
                "branch": plan["branch"],
                "newBranch": plan["newBranch"],
                "base": plan["base"],
                "baseSha": plan["baseSha"],
                "setup": plan["setup"],
                "state": "creating",
                "protected": False,
                "chats": [],
                "createdAt": now(),
                "createdBy": short_text(req.get("by"), 200, "Who made it"),
            }
            reg.data["worktrees"][wid] = rec
            reg.save()
        elif rec["state"] != "creating":
            # Made already, by this same request before its answer was lost: the same answer again.
            return {"record": rec, "output": ""}
        try:
            output = add_tree(main, trees, rec)
        except Refusal:
            # Nothing was made: no record is left behind for it.
            if fresh and tree_at(parse_worktrees(git_ok(["worktree", "list", "--porcelain"], main)), rec["path"]) is None:
                del reg.data["worktrees"][wid]
                reg.save()
            raise
        rec["state"] = "ready"
        rec["readyAt"] = now()
        reg.save()
        return {"record": rec, "output": output}


def op_worktree_setup(req):
    """Runs one setup step, once: a step that's done is never run again. A failed one can be tried again."""
    _, common, trees = repo_trees(req.get("repo"))
    wid = check_id(req.get("id"))
    main = trees[0]["path"]
    with Registry(common) as reg:
        rec = reg.get(wid, ("ready",))
        i = req.get("step")
        if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < len(rec["setup"]):
            raise Refusal("internal", "There's no such setup step.")
        step = rec["setup"][i]
        if step["state"] in ("done", "skipped"):
            return {"record": rec}
        if tree_at(trees, rec["path"]) is None:
            raise Refusal("not-found", "The worktree isn't at %s any more." % rec["path"])
        src = os.path.join(main, step["entry"])
        dst = os.path.join(rec["path"], step["entry"])
        try:
            safe_rel(step["entry"], rec["path"])
            root, real = os.path.realpath(main), os.path.realpath(src)
            if real != root and not real.startswith(root + os.sep):
                raise Refusal("bad-path", "%s links outside the repository now." % step["entry"])
            if os.path.lexists(dst):
                step["message"] = "Already there, so it was left as it is."
            elif step["action"] == "copy":
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                step["message"] = "Copied from %s (%d bytes)." % (src, os.path.getsize(dst))
            else:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                os.symlink(real, dst)
                step["message"] = "Linked to %s.%s" % (real, "" if run(["git", "check-ignore", "-q", "--", step["entry"]], rec["path"])[0] == 0 else
                    " Git lists the link as untracked, because .gitignore matches only a real folder there (a pattern ending in /).")
            step["state"] = "done"
        except Refusal as r:
            step.update(state="failed", message=r.message)
        except OSError as e:
            step.update(state="failed", message=str(e))
        step["at"] = now()
        reg.save()
        return {"record": rec}


# ── chats, protection ───────────────────────────────────────────────────────


def op_worktree_attach(req):
    """Records that a chat works in the worktree. While any chat is recorded, it can't be removed."""
    _, common, trees = repo_trees(req.get("repo"))
    wid = check_id(req.get("id"))
    chat = req.get("chat")
    if not isinstance(chat, dict):
        raise Refusal("internal", "Which chat is missing.")
    entry = {
        "scope": short_text(chat.get("scope"), 500, "The chat's connection and profile"),
        "chat": short_text(chat.get("chat"), 200, "The chat's id"),
        "title": chat.get("title") if isinstance(chat.get("title"), str) else "",
        "at": now(),
    }
    entry["title"] = entry["title"][:200]
    with Registry(common) as reg:
        rec = reg.get(wid, ("ready",))
        if tree_at(trees, rec["path"]) is None:
            raise Refusal("not-found", "The worktree isn't at %s any more." % rec["path"])
        rec["chats"] = [c for c in rec["chats"] if (c["scope"], c["chat"]) != (entry["scope"], entry["chat"])] + [entry]
        reg.save()
        return {"record": rec}


def op_worktree_detach(req):
    _, common, _ = repo_trees(req.get("repo"))
    wid = check_id(req.get("id"))
    key = (short_text(req.get("scope"), 500, "The chat's connection and profile"), short_text(req.get("chat"), 200, "The chat's id"))
    with Registry(common) as reg:
        rec = reg.get(wid, ("ready", "creating", "removing"))
        rec["chats"] = [c for c in rec["chats"] if (c["scope"], c["chat"]) != key]
        reg.save()
        return {"record": rec}


def op_worktree_protect(req):
    _, common, _ = repo_trees(req.get("repo"))
    wid = check_id(req.get("id"))
    on = req.get("protected")
    if not isinstance(on, bool):
        raise Refusal("internal", "Protect or not is missing.")
    with Registry(common) as reg:
        rec = reg.get(wid, ("ready",))
        rec["protected"] = on
        reg.save()
        return {"record": rec}


def op_worktree_forget(req):
    """Drops a record that has no worktree: one removed, or a create, removal or restore that didn't finish. Nothing on
    disk, no branch and no recovery ref is touched."""
    _, common, trees = repo_trees(req.get("repo"))
    wid = check_id(req.get("id"))
    with Registry(common) as reg:
        rec = reg.get(wid, ("creating", "removed", "removing", "restoring"))
        if tree_at(trees, rec["path"]) is not None:
            raise Refusal("stale", "%s is a worktree now. Refresh the list." % rec["path"])
        del reg.data["worktrees"][wid]
        reg.save()
        return {"forgotten": wid}


# ── listing ─────────────────────────────────────────────────────────────────


def op_worktree_list(req):
    top, common, trees = repo_trees(req.get("repo"))
    data = Registry(common).read()
    records = list(data["worktrees"].values())
    remote = has_remote(top)
    rows = []
    for t in trees:
        rec = next((r for r in records if r["state"] != "removed" and same_path(r["path"], t["path"])), None)
        row = dict(t, record=rec, current=same_path(t["path"], top), missing=not os.path.isdir(t["path"]))
        if not row["missing"]:
            try:
                row["changes"] = counts(changes(t["path"]))
                row["unpushed"] = len(unpushed(t["path"])) if remote and t["head"] else None
            except Refusal as r:
                row["error"] = r.message
        rows.append(row)
    return {
        "top": top,
        "main": trees[0]["path"],
        "hasRemote": remote,
        "newer": data["v"] > REGISTRY_VERSION,
        "worktrees": rows,
        # A create or removal whose answer was lost, or that stopped part way, with no worktree to show for it.
        "unfinished": [r for r in records if r["state"] in ("creating", "removing", "restoring", "ready") and tree_at(trees, r["path"]) is None],
        # Read by Hermes too, to check it's on the same server as this repository (ADR 0042).
        "registry": Registry(common).file,
        "removed": sorted((r for r in records if r["state"] == "removed"), key=lambda r: -r["removed"]["at"]),
    }


# ── removing ────────────────────────────────────────────────────────────────


def initialized_submodules(path):
    out = git_ok(["ls-files", "--stage", "-z"], path)
    found = []
    for r in out.split(b"\0"):
        if r.startswith(b"160000 "):
            rel = text(r.split(b"\t", 1)[1])
            if os.path.lexists(os.path.join(path, rel, ".git")):
                found.append(rel)
    return found


# The most entries looked at for repositories nested in a worktree. More, and it isn't removed from here.
MAX_WALK = 200000


def walk_tree(path):
    """One look at everything in the worktree folder but its `.git` file, links not followed: the folders in it that
    are Git repositories of their own (a clone or a bare repository, tracked as a submodule or not, ignored or not,
    whose objects and changes aren't in this repository, so nothing here could keep them), a digest of every entry's
    path, size, modification time and mode (ignored files inside ignored folders included), and whether the look was
    cut short."""
    found, seen, digest = [], 0, hashlib.sha256()
    for top, dirs, files in os.walk(path):
        dirs.sort()
        rel_top = os.path.relpath(top, path)
        if top == path:
            dirs[:] = [d for d in dirs if d != ".git"]
            files = [f for f in files if f != ".git"]
        else:
            if ".git" in dirs or ".git" in files or ("HEAD" in files and "objects" in dirs and "refs" in dirs):
                found.append(rel_top)
                dirs[:] = []
                continue
        seen += len(dirs) + len(files)
        if seen > MAX_WALK:
            return found, True, None
        for name in sorted(files) + dirs:
            rel = os.path.normpath(os.path.join(rel_top, name))
            digest.update(json.dumps([rel, fingerprint(path, rel)]).encode("utf-8", "surrogateescape"))
    return found, False, digest.hexdigest()


def ignored(path):
    out = git_ok(["status", "--porcelain=v2", "-z", "--ignored=matching", "--untracked-files=normal"], path)
    return [text(r[2:]) for r in out.split(b"\0") if r.startswith(b"! ")]


def fingerprint(path, rel):
    """Size, modification time and mode of a file or folder, so the stamp changes when its content does."""
    try:
        st = os.lstat(os.path.join(path, rel.rstrip("/")))
    except OSError:
        return None
    return [st.st_size, st.st_mtime_ns, st.st_mode]


def removal_facts(trees, rec):
    """What removing would affect, and what stops it. The stamp covers everything the preview shows and everything
    that would be deleted: HEAD, the branch, the lock, each changed, untracked and ignored file and its fingerprint."""
    tree = tree_at(trees, rec["path"])
    blockers = []
    if rec["protected"]:
        blockers.append({"kind": "protected", "message": "It's protected. Unprotect it first if you mean to remove it."})
    if rec["chats"]:
        blockers.append({"kind": "shared", "message": "%d chat%s use%s it. Detach each one first; a quiet chat doesn't mean its worktree is done with." % (len(rec["chats"]), "" if len(rec["chats"]) == 1 else "s", "s" if len(rec["chats"]) == 1 else "")})
    facts = {"path": rec["path"], "blockers": blockers, "files": [], "ignored": [], "unpushed": [], "head": None, "branch": None, "keepHead": False}
    if tree is None or not os.path.isdir(rec["path"]):
        blockers.append({"kind": "missing", "message": "There's no worktree at %s now." % rec["path"]})
        facts["stamp"] = ""
        return facts
    if tree["main"]:
        blockers.append({"kind": "main", "message": "It's the repository's own checkout."})
    if tree["locked"] is not None and tree["locked"] != LOCK_REASON + rec["id"]:
        blockers.append({"kind": "locked", "message": "Another tool locked it: %s" % (tree["locked"] or "no reason given")})
    git_dir = text(git_ok(["rev-parse", "--absolute-git-dir"], rec["path"])).strip()
    op = in_progress(git_dir)
    if op:
        blockers.append({"kind": "operation", "message": "A %s is in progress in it. Finish or abort it first." % op})
    subs = initialized_submodules(rec["path"])
    for sub in subs:
        blockers.append({"kind": "submodule", "message": "The submodule %s is checked out in it. Its own changes and commits can't be kept here, so check it and remove it by hand first (git submodule deinit)." % sub})
    nested, cut, contents = walk_tree(rec["path"])
    for rel in nested:
        if rel not in subs:
            blockers.append({"kind": "nested", "message": "%s is a Git repository of its own inside it. Its commits and changes can't be kept here, so move or remove it by hand first." % rel})
    if cut:
        blockers.append({"kind": "nested", "message": "It holds more than %d files and folders, too many to check for repositories nested in it. Remove it by hand." % MAX_WALK})
    files = changes(rec["path"])
    if any(f["status"] == "conflict" for f in files):
        blockers.append({"kind": "conflict", "message": "It has conflicted files. Resolve them first: a conflict can't be kept."})
    every_ignored = ignored(rec["path"])
    head = head_oid(rec["path"])
    commits = unpushed(rec["path"]) if head else []
    facts.update(
        files=files[:MAX_LISTED],
        fileCount=len(files),
        ignored=every_ignored[:MAX_LISTED],
        ignoredCount=len(every_ignored),
        unpushed=commits[:MAX_LISTED],
        hasRemote=has_remote(rec["path"]),
        head=head,
        branch=tree["branch"],
        # Detached, with commits no branch or remote has: they'd be lost, so a recovery ref keeps them.
        keepHead=bool(head and not tree["branch"] and text(git_ok(["rev-list", "-n", "1", "HEAD", "--not", "--branches", "--remotes"], rec["path"])).strip()),
    )
    # The index's own entries (a `git add -p` changes them and nothing else), and every file in the folder.
    staged_now = index_stamp(rec["path"])
    inventory = [[f["status"], f["path"]] for f in files] + [["ignored", p] for p in every_ignored]
    facts["stamp"] = hashlib.sha256(json.dumps([head, tree["branch"], tree["locked"], staged_now, contents, inventory], sort_keys=True).encode("utf-8")).hexdigest()
    return facts


def op_worktree_removal(req):
    _, common, trees = repo_trees(req.get("repo"))
    rec = Registry(common).read()["worktrees"].get(check_id(req.get("id")))
    if rec is None or rec["state"] not in ("ready", "removing"):
        raise Refusal("not-found", "That worktree isn't one Hermes Chat can remove now. Refresh the list.")
    return removal_facts(trees, rec)


KEEPER = {
    "GIT_AUTHOR_NAME": "Hermes Chat",
    "GIT_AUTHOR_EMAIL": "hermes-chat@localhost",
    "GIT_COMMITTER_NAME": "Hermes Chat",
    "GIT_COMMITTER_EMAIL": "hermes-chat@localhost",
}


def keep_ref(path, rec, commit):
    ref = "refs/hermes-chat/recovery/%s/%d" % (rec["id"], now())
    git_ok(["update-ref", ref, commit, ZERO], path, read_only=False)
    if resolve(path, ref) != commit:
        raise Refusal("internal", "%s couldn't be read back, so nothing was removed." % ref)
    return ref


def tree_of(path, env, stage_all):
    """The tree of a copy of the worktree's index, as it is (`stage_all` false) or with every change and untracked
    file Git doesn't ignore added to it. The worktree's own index is never touched."""
    git_dir = text(git_ok(["rev-parse", "--absolute-git-dir"], path)).strip()
    index = text(git_ok(["rev-parse", "--path-format=absolute", "--git-path", "index"], path)).strip()
    fd, copy = tempfile.mkstemp(dir=git_dir, prefix="hermes-chat-keep.")
    os.close(fd)
    try:
        if os.path.exists(index):
            shutil.copyfile(index, copy)
        else:
            os.unlink(copy)
        env = dict(env, GIT_INDEX_FILE=copy)
        if stage_all:
            git_ok(["add", "-A", "--", "."], path, read_only=False, extra_env=env, timeout=600)
        return text(git_ok(["write-tree"], path, read_only=False, extra_env=env)).strip()
    finally:
        for p in (copy, copy + ".lock"):
            try:
                os.unlink(p)
            except OSError:
                pass


def keep_changes(rec, head, branch, files):
    """The worktree's changes, kept at refs/hermes-chat/recovery/<id>/<time> before anything is removed. What's staged
    is one commit on top of HEAD (only when it differs from HEAD), and everything Git doesn't ignore, untracked files
    included, is one more on top of that, so both the index and the working tree can be put back. Read back. With no
    changes (a detached HEAD only), the ref is HEAD."""
    path = rec["path"]
    if not files:
        return {"ref": keep_ref(path, rec, head), "commit": head, "staged": None}
    message = "Kept by Hermes Chat before removing the worktree %s (%s)" % (path, "branch " + branch if branch else "detached HEAD")
    staged_tree = tree_of(path, {}, False)
    head_tree = text(git_ok(["rev-parse", head + "^{tree}"], path)).strip() if head else None
    staged = None
    parent = head
    if staged_tree != head_tree:
        staged = text(git_ok(["commit-tree", staged_tree] + (["-p", head] if head else []), path, stdin=(message + ": what was staged\n").encode("utf-8"), extra_env=KEEPER)).strip()
        parent = staged
    work_tree = tree_of(path, {}, True)
    commit = text(git_ok(["commit-tree", work_tree] + (["-p", parent] if parent else []), path, stdin=(message + ": the working tree\n").encode("utf-8"), extra_env=KEEPER)).strip()
    ref = keep_ref(path, rec, commit)
    if text(git_ok(["rev-parse", ref + "^{tree}"], path)).strip() != work_tree:
        raise Refusal("internal", "The kept changes couldn't be read back from %s, so nothing was removed." % ref)
    return {"ref": ref, "commit": commit, "staged": staged}


def finish_removal(rec, gone):
    rec["state"] = "removed"
    rec["removed"] = gone
    rec.pop("removing", None)


def op_worktree_remove(req):
    _, common, trees = repo_trees(req.get("repo"))
    wid = check_id(req.get("id"))
    main = trees[0]["path"]
    with Registry(common) as reg:
        rec = reg.get(wid, ("ready", "removing"))
        if rec["state"] == "removing" and tree_at(trees, rec["path"]) is None and not os.path.lexists(rec["path"]):
            # A removal that stopped after the folder went: what it kept was recorded before, so it's finished now.
            finish_removal(rec, rec.get("removing") or {"at": now(), "head": None, "branch": rec["branch"], "kept": None, "files": 0, "unpushed": 0})
            reg.save()
            return {"record": rec, "output": ""}
        facts = removal_facts(trees, rec)
        if facts["blockers"]:
            raise Refusal("blocked", "Nothing was removed: " + " ".join(b["message"] for b in facts["blockers"]))
        if facts["stamp"] != req.get("stamp"):
            raise Refusal("stale", "The worktree changed since the preview. Nothing was removed. Look at the preview again.")
        rec["state"] = "removing"
        reg.save()
        try:
            kept = keep_changes(rec, facts["head"], facts["branch"], facts["files"]) if facts["files"] or facts["keepHead"] else None
            if kept:
                rec.setdefault("keptRefs", []).append(kept["ref"])
            pause = float(os.environ.get("HERMES_REPO_TEST_PAUSE_AFTER_KEEP") or 0)
            if pause:
                time.sleep(pause)
            # Anything written since the preview, while the changes were kept included, changes the stamp: then
            # nothing is removed (what was kept stays in its ref).
            again = removal_facts(trees, rec)
            if again["blockers"]:
                raise Refusal("blocked", "Nothing was removed: " + " ".join(b["message"] for b in again["blockers"]))
            if again["stamp"] != facts["stamp"]:
                raise Refusal("stale", "A file in the worktree changed while its changes were being kept. Nothing was removed.%s Look at the preview again." % (
                    " What was kept so far is in %s." % kept["ref"] if kept else ""))
            # Where the changes went is recorded before the folder goes, so a removal cut off now still says so.
            rec["removing"] = {"at": now(), "head": facts["head"], "branch": facts["branch"], "kept": kept, "files": facts["fileCount"], "unpushed": len(facts["unpushed"])}
            reg.save()
            if tree_at(trees, rec["path"])["locked"] is not None:
                git_ok(["worktree", "unlock", "--", rec["path"]], main, read_only=False)
            # --force only when there were changes, and only after they were kept, read back and checked again. A
            # single --force never overrides another tool's lock.
            args = ["worktree", "remove"] + (["--force"] if facts["files"] else []) + ["--", rec["path"]]
            code, out, _ = git(args, main, read_only=False, timeout=600, merge_output=True)
            if code != 0:
                raise Refusal("git", text(out).strip() or "git worktree remove failed.", text(out))
        except BaseException:
            if os.path.isdir(rec["path"]):
                lock_tree(main, rec)
                rec["state"] = "ready"
                rec.pop("removing", None)
            reg.save()
            raise
        finish_removal(rec, rec["removing"])
        reg.save()
        return {"record": rec, "output": text(out)}


def op_worktree_restore(req):
    """Makes a removed worktree again at its folder, on the branch it was on, and puts the kept changes back: the
    staged ones in its index and the rest in its working tree. Only if the branch is still where it was: otherwise the
    kept changes stay in their ref. A restore cut off part way is `restoring`, and sending it again finishes it."""
    _, common, trees = repo_trees(req.get("repo"))
    wid = check_id(req.get("id"))
    main = trees[0]["path"]
    with Registry(common) as reg:
        rec = reg.get(wid, ("removed", "restoring"))
        if rec["state"] == "removed":
            rec["restoring"] = dict(rec["removed"], applied=False)
        gone = rec["restoring"]
        branch = gone["branch"]
        made = tree_at(trees, rec["path"])
        claimed = next((r for r in reg.data["worktrees"].values() if r["id"] != wid and r["state"] != "removed" and same_path(r["path"], rec["path"])), None)
        if claimed or (made is not None and (rec["state"] != "restoring" or made["locked"] not in (None, LOCK_REASON + wid))):
            raise Refusal("path-exists", "Another worktree is at %s now. Nothing was made; the kept changes are still in %s." % (
                rec["path"], gone["kept"]["ref"] if gone["kept"] else "no ref (there were none)"))
        if made is None and os.path.lexists(rec["path"]):
            raise Refusal("path-exists", "%s exists on the server but isn't a worktree. Nothing was made over it." % rec["path"])
        if branch and made is None:
            holder = next((t for t in trees if t["branch"] == branch), None)
            if holder:
                raise Refusal("checked-out", "%s is checked out in %s now. Nothing was made." % (branch, holder["path"]))
            tip = resolve(main, "refs/heads/" + branch) if branch_exists(main, branch) else None
            if tip != gone["head"]:
                raise Refusal("moved", "%s isn't at %s any more%s. Nothing was made.%s" % (
                    branch, (gone["head"] or "")[:12], ", it's at %s" % tip[:12] if tip else ": it's gone",
                    " The kept changes are still in %s." % gone["kept"]["ref"] if gone["kept"] else ""))
        rec.update(state="restoring", branch=branch or rec["branch"], newBranch=False)
        reg.save()
        try:
            output = add_tree(main, trees, rec, detach_at=None if branch else gone["head"])
            kept = gone["kept"]
            if kept and not gone["applied"]:
                code, out, _ = git(["restore", "--source", kept["commit"], "--worktree", "--", "."], rec["path"], read_only=False, timeout=600, merge_output=True)
                output += text(out)
                if code == 0 and kept.get("staged"):
                    code, out, _ = git(["read-tree", kept["staged"]], rec["path"], read_only=False, timeout=600, merge_output=True)
                    output += text(out)
                if code != 0:
                    raise Refusal("git", "The worktree was made, but the kept changes couldn't be put back: %s They're still in %s. Restore again to retry." % (text(out).strip(), kept["ref"]), text(out))
                gone["applied"] = True
                reg.save()
        except BaseException:
            reg.save()
            raise
        # The setup's copies were ignored files, deleted with the folder: its steps run again (a link the kept
        # changes brought back is found already there).
        for step in rec["setup"]:
            if step["state"] == "done":
                step.update(state="pending", message="")
        gone.pop("applied", None)
        rec.update(state="ready", restoredAt=now(), restoredFrom=gone, removed=None, chats=[])
        rec.pop("restoring", None)
        reg.save()
        return {"record": rec, "output": output}


OPS.update(
    {
        "worktreeList": op_worktree_list,
        "worktreePlan": op_worktree_plan,
        "worktreeCreate": op_worktree_create,
        "worktreeSetup": op_worktree_setup,
        "worktreeAttach": op_worktree_attach,
        "worktreeDetach": op_worktree_detach,
        "worktreeProtect": op_worktree_protect,
        "worktreeForget": op_worktree_forget,
        "worktreeRemoval": op_worktree_removal,
        "worktreeRemove": op_worktree_remove,
        "worktreeRestore": op_worktree_restore,
    }
)
