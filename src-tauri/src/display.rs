//! The side panel's Screen: a profile's Bot Desktop on the Hermes server, streamed as raw RFB over
//! `/api/display/ws` (ADR 0033). The webview asks Hermes for a single-use ticket over `/api/ws` (`display.observe`) and
//! hands it here. Rust opens the socket on the signed-in connection, with the owner's extra request headers, and moves
//! bytes both ways; noVNC in the webview speaks RFB. What input reaches the screen is Hermes's call (its lease and its
//! RFB filter), not this relay's.
//!
//! Every socket is closed when the connection is replaced or closed, as transfers are (ADR 0023), and before it goes,
//! so the close still has the SSH tunnel to travel through. Closing one sends a normal close (1000), which Hermes takes
//! as the viewer leaving: control the owner took goes back to the agent.

use crate::transport::{Dashboard, TransportError};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

/// Hermes's tickets are short; anything far longer isn't one.
const MAX_TICKET: usize = 512;
/// How long a close may take to send before the socket is just dropped.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

/// What a screen socket reports: RFB bytes as they come, then, once, how it closed. `code` is the WebSocket close
/// code: Hermes's own (4000 control taken by another viewer, 4001 the screen isn't running, 4401 a bad ticket), 1000
/// for a normal close, 1006 when the connection broke.
#[derive(Debug, PartialEq)]
pub enum DisplayEvent {
    Data(Vec<u8>),
    Closed { code: u16, reason: String },
}

/// One open screen socket. Dropping it closes the socket normally; `close` also says when that is done.
pub struct DisplaySocket {
    outgoing: mpsc::UnboundedSender<Vec<u8>>,
    task: JoinHandle<()>,
}

impl DisplaySocket {
    pub fn send(&self, bytes: Vec<u8>) -> Result<(), TransportError> {
        self.outgoing.send(bytes).map_err(|_| TransportError::Closed)
    }

    /// Closes the socket normally; the handle ends once the close has gone out, or `CLOSE_WAIT` has passed.
    pub fn close(self) -> JoinHandle<()> {
        drop(self.outgoing);
        self.task
    }
}

/// Waits for sockets `close_all` closed to send their close, at most a little over `CLOSE_WAIT`.
pub async fn closed(tasks: Vec<JoinHandle<()>>) {
    let _ = tokio::time::timeout(CLOSE_WAIT + Duration::from_millis(500), futures_util::future::join_all(tasks)).await;
}

fn checked_ticket(ticket: &str) -> Result<&str, TransportError> {
    let ok = !ticket.is_empty() && ticket.len() <= MAX_TICKET && ticket.chars().all(|c| c.is_ascii_graphic());
    if ok {
        Ok(ticket)
    } else {
        Err(TransportError::WebSocket("Hermes gave the screen a ticket that isn't one.".into()))
    }
}

/// Opens `/api/display/ws` with `ticket` on `dashboard`'s connection.
pub async fn open(dashboard: Arc<Dashboard>, ticket: &str, on_event: impl Fn(DisplayEvent) + Send + 'static) -> Result<DisplaySocket, TransportError> {
    let handshake = dashboard.ws_handshake("api/display/ws", &[("display_ticket", checked_ticket(ticket)?)])?;
    let (ws, _) = tokio_tungstenite::connect_async(handshake).await.map_err(|e| TransportError::WebSocket(e.to_string()))?;
    let (outgoing, mut to_server) = mpsc::unbounded_channel::<Vec<u8>>();
    let task = tokio::spawn(async move {
        let (mut sink, mut stream) = ws.split();
        let (code, reason) = loop {
            tokio::select! {
                out = to_server.recv() => match out {
                    Some(bytes) => {
                        if let Err(e) = sink.send(Message::binary(bytes)).await {
                            break (1006, e.to_string());
                        }
                    }
                    None => {
                        let close = CloseFrame { code: CloseCode::Normal, reason: "".into() };
                        let _ = tokio::time::timeout(CLOSE_WAIT, sink.send(Message::Close(Some(close)))).await;
                        break (1000, "closed by the app".into());
                    }
                },
                msg = stream.next() => match msg {
                    Some(Ok(Message::Binary(bytes))) => on_event(DisplayEvent::Data(bytes.to_vec())),
                    Some(Ok(Message::Close(frame))) => break frame.map_or((1005, String::new()), |f| (u16::from(f.code), f.reason.to_string())),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break (1006, e.to_string()),
                    None => break (1006, "the connection closed".into()),
                },
            }
        };
        let reason = if dashboard.hides_reason(&reason) { String::new() } else { reason };
        on_event(DisplayEvent::Closed { code, reason });
    });
    Ok(DisplaySocket { outgoing, task })
}

/// The screen sockets open now, by id.
#[derive(Default)]
pub struct Displays {
    next: AtomicU64,
    /// Counts the times every socket was closed, so one opened across a reconnect is closed too.
    epoch: AtomicU64,
    open: Mutex<HashMap<u64, DisplaySocket>>,
}

impl Displays {
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// Keeps `socket` under a new id, unless every socket was closed since `epoch`: then it is dropped (and so
    /// closed) and the answer is None.
    pub fn keep(&self, epoch: u64, socket: DisplaySocket) -> Option<u64> {
        let mut open = self.open.lock().unwrap();
        if self.epoch() != epoch {
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        open.insert(id, socket);
        Some(id)
    }

    pub fn send(&self, id: u64, bytes: Vec<u8>) -> Result<(), TransportError> {
        self.open.lock().unwrap().get(&id).ok_or(TransportError::Closed)?.send(bytes)
    }

    /// Closes socket `id`; one already gone is left alone.
    pub fn close(&self, id: u64) {
        self.open.lock().unwrap().remove(&id);
    }

    /// Closes every socket: the connection they were opened on is going. Await `closed` on the answer before letting
    /// the connection go, so the closes still reach Hermes.
    #[must_use = "the connection must outlast the closes: await display::closed on these"]
    pub fn close_all(&self) -> Vec<JoinHandle<()>> {
        let mut open = self.open.lock().unwrap();
        self.epoch.fetch_add(1, Ordering::SeqCst);
        open.drain().map(|(_, socket)| socket.close()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_ticket_that_isnt_one() {
        for bad in ["", "a b", "tab\there", "line\nbreak", &"x".repeat(MAX_TICKET + 1)] {
            assert!(checked_ticket(bad).is_err(), "{bad:?}");
        }
        assert!(checked_ticket("Abc-123_x.y~z").is_ok());
    }

    #[tokio::test]
    async fn a_socket_kept_after_close_all_is_closed_instead() {
        let displays = Displays::default();
        let socket = |tx| DisplaySocket { outgoing: tx, task: tokio::spawn(async {}) };
        let (tx, mut rx) = mpsc::unbounded_channel();
        let epoch = displays.epoch();
        assert!(displays.close_all().is_empty());
        assert_eq!(displays.keep(epoch, socket(tx)), None);
        // Dropped, so its task would see the end and close.
        assert!(rx.try_recv().is_err() && rx.is_closed());

        let (tx, _rx) = mpsc::unbounded_channel();
        let id = displays.keep(displays.epoch(), socket(tx)).unwrap();
        displays.send(id, vec![1, 2]).unwrap();
        let closing = displays.close_all();
        assert_eq!(closing.len(), 1);
        closed(closing).await;
        assert!(matches!(displays.send(id, vec![3]), Err(TransportError::Closed)));
    }
}
