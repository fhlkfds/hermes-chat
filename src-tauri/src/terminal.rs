//! A terminal on the server: the system `ssh` run in a pseudo-terminal, so the owner's ~/.ssh/config, agent and keys
//! apply, and ssh can ask in the terminal for a passphrase, a password or a new host key (ADR 0022). The webview draws
//! the screen (xterm.js); Rust only moves bytes. What the owner types goes to ssh as typed, and what ssh prints comes
//! back as raw bytes, base64 in a channel event, so a UTF-8 character split across reads isn't mangled.
//!
//! Each terminal is a session of its own, closed by `close`, by ssh exiting, or by the app exiting (the PTY closes, and
//! ssh gets a hangup).

use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::process::Command;
use tokio::sync::oneshot;

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("Enter an SSH target such as liam@hermes or a host alias from ~/.ssh/config.")]
    BadTarget,
    #[error("Couldn't open a terminal: {0}")]
    Pty(String),
    #[error("Couldn't start ssh: {0}")]
    Spawn(String),
    #[error("That terminal has closed.")]
    Gone,
    #[error("Couldn't send to the terminal: {0}")]
    Write(String),
}

impl Serialize for TerminalError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// What a terminal tells the webview: output as it comes, then, once, how it ended.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    /// Bytes ssh wrote, base64.
    Output { data: String },
    /// ssh exited: `code` is its exit status, or none if a signal ended it (as `close` does).
    Exit { code: Option<i32> },
}

struct Session {
    /// The PTY's master side: writes go to ssh as typed; also sized from here.
    master: Arc<File>,
    /// Ends ssh. Dropped with the session, which ends it too.
    kill: Option<oneshot::Sender<()>>,
}

/// The terminals open now, by id.
#[derive(Default)]
pub struct Terminals {
    next: Mutex<u64>,
    open: Mutex<HashMap<u64, Session>>,
}

/// `ssh` to `target` in a terminal of `cols` × `rows`. A leading '-' would be read as an option, and whitespace would
/// make it more than a target, so both are refused, as the tunnel refuses them.
pub fn ssh_command(target: &str) -> Result<Command, TerminalError> {
    let target = target.trim();
    if target.is_empty() || target.starts_with('-') || target.contains(char::is_whitespace) {
        return Err(TerminalError::BadTarget);
    }
    let mut command = Command::new("ssh");
    // `-t`: a login shell in a terminal even if the owner's config sets a RemoteCommand. Host key checking is left to
    // the owner's config: in a terminal ssh can ask, and the owner answers.
    command.args(["-t", "-o", "ServerAliveInterval=15", "--", target]);
    Ok(command)
}

impl Terminals {
    /// Starts `command` in a new PTY of `cols` × `rows`, sending what it prints, then how it ended, to `on_event`.
    pub fn open(
        &self,
        mut command: Command,
        cols: u16,
        rows: u16,
        on_event: impl Fn(TerminalEvent) + Send + 'static,
    ) -> Result<u64, TerminalError> {
        let (master, slave) = open_pty(cols, rows).map_err(|e| TerminalError::Pty(e.to_string()))?;
        let stdio = |fd: &OwnedFd| fd.try_clone().map(Stdio::from).map_err(|e| TerminalError::Pty(e.to_string()));
        command
            .stdin(stdio(&slave)?)
            .stdout(stdio(&slave)?)
            .stderr(stdio(&slave)?)
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .kill_on_drop(true);
        // SAFETY: only async-signal-safe calls between fork and exec. A session of its own, with the PTY as its
        // controlling terminal, so ssh can read a passphrase from it and gets a hangup when it closes.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(|e| TerminalError::Spawn(e.to_string()))?;
        // Only ssh holds the slave now, so reading the master ends once ssh has exited.
        drop(slave);
        drop(command);

        let master = Arc::new(File::from(master));
        let (kill, killed) = oneshot::channel::<()>();
        let (exited, exit) = oneshot::channel::<Option<i32>>();
        tokio::spawn(async move {
            let status = tokio::select! {
                status = child.wait() => status,
                _ = killed => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            let _ = exited.send(status.ok().and_then(|s| s.code()));
        });
        let mut reader = master.try_clone().map_err(|e| TerminalError::Pty(e.to_string()))?;
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    // Linux reads EIO once the slave side has no one left.
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_event(TerminalEvent::Output { data: base64::engine::general_purpose::STANDARD.encode(&buf[..n]) }),
                }
            }
            // Everything ssh wrote has gone out; how it ended comes last.
            let code = exit.blocking_recv().unwrap_or(None);
            on_event(TerminalEvent::Exit { code });
        });

        let mut next = self.next.lock().unwrap();
        *next += 1;
        self.open.lock().unwrap().insert(*next, Session { master, kill: Some(kill) });
        Ok(*next)
    }

    /// Sends what the owner typed or pasted to terminal `id`.
    pub fn write(&self, id: u64, data: &[u8]) -> Result<(), TerminalError> {
        let master = self.master(id)?;
        (&*master).write_all(data).map_err(|e| TerminalError::Write(e.to_string()))
    }

    /// Tells terminal `id`, and so the shell on the server, its new size.
    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let master = self.master(id)?;
        set_size(master.as_raw_fd(), cols, rows).map_err(|e| TerminalError::Pty(e.to_string()))
    }

    /// Ends terminal `id`'s ssh. Its Exit event still comes. Closing one that has gone does nothing.
    pub fn close(&self, id: u64) {
        if let Some(mut s) = self.open.lock().unwrap().remove(&id) {
            if let Some(kill) = s.kill.take() {
                let _ = kill.send(());
            }
        }
    }

    fn master(&self, id: u64) -> Result<Arc<File>, TerminalError> {
        self.open.lock().unwrap().get(&id).map(|s| s.master.clone()).ok_or(TerminalError::Gone)
    }
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 }
}

