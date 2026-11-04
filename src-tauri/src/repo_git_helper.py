# The Repository screen's helper on the Hermes server (ADR 0034). Rust sends this file, unchanged, as a constant
# `python3 -I -c` program over the owner's own ssh (repo_git.rs). Nothing the owner or the webview supplies is ever
# put in a command line for a shell: the request arrives on stdin as one JSON object, and this program runs `git`
# with an argument list it builds itself, never through a shell. The answer is one JSON object on stdout.
#
# Read-only operations run with GIT_OPTIONAL_LOCKS=0, so a status doesn't rewrite the index under an agent that is
# working in the same checkout.
#
# Kept to the Python 3.8 standard library.

import hashlib
import json
import os
import subprocess
import sys

VERSION = 1
# The most diff text one answer carries. A bigger diff is cut, and says so.
MAX_DIFF = 2 * 1024 * 1024
# The most status entries one answer carries.
MAX_ENTRIES = 5000
# How many untracked files are opened to see whether they're binary, and how much of each is read (as git does).
BINARY_SNIFF_FILES = 500
BINARY_SNIFF_BYTES = 8000
# The most lines of context a diff can ask for. "Whole file" asks for this many.
MAX_CONTEXT = 1000000


class Refusal(Exception):
    """A failure the screen shows as it is: `kind` says which, `message` says why in plain words."""

    def __init__(self, kind, message, output=""):
        Exception.__init__(self, message)
        self.kind = kind
        self.message = message
        self.output = output


def environment(read_only):
    env = dict(os.environ)
    # Never wait for an answer nobody can type: there is no terminal on this side of ssh.
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GH_PROMPT_DISABLED"] = "1"
    env["GIT_PAGER"] = "cat"
    env["PAGER"] = "cat"
    # Git's own messages in English, so failures can be told apart.
    env["LC_ALL"] = "C.UTF-8"
    env.pop("LANGUAGE", None)
    if read_only:
        env["GIT_OPTIONAL_LOCKS"] = "0"
    return env


def run(argv, cwd, read_only=True, stdin=None, timeout=60, merge_output=False):
    """(exit status, stdout bytes, stderr bytes) of `argv`, which is always git or gh, never a shell."""
    if argv[0] not in ("git", "gh"):
        raise Refusal("internal", "Only git and gh are run.")
    try:
        proc = subprocess.run(
            argv,
            cwd=cwd,
            input=stdin,
            stdin=None if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT if merge_output else subprocess.PIPE,
            env=environment(read_only),
            timeout=timeout,
        )
    except FileNotFoundError:
        raise Refusal("unsupported", "%s isn't installed on the server, or isn't on the PATH ssh gives it." % argv[0])
    except subprocess.TimeoutExpired:
        raise Refusal("timeout", "%s %s took longer than %d s, so it was stopped." % (argv[0], argv[1] if len(argv) > 1 else "", timeout))
    return proc.returncode, proc.stdout, proc.stderr or b""


# Settings the owner's config could change that would make a diff read, or a patch apply, differently from what the
# screen shows. The owner's hooks, identity and credentials are left alone.
PINNED = [
    "core.quotepath=false",
    "color.ui=never",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    "diff.srcPrefix=a/",
    "diff.dstPrefix=b/",
    "diff.relative=false",
    "diff.external=",
    "apply.whitespace=nowarn",
]


def git(args, cwd, **kw):
    # Every path given to git is literal: `*.ts` names a file called `*.ts`, not every TypeScript file.
    pinned = [a for kv in PINNED for a in ("-c", kv)]
    return run(["git", "--literal-pathspecs"] + pinned + args, cwd, **kw)


def text(raw):
    return raw.decode("utf-8", "replace")


def git_ok(args, cwd, **kw):
    code, out, err = git(args, cwd, **kw)
    if code != 0:
        raise Refusal("git", text(err).strip() or "git %s failed." % args[0], text(err))
    return out


