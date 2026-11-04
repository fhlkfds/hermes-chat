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


def run(argv, cwd, read_only=True, stdin=None, timeout=60):
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
            stderr=subprocess.PIPE,
            env=environment(read_only),
            timeout=timeout,
        )
    except FileNotFoundError:
        raise Refusal("unsupported", "%s isn't installed on the server, or isn't on the PATH ssh gives it." % argv[0])
    except subprocess.TimeoutExpired:
        raise Refusal("timeout", "%s %s took longer than %d s, so it was stopped." % (argv[0], argv[1] if len(argv) > 1 else "", timeout))
    return proc.returncode, proc.stdout, proc.stderr


def git(args, cwd, **kw):
    # Every path given to git is literal: `*.ts` names a file called `*.ts`, not every TypeScript file.
    return run(["git", "--literal-pathspecs", "-c", "core.quotepath=false", "-c", "color.ui=never"] + args, cwd, **kw)


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


def safe_rel(path):
    """A path relative to the top of the working tree, as status reported it."""
    if not isinstance(path, str) or not path or "\0" in path or path.startswith("/"):
        raise Refusal("bad-path", "That isn't a path inside the repository.")
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
    top, git_dir = checkout(req.get("repo"))
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
    path = safe_rel(req.get("path"))
    orig = req.get("origPath")
    side = req.get("side")
    context = req.get("context", 3)
    if not isinstance(context, int) or context < 0:
        context = 3
    context = min(context, MAX_CONTEXT)
    common = ["--no-color", "--no-ext-diff", "--no-textconv", "-U%d" % context]
    if side == "staged":
        paths = [path] + ([safe_rel(orig)] if orig else [])
        code, out, err = git(["diff", "--cached", "-M"] + common + ["--"] + paths, top)
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
    }


OPS = {
    "status": op_status,
    "diff": op_diff,
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
