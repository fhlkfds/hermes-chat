//! A named pipe carries requests on Windows. The first Hermes Chat creates the pipe with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE`, which Windows grants to exactly one creator, so of two launches at once only one
//! opens a window. Each request is one JSON line (remote.rs `encode`); the answer is `ok` or `error: why`.
//!
//! The pipe's default security lets only its creator's account (and the system and administrators) write to it, and
//! remote clients are refused, so another user can't send this app anything.

use super::{decode, encode, pipe_name, Inbox, Request, WIRE_MAX};
use std::io;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_PIPE_BUSY: i32 = 231;
const ANSWER_WITHIN: Duration = Duration::from_secs(5);
/// How often a queued Hermes Chat looks whether the one before it has exited.
const QUEUE_POLL: Duration = Duration::from_secs(1);

fn name() -> String {
    let var = |v: &str| std::env::var(v).unwrap_or_default();
    pipe_name(&var("USERDOMAIN"), &var("USERNAME"), &var("SESSIONNAME"))
}

fn listener(name: &str, first: bool) -> io::Result<NamedPipeServer> {
    ServerOptions::new().first_pipe_instance(first).reject_remote_clients(true).max_instances(8).create(name)
}

/// The pipe is another Hermes Chat's (or, with an open one gone, briefly no one's).
fn taken(e: &io::Error) -> bool {
    e.raw_os_error() == Some(ERROR_ACCESS_DENIED)
}

pub(super) fn hand_over(request: Option<Request>, inbox: &'static Inbox) -> bool {
    let name = name();
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("hermes-chat: no runtime for the request pipe, so shortcuts won't reach this window: {e}");
            return false;
        }
    };
    let claimed = {
        let _in = runtime.enter();
        listener(&name, true)
    };
    match claimed {
        Ok(server) => {
            std::thread::spawn(move || runtime.block_on(serve(server, name, inbox)));
        }
        Err(e) if taken(&e) => {
            if let Some(request) = request {
                match runtime.block_on(send(&name, &request)) {
                    Ok(()) => return true,
                    Err(e) => eprintln!("hermes-chat: the Hermes Chat already running didn't answer ({e}), so this one starts too"),
                }
            }
            std::thread::spawn(move || runtime.block_on(queue(name, inbox)));
        }
        Err(e) => eprintln!("hermes-chat: couldn't open {name}, so shortcuts and links won't reach this window: {e}"),
    }
    false
}

/// Waits for the Hermes Chat before this one to exit, as after an update's restart, then answers requests itself.
async fn queue(name: String, inbox: &'static Inbox) {
    eprintln!("hermes-chat: another Hermes Chat is running; shortcuts and links go to it until it closes");
    loop {
        match listener(&name, true) {
            Ok(server) => return serve(server, name, inbox).await,
            Err(e) if taken(&e) => tokio::time::sleep(QUEUE_POLL).await,
            Err(e) => return eprintln!("hermes-chat: couldn't open {name}: {e}"),
        }
    }
}

/// Answers each caller in turn. A new instance of the pipe is made before the connected one is answered, so there is
/// always one waiting and no second app can claim the name in between.
async fn serve(mut server: NamedPipeServer, name: String, inbox: &'static Inbox) {
    loop {
        let connected = server.connect().await;
        let next = match listener(&name, false) {
            Ok(next) => next,
            Err(e) => return eprintln!("hermes-chat: shortcuts and links stopped reaching this window: {e}"),
        };
        let caller = std::mem::replace(&mut server, next);
        match connected {
            Ok(()) => drop(tokio::spawn(answer(caller, inbox))),
            Err(e) => eprintln!("hermes-chat: a request on the pipe failed: {e}"),
        }
    }
}

async fn answer(pipe: NamedPipeServer, inbox: &'static Inbox) {
    let mut reader = BufReader::new(pipe);
    let mut line = String::new();
    let read = tokio::time::timeout(ANSWER_WITHIN, (&mut reader).take(WIRE_MAX as u64 + 1).read_line(&mut line)).await;
    let reply = match read {
        Ok(Ok(_)) => match decode(&line) {
            Ok(request) => {
                inbox.dispatch(request);
                "ok\n".to_owned()
            }
            Err(why) => format!("error: {why}\n"),
        },
        _ => return,
    };
    let mut pipe = reader.into_inner();
    if pipe.write_all(reply.as_bytes()).await.is_err() || pipe.flush().await.is_err() {
        return;
    }
    // Closing at once could drop the reply before the caller reads it; the caller closes once it has.
    let mut rest = [0u8; 64];
    let _ = tokio::time::timeout(ANSWER_WITHIN, pipe.read(&mut rest)).await;
}

/// Asks the running app. An error when none answers.
async fn send(name: &str, request: &Request) -> io::Result<()> {
    let deadline = Instant::now() + ANSWER_WITHIN;
    let pipe = loop {
        match ClientOptions::new().open(name) {
            Ok(pipe) => break pipe,
            // Every instance is busy, or the old one was just answered and its next isn't up yet.
            Err(e) if matches!(e.raw_os_error(), Some(ERROR_PIPE_BUSY | ERROR_FILE_NOT_FOUND)) && Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Err(e) => return Err(e),
        }
    };
    let exchange = async {
        let mut reader = BufReader::new(pipe);
        reader.get_mut().write_all(format!("{}\n", encode(request)).as_bytes()).await?;
        reader.get_mut().flush().await?;
        let mut reply = String::new();
        (&mut reader).take(4096).read_line(&mut reply).await?;
        Ok::<_, io::Error>(reply)
    };
    let reply = tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), exchange)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "no answer in time"))??;
    match reply.trim_end().strip_prefix("error: ") {
        None if reply.trim_end() == "ok" => Ok(()),
        None => Err(io::Error::other(format!("an answer that isn't one: {reply:?}"))),
        Some(why) => Err(io::Error::other(why.to_owned())),
    }
}