# ── where ───────────────────────────────────────────────────────────────────


def checkout(repo):
    """The top of the working tree that holds `repo`, and its git directory."""
    if not isinstance(repo, str) or not repo.strip() or "\0" in repo:
        raise Refusal("bad-path", "Enter the repository's folder on the server, such as ~/projects/app.")
    path = os.path.expanduser(repo.strip())
    if not os.path.isabs(path):
        raise Refusal("bad-path", "Enter a full path on the server, starting with / or ~.")
    if not os.path.isdir(path):
        raise Refusal("not-found", "There's no folder %s on the server." % path)
    code, out, err = git(["rev-parse", "--show-toplevel", "--absolute-git-dir"], path)
    if code != 0:
        message = text(err).strip()
        if "not a git repository" in message:
            raise Refusal("not-repo", "%s isn't in a Git repository." % path, message)
        raise Refusal("git", message or "git rev-parse failed.", message)
    lines = text(out).splitlines()
    if len(lines) < 2 or not lines[0]:
        raise Refusal("not-repo", "%s is inside a Git directory, not a working tree." % path)
    return lines[0], lines[1]


def in_progress(git_dir):
    """The operation that's waiting to be finished in this checkout, if any."""
    def has(name):
        return os.path.exists(os.path.join(git_dir, name))

    if has("rebase-merge") or has("rebase-apply"):
        return "rebase"
    if has("MERGE_HEAD"):
        return "merge"
    if has("CHERRY_PICK_HEAD"):
        return "cherry-pick"
    if has("REVERT_HEAD"):
        return "revert"
    if has("BISECT_LOG"):
        return "bisect"
    return None


def safe_rel(path, top):
    """A path relative to the top of the working tree, as status reported it. It must name something inside the
    checkout: no absolute path, no `..`, and no folder on the way that is a link out of it. The file itself may be a
    link; Git shows a link as its target's name, never what it points at."""
    if not isinstance(path, str) or not path or "\0" in path or path.startswith("/"):
        raise Refusal("bad-path", "That isn't a path inside the repository.")
    if any(part in ("", ".", "..") for part in path.split("/")):
        raise Refusal("bad-path", "That isn't a path inside the repository.")
    root = os.path.realpath(top)
    parent = os.path.realpath(os.path.join(top, os.path.dirname(path)))
    if parent != root and not parent.startswith(root + os.sep):
        raise Refusal("bad-path", "%s is outside the repository, through a link." % path)
    return path


# ── status ──────────────────────────────────────────────────────────────────


def numstat(top, cached):
    """{path: [added, removed] or None for binary} for staged (`cached`) or unstaged changes."""
    args = ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"]
    args += ["--cached", "-M"] if cached else ["--no-renames"]
    code, out, _ = git(args, top)
    counts = {}
    if code != 0:
        return counts
    fields = text(out).split("\0")
    i = 0
    while i < len(fields):
        rec = fields[i]
        i += 1
        if not rec:
            continue
        parts = rec.split("\t", 2)
        if len(parts) < 3:
            continue
        added, removed, path = parts
        if path == "":
            # A rename: the old path, then the new one, follow as their own fields.
            path = fields[i + 1] if i + 1 < len(fields) else ""
            i += 2
        counts[path] = None if added == "-" else [int(added or 0), int(removed or 0)]
    return counts


def sniff_binary(top, rel):
    try:
        full = os.path.join(top, rel)
        if os.path.islink(full) or not os.path.isfile(full):
            return False
        with open(full, "rb") as f:
            return b"\0" in f.read(BINARY_SNIFF_BYTES)
    except OSError:
        return False