/// A new PTY pair of `cols` × `rows`: (master, slave), both closed on exec.
fn open_pty(cols: u16, rows: u16) -> std::io::Result<(OwnedFd, OwnedFd)> {
    let (mut master, mut slave) = (-1, -1);
    let size = winsize(cols, rows);
    // SAFETY: openpty writes two new descriptors, which are owned from here on.
    let r = unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), &size) };
    if r == -1 {
        return Err(std::io::Error::last_os_error());
    }
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    for fd in [&master, &slave] {
        // SAFETY: plain fcntl on a descriptor owned here.
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok((master, slave))
}

fn set_size(fd: i32, cols: u16, rows: u16) -> std::io::Result<()> {
    let size = winsize(cols, rows);
    // SAFETY: TIOCSWINSZ reads one winsize.
    if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &size) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc;

    /// Runs `script` in `sh` in a terminal, and gives back the terminal's id, everything it printed and how it ended.
    async fn run(terminals: &Terminals, script: &str, cols: u16, rows: u16, input: Option<&[u8]>) -> (String, Option<i32>) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        let id = terminals.open(command, cols, rows, move |e| drop(tx.send(e))).unwrap();
        if let Some(input) = input {
            terminals.write(id, input).unwrap();
        }
        let mut out = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("terminal timed out") {
                Some(TerminalEvent::Output { data }) => out.extend(base64::engine::general_purpose::STANDARD.decode(data).unwrap()),
                Some(TerminalEvent::Exit { code }) => return (String::from_utf8_lossy(&out).into_owned(), code),
                None => panic!("events ended without an exit"),
            }
        }
    }

    #[tokio::test]
    async fn runs_in_a_terminal_of_the_given_size_and_reports_the_exit_status() {
        let t = Terminals::default();
        let (out, code) = run(&t, "test -t 0 && echo tty; stty size; echo $TERM; exit 3", 101, 33, None).await;
        assert!(out.contains("tty"), "{out:?}");
        assert!(out.contains("33 101"), "{out:?}");
        assert!(out.contains("xterm-256color"), "{out:?}");
        assert_eq!(code, Some(3));
    }

    #[tokio::test]
    async fn what_is_typed_reaches_the_program() {
        let t = Terminals::default();
        let (out, code) = run(&t, "read line; echo \"got:$line\"", 80, 24, Some(b"h\xc3\xa9llo\r")).await;
        assert!(out.contains("got:héllo"), "{out:?}");
        assert_eq!(code, Some(0));
    }

    #[tokio::test]
    async fn resizing_reaches_the_program() {
        let t = Terminals::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut command = Command::new("sh");
        command.args(["-c", "read _; stty size"]);
        let id = t.open(command, 80, 24, move |e| drop(tx.send(e))).unwrap();
        t.resize(id, 132, 50).unwrap();
        t.write(id, b"\r").unwrap();
        let mut out = String::new();
        while let Some(e) = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap() {
            match e {
                TerminalEvent::Output { data } => out.push_str(&String::from_utf8_lossy(&base64::engine::general_purpose::STANDARD.decode(data).unwrap())),
                TerminalEvent::Exit { .. } => break,
            }
        }
        assert!(out.contains("50 132"), "{out:?}");
    }

    #[tokio::test]
    async fn closing_ends_the_program_and_still_reports_the_end() {
        let t = Terminals::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let id = t.open(command, 80, 24, move |e| drop(tx.send(e))).unwrap();
        t.close(id);
        let end = loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap() {
                Some(TerminalEvent::Exit { code }) => break code,
                Some(_) => continue,
                None => panic!("no exit"),
            }
        };
        assert_eq!(end, None, "a signal ended it");
        assert!(matches!(t.write(id, b"x"), Err(TerminalError::Gone)));
        t.close(id);
    }

    #[test]
    fn refuses_a_target_ssh_would_read_as_an_option() {
        for bad in ["", "  ", "-oProxyCommand=evil", "liam@hermes ls"] {
            assert!(matches!(ssh_command(bad), Err(TerminalError::BadTarget)), "{bad:?}");
        }
        let c = ssh_command(" liam@hermes ").unwrap();
        let args: Vec<_> = c.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args.last().map(String::as_str), Some("liam@hermes"));
        assert_eq!(args[args.len() - 2], "--");
    }
}
