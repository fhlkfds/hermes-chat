//! SSH local forward to the dashboard on the server's loopback, using the system `ssh` so the
//! owner's ~/.ssh/config, agent and keys apply (ADR 0003; research doc §9 "SSH mode").

use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};

const READY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error)]
pub enum TunnelError {
    #[error("Enter an SSH target such as liam@hermes or a host alias from ~/.ssh/config.")]
    BadTarget,
    #[error("Couldn't start ssh: {0}")]
    Spawn(String),
    #[error("SSH failed: {0}")]
    Ssh(String),
    #[error("SSH didn't open the tunnel within {0}s.")]
    Timeout(u64),
}

/// A running `ssh -N -L`. Dropping it kills ssh.
pub struct Tunnel {
    _child: Child,
    pub local_port: u16,
}

pub async fn open(target: &str, remote_port: u16) -> Result<Tunnel, TunnelError> {
    open_within(target, remote_port, None).await
}

/// `open`, giving up sooner when `quick` is set: ssh's TCP connect after `quick`, and the whole tunnel after twice
/// that. A connection with several routes uses it, so a route that is down doesn't hold up the next (ADR 0056).
pub async fn open_within(target: &str, remote_port: u16, quick: Option<Duration>) -> Result<Tunnel, TunnelError> {
    let target = target.trim();
    // A leading '-' would be read as an ssh option.
    if target.is_empty() || target.starts_with('-') || target.contains(char::is_whitespace) {
        return Err(TunnelError::BadTarget);
    }
    let local_port = free_port().await.map_err(|e| TunnelError::Spawn(e.to_string()))?;
    let ready_within = quick.map_or(READY_TIMEOUT, |q| q * 2);
    let connect_timeout = quick.map(|q| format!("ConnectTimeout={}", q.as_secs().max(1)));
    let mut child = background_ssh();
    if let Some(option) = &connect_timeout {
        child.args(["-o", option]);
    }
    let mut child = child
        .args([
            "-N",
            "-o",
            "BatchMode=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-L",
            &format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
            "--",
            target,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| TunnelError::Spawn(e.to_string()))?;

    let deadline = tokio::time::Instant::now() + ready_within;
    loop {
        if let Some(_status) = child.try_wait().map_err(|e| TunnelError::Spawn(e.to_string()))? {
            let mut err = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                let _ = stderr.read_to_string(&mut err).await;
            }
            return Err(TunnelError::Ssh(err.trim().to_owned()));
        }
        if TcpStream::connect(("127.0.0.1", local_port)).await.is_ok() {
            return Ok(Tunnel { _child: child, local_port });
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(TunnelError::Timeout(ready_within.as_secs()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Options every `ssh` this app starts gets on this platform. Windows's OpenSSH can't share connections
/// (ControlMaster needs a Unix socket), so an ~/.ssh/config written for Linux that turns sharing on would make every
/// connection fail; there each ssh opens its own connection instead.
#[cfg(windows)]
pub const PLATFORM_SSH_OPTIONS: &[&str] = &["-o", "ControlMaster=no", "-o", "ControlPath=none"];
#[cfg(not(windows))]
pub const PLATFORM_SSH_OPTIONS: &[&str] = &[];

/// `ssh` with `PLATFORM_SSH_OPTIONS`, run in the background: on Windows without a console window of its own, which
/// the app (a windowed program) would otherwise open for it.
pub fn background_ssh() -> Command {
    let mut command = Command::new("ssh");
    command.args(PLATFORM_SSH_OPTIONS);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

async fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0)).await?.local_addr()?.port())
}