def op_status(req):
    """The checkout's state. HEAD and the index are stamped before and after reading, and read again (at most three
    times) if anything moved in between, so the stamps a later write checks belong to exactly the list shown."""
    top, git_dir = checkout(req.get("repo"))
    for _ in range(3):
        before = (head_oid(top), index_stamp(top))
        reply = status_once(top, git_dir)
        after = (head_oid(top), index_stamp(top))
        if before == after:
            break
    else:
        raise Refusal("busy", "The repository kept changing while it was read (another tool is working in it). Refresh in a moment.")
    reply["head"], reply["index"] = after
    return reply


def status_once(top, git_dir):
    code, out, err = git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], top)
    if code != 0:
        raise Refusal("git", text(err).strip() or "git status failed.", text(err))
    branch = {"oid": None, "head": None, "detached": False, "upstream": None, "ahead": None, "behind": None}
    entries = []
    truncated = False
    records = text(out).split("\0")
    i = 0
    while i < len(records):
        rec = records[i]
        i += 1
        if not rec:
            continue
        if rec.startswith("# branch.oid "):
            oid = rec[len("# branch.oid "):]
            branch["oid"] = None if oid == "(initial)" else oid
        elif rec.startswith("# branch.head "):
            head = rec[len("# branch.head "):]
            branch["detached"] = head == "(detached)"
            branch["head"] = None if branch["detached"] else head
        elif rec.startswith("# branch.upstream "):
            branch["upstream"] = rec[len("# branch.upstream "):]
        elif rec.startswith("# branch.ab "):
            ab = rec.split(" ")
            branch["ahead"] = int(ab[2].lstrip("+"))
            branch["behind"] = int(ab[3].lstrip("-"))
        elif rec.startswith("#"):
            continue
        else:
            entry = None
            tag = rec[0]
            if tag == "1":
                f = rec.split(" ", 8)
                entry = {"kind": "ordinary", "x": f[1][0], "y": f[1][1], "sub": f[2] != "N...",
                         "modes": [f[3], f[4], f[5]], "path": f[8]}
            elif tag == "2":
                f = rec.split(" ", 9)
                orig = records[i] if i < len(records) else ""
                i += 1
                entry = {"kind": "renamed" if f[8].startswith("R") else "copied", "x": f[1][0], "y": f[1][1],
                         "sub": f[2] != "N...", "modes": [f[3], f[4], f[5]], "score": f[8], "path": f[9],
                         "origPath": orig}
            elif tag == "u":
                f = rec.split(" ", 10)
                entry = {"kind": "unmerged", "x": f[1][0], "y": f[1][1], "sub": f[2] != "N...",
                         "modes": [f[3], f[4], f[5], f[6]], "path": f[10]}
            elif tag == "?":
                entry = {"kind": "untracked", "x": "?", "y": "?", "sub": False, "path": rec[2:]}
            if entry is None:
                continue
            if len(entries) >= MAX_ENTRIES:
                truncated = True
                continue
            entries.append(entry)

    staged = numstat(top, True)
    unstaged = numstat(top, False)
    sniffed = 0
    for e in entries:
        if e["kind"] == "untracked":
            if sniffed < BINARY_SNIFF_FILES:
                sniffed += 1
                e["binary"] = sniff_binary(top, e["path"])
            continue
        if e["x"] not in (".", "?") and e["kind"] != "unmerged":
            c = staged.get(e["path"], False)
            if c is not False:
                e["staged"] = c
        if e["y"] not in (".", "?") and e["kind"] != "unmerged":
            c = unstaged.get(e["path"], False)
            if c is not False:
                e["unstaged"] = c
    for e in entries:
        if e["kind"] == "untracked" or (e["y"] not in (".", "?")):
            e["worktree"] = worktree_stamp(top, e["path"])
    return {
        "top": top,
        "gitDir": git_dir,
        "branch": branch,
        "operation": in_progress(git_dir),
        "entries": entries,
        "truncated": truncated,
    }


# ── diff ────────────────────────────────────────────────────────────────────


def capped(raw):
    cut = len(raw) > MAX_DIFF
    body = raw[:MAX_DIFF] if cut else raw
    # Lossy: some bytes aren't UTF-8, so the text shown isn't byte for byte what git printed. A cut that only split
    # the last character doesn't count.
    lossy = False
    try:
        body.decode("utf-8")
    except UnicodeDecodeError as e:
        lossy = not (cut and e.start >= len(body) - 3)
    return body.decode("utf-8", "replace"), cut, lossy


def op_diff(req):
    top, _ = checkout(req.get("repo"))
    path = safe_rel(req.get("path"), top)
    orig = req.get("origPath")
    side = req.get("side")
    context = req.get("context", 3)
    if not isinstance(context, int) or context < 0:
        context = 3
    context = min(context, MAX_CONTEXT)
    common = ["--no-color", "--no-ext-diff", "--no-textconv", "-U%d" % context]
    if side == "staged":
        paths = [path] + ([safe_rel(orig, top)] if orig else [])
        renames = ["-M"] if orig else ["--no-renames"]
        code, out, err = git(["diff", "--cached"] + renames + common + ["--"] + paths, top)
    elif side == "unstaged":
        code, out, err = git(["diff", "--no-renames"] + common + ["--", path], top)
    elif side == "conflict":
        code, out, err = git(["diff"] + common + ["--", path], top)
    elif side == "untracked":
        if not os.path.lexists(os.path.join(top, path)):
            raise Refusal("stale", "%s isn't there any more. Refresh to see the repository as it is now." % path)
        code, out, err = git(["diff", "--no-index"] + common + ["--", os.devnull, path], top)
        # --no-index exits 1 when the files differ, which they always do here.
        if code == 1:
            code = 0
    else:
        raise Refusal("internal", "Unknown diff side.")
    if code != 0:
        raise Refusal("git", text(err).strip() or "git diff failed.", text(err))
    diff, cut, lossy = capped(out)
    # The file's bytes as this diff shows them, when the diff is of the working tree: the screen compares it with
    # the list's, and won't stage from a list older than the diff on screen.
    worktree = worktree_stamp(top, path) if side in ("unstaged", "untracked") else None
    stages = []
    if side == "conflict":
        lines = text(git_ok(["ls-files", "-u", "-z", "--", path], top)).split("\0")
        stages = sorted({int(l.split(" ")[2].split("\t")[0]) for l in lines if l})
    return {
        "diff": diff,
        "truncated": cut,
        "lossy": lossy,
        "bytes": len(out),
        "sha": hashlib.sha256(out).hexdigest(),
        "stages": stages,
        "worktree": worktree,
        "head": head_oid(top),
        "index": index_stamp(top),
    }


# ── stamps: what a write checks first ───────────────────────────────────────


def head_oid(top):
    code, out, _ = git(["rev-parse", "-q", "--verify", "HEAD^{commit}"], top)
    return text(out).strip() if code == 0 else None


def index_stamp(top):
    """SHA-256 of every index entry (mode, blob, stage, path): any staging, unstaging or conflict change alters it."""
    return hashlib.sha256(git_ok(["ls-files", "--stage", "-z"], top)).hexdigest()


def worktree_stamp(top, rel):
    """SHA-256 of a working-tree file's bytes (a link's target for a symbolic link), or None when it's gone."""
    full = os.path.join(top, rel)
    try:
        if os.path.islink(full):
            return hashlib.sha256(b"link:" + os.readlink(full).encode("utf-8", "surrogateescape")).hexdigest()
        if not os.path.isfile(full):
            return None
        h = hashlib.sha256()
        with open(full, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
        return h.hexdigest()
    except OSError:
        return None


def check_stamps(top, expect):
    """Refuses, changing nothing, when HEAD or the index isn't what the screen last read."""
    if not isinstance(expect, dict):
        raise Refusal("internal", "The request didn't say which HEAD and index it was made for.")
    head, index = head_oid(top), index_stamp(top)
    moved = []
    if head != expect.get("head"):
        moved.append("HEAD moved (a commit, checkout or reset happened)")
    if index != expect.get("index"):
        moved.append("the staged changes changed")
    if moved:
        raise Refusal(
            "stale",
            "Since this screen last read the repository, %s. Nothing was changed. Refresh and check again." % " and ".join(moved),
        )
    return head, index


def check_files(top, files):
    """Each file must still have the bytes the screen read for it, so nothing newer is staged unseen."""
    paths = []
    for f in files:
        rel = safe_rel(f.get("path") if isinstance(f, dict) else None, top)
        if worktree_stamp(top, rel) != f.get("worktree"):
            raise Refusal(
                "stale",
                "%s changed on the server since this screen read it. Nothing was staged. Refresh and look at it again." % rel,
            )
        paths.append(rel)
    if not paths:
        raise Refusal("internal", "No files were named.")
    return paths


def stamps(top):
    return {"head": head_oid(top), "index": index_stamp(top)}


# ── staging ─────────────────────────────────────────────────────────────────


def op_stage(req):
    """Stages exactly the files named, each as the screen read it. Never everything."""
    top, _ = checkout(req.get("repo"))
    check_stamps(top, req.get("expect"))
    paths = check_files(top, req.get("files") or [])
    git_ok(["add", "--"] + paths, top, read_only=False)
    return stamps(top)


def op_unstage(req):
    """Takes the files named out of the index, back to HEAD's version. The working tree is left alone."""
    top, _ = checkout(req.get("repo"))
    head, _ = check_stamps(top, req.get("expect"))
    paths = [safe_rel(p, top) for p in (req.get("paths") or [])]
    if not paths:
        raise Refusal("internal", "No files were named.")
    if head is None:
        # Before the first commit there's no HEAD to go back to: unstaging takes the file out of the index.
        git_ok(["rm", "--cached", "--quiet", "--"] + paths, top, read_only=False)
    else:
        git_ok(["restore", "--staged", "--"] + paths, top, read_only=False)
    return stamps(top)


def op_apply(req):
    """Stages (or, with `reverse`, unstages) hunks: a patch the screen built from a diff it showed. The diff is read
    again first, and must be byte for byte the one shown; `git apply --cached` then touches only the index."""
    top, _ = checkout(req.get("repo"))
    check_stamps(top, req.get("expect"))
    path = safe_rel(req.get("path"), top)
    reverse = req.get("reverse") is True
    context = req.get("context")
    if not isinstance(context, int) or context < 0:
        raise Refusal("internal", "The request didn't say which diff the hunks came from.")
    side = ["--cached"] if reverse else []
    code, out, err = git(["diff"] + side + ["--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "-U%d" % context, "--", path], top)
    if code != 0:
        raise Refusal("git", text(err).strip() or "git diff failed.", text(err))
    if hashlib.sha256(out).hexdigest() != req.get("diffSha"):
        raise Refusal("stale", "The diff of %s changed since it was shown. Nothing was staged. Look at it again." % path)
    patch = req.get("patch")
    if not isinstance(patch, str) or not patch:
        raise Refusal("internal", "No hunks were sent.")
    args = ["apply", "--cached", "--recount"] + (["--reverse"] if reverse else [])
    if context == 0:
        # A diff with no context lines: git apply refuses one unless told it's meant (git-apply(1), --unidiff-zero).
        args.append("--unidiff-zero")
    code, _, err = git(args + ["--check", "-"], top, stdin=patch.encode("utf-8"))
    if code != 0:
        raise Refusal("stale", "Git can't apply that hunk to the index as it is now. Nothing was changed. Refresh and try again.", text(err))
    git_ok(args + ["-"], top, read_only=False, stdin=patch.encode("utf-8"))
    return stamps(top)


# ── commit ──────────────────────────────────────────────────────────────────

COMMIT_HOOKS = ("pre-commit", "prepare-commit-msg", "commit-msg", "post-commit")


def hooks(top):
    """The commit hooks Git will run here: executable files in core.hooksPath, or the repository's hooks folder."""
    code, out, _ = git(["config", "--get", "core.hooksPath"], top)
    folder = text(out).strip() if code == 0 else ""
    if folder:
        folder = os.path.expanduser(folder)
        if not os.path.isabs(folder):
            folder = os.path.join(top, folder)
    else:
        folder = text(git_ok(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], top)).strip()
    found = []
    for name in COMMIT_HOOKS:
        p = os.path.join(folder, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            found.append(name)
    return folder, found


def ident(top, role):
    code, out, err = git(["var", "GIT_%s_IDENT" % role], top)
    if code != 0:
        return None
    # "Name <email> 1700000000 +0000": the time isn't part of who.
    return text(out).strip().rsplit(" ", 2)[0]


def staged_raw(top):
    """The staged changes as `git diff --raw` lists them, with full object names: what a commit of the index adds."""
    return git_ok(["diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z"], top)


def name_status(raw):
    """[{status, path}] from `--raw -z` output, without renames."""
    fields = text(raw).split("\0")
    out = []
    i = 0
    while i + 1 < len(fields):
        meta, path = fields[i], fields[i + 1]
        i += 2
        if not meta.startswith(":"):
            continue
        parts = meta.split(" ")
        out.append({"status": parts[4][0], "path": path, "oldMode": parts[0][1:], "newMode": parts[1]})
    return out


def op_preview(req):
    """Exactly what a commit now would hold: the staged diff, its files, the HEAD it would follow, who would author
    it, and which hooks would run. The stamps it returns are what the commit request must match."""
    top, git_dir = checkout(req.get("repo"))
    head = head_oid(top)
    raw = staged_raw(top)
    code, out, err = git(["diff", "--cached", "-M", "--no-color", "--no-ext-diff", "--no-textconv", "--stat=200", "--patch"], top)
    if code != 0:
        raise Refusal("git", text(err).strip() or "git diff failed.", text(err))
    diff, cut, lossy = capped(out)
    code, ns, _ = git(["diff", "--cached", "-M", "--name-status", "-z"], top)
    renames = {}
    fields = text(ns).split("\0")
    i = 0
    while i < len(fields):
        st = fields[i]
        if st.startswith(("R", "C")) and i + 2 < len(fields):
            renames[fields[i + 2]] = {"from": fields[i + 1], "score": st}
            i += 3
        else:
            i += 2
    unmerged = bool(text(git_ok(["ls-files", "-u", "-z"], top)))
    folder, found = hooks(top)
    code, branch, _ = git(["symbolic-ref", "-q", "--short", "HEAD"], top)
    recent = text(git(["log", "-n", "10", "--format=%s"], top)[1]).splitlines() if head else []
    return {
        "head": head,
        "index": index_stamp(top),
        "branch": text(branch).strip() if code == 0 else None,
        "files": name_status(raw),
        "renames": renames,
        "rawSha": hashlib.sha256(raw).hexdigest(),
        "diff": diff,
        "truncated": cut,
        "lossy": lossy,
        "unmerged": unmerged,
        "operation": in_progress(git_dir),
        "author": ident(top, "AUTHOR"),
        "committer": ident(top, "COMMITTER"),
        "hooksPath": folder,
        "hooks": found,
        "recent": recent,
    }


def classify_commit_failure(output, hook_names):
    o = output.lower()
    if "please tell me who you are" in o or "unable to auto-detect email" in o or "empty ident name" in o:
        return "identity", "Git doesn't know who the author is on the server. Set user.name and user.email there (git config), then commit again."
    if "index.lock" in o:
        return "locked", "Another Git process holds the index lock (index.lock). Wait for it to finish, then commit again."
    if "unmerged files" in o or "unresolved conflict" in o:
        return "conflict", "There are unresolved conflicts. Resolve them first."
    if "nothing to commit" in o or "no changes added to commit" in o or "nothing added to commit" in o:
        return "nothing-staged", "Nothing is staged, so there's nothing to commit."
    if [h for h in hook_names if h != "post-commit"]:
        return "hook", "A hook refused the commit (%s). Its output is below. Nothing was committed." % ", ".join(h for h in hook_names if h != "post-commit")
    return "git", "Git refused the commit. Its output is below. Nothing was committed."


def op_commit(req):
    """Commits the index, only if HEAD and the index are exactly what the preview showed. Hooks run as Git runs them;
    nothing is bypassed. The message is committed verbatim, as previewed. Afterwards the new commit is read back and
    compared with the preview."""
    top, _ = checkout(req.get("repo"))
    message = req.get("message")
    if not isinstance(message, str) or not message.strip():
        raise Refusal("empty-message", "Write a commit message first.")
    if not message.endswith("\n"):
        message += "\n"
    expect = req.get("expect")
    head, _ = check_stamps(top, expect)
    raw = staged_raw(top)
    if hashlib.sha256(raw).hexdigest() != (expect or {}).get("rawSha"):
        raise Refusal("stale", "The staged changes aren't the ones previewed. Nothing was committed. Preview again.")
    if not raw:
        raise Refusal("nothing-staged", "Nothing is staged, so there's nothing to commit.")
    if text(git_ok(["ls-files", "-u", "-z"], top)):
        raise Refusal("conflict", "There are unresolved conflicts. Resolve them before committing.")
    _, hook_names = hooks(top)
    code, out, _ = git(["commit", "--cleanup=verbatim", "-F", "-"], top, read_only=False, stdin=message.encode("utf-8"), timeout=600, merge_output=True)
    output = text(out)
    after = head_oid(top)
    if code != 0 or after == head:
        kind, why = classify_commit_failure(output, hook_names)
        # A refused commit leaves HEAD alone; a hook may still have changed files, so say whether the index moved.
        raise Refusal(kind, why, output)
    parents = text(git_ok(["rev-list", "--parents", "-n", "1", after], top)).split()[1:]
    if parents != ([head] if head else []):
        raise Refusal("lost", "A commit was made, but not on top of the HEAD that was checked. Refresh and look at the history in the Terminal.", output)
    tree_args = ["diff-tree", "-r", "--raw", "--no-abbrev", "--no-renames", "--no-commit-id", "-z"] + (["--root"] if head is None else [])
    committed = git_ok(tree_args + [after], top)
    return {
        "head": after,
        "subject": message.splitlines()[0],
        "output": output,
        "matches": committed == raw,
        "files": name_status(committed),
        "branch": (lambda r: text(r[1]).strip() if r[0] == 0 else None)(git(["symbolic-ref", "-q", "--short", "HEAD"], top)),
    }


OPS = {
    "status": op_status,
    "diff": op_diff,
    "stage": op_stage,
    "unstage": op_unstage,
    "apply": op_apply,
    "preview": op_preview,
    "commit": op_commit,
}


def main():
    try:
        req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        op = OPS.get(req.get("op")) if isinstance(req, dict) else None
        if op is None:
            raise Refusal("internal", "Unknown request.")
        reply = {"ok": True, "v": VERSION, "result": op(req)}
    except Refusal as r:
        reply = {"ok": False, "v": VERSION, "error": {"kind": r.kind, "message": r.message, "output": r.output}}
    except Exception as e:  # noqa: BLE001 - anything else is a bug here, reported as one
        reply = {"ok": False, "v": VERSION, "error": {"kind": "internal", "message": "The helper failed: %r" % (e,), "output": ""}}
    # The mark sets the answer apart from anything a login script printed first (repo_git.rs, MARK).
    sys.stdout.write("\x1ehermes-repo\x1e" + json.dumps(reply))
    sys.stdout.flush()


main()
