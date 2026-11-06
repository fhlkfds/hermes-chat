//! The steps of opening a connection, in the order they run (#270, ADR 0033). The webview records which step each
//! attempt reached and how long each took (src/hermes/attempts.ts `STEPS`, which a test holds to this list). A step
//! that should have its own time limit (#269) gets it in `Steps::run`, the one place a connect step runs.
use std::future::Future;

use serde::{Deserialize, Serialize};

/// One step. `Resolve` is a URL route's DNS lookup and `Tunnel` an SSH route's tunnel; a route runs one or the other.
/// `Ready` is the wait for `gateway.ready`, which runs in the webview; Rust never reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    Keyring,
    Resolve,
    Tunnel,
    Status,
    SignIn,
    Ticket,
    #[serde(rename = "websocket")]
    WebSocket,
    Ready,
}

/// Where a connection being opened says which step it starts. Setup's test and route checks report nowhere.
#[derive(Default)]
pub struct Steps(Option<Box<dyn Fn(Step) + Send + Sync>>);

impl Steps {
    pub fn reporting(to: impl Fn(Step) + Send + Sync + 'static) -> Self {
        Steps(Some(Box::new(to)))
    }

    /// Runs one step: says it started, then runs it.
    pub async fn run<F: Future>(&self, step: Step, fut: F) -> F::Output {
        if let Some(report) = &self.0 {
            report(step);
        }
        fut.await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn run_reports_the_step_before_it_runs() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let steps = Steps::reporting(move |s| log.lock().unwrap().push(format!("start {s:?}")));
        let inner = seen.clone();
        let got = steps.run(Step::Status, async move { inner.lock().unwrap().push("ran".into()); 7 }).await;
        assert_eq!(got, 7);
        assert_eq!(*seen.lock().unwrap(), ["start Status", "ran"]);
        assert_eq!(Steps::default().run(Step::Ticket, async { 1 }).await, 1);
    }

    #[test]
    fn names_are_the_webviews() {
        let names: Vec<String> = [Step::Keyring, Step::Resolve, Step::Tunnel, Step::Status, Step::SignIn, Step::Ticket, Step::WebSocket, Step::Ready]
            .iter()
            .map(|s| serde_json::to_value(s).unwrap().as_str().unwrap().to_owned())
            .collect();
        assert_eq!(names, ["keyring", "resolve", "tunnel", "status", "sign-in", "ticket", "websocket", "ready"]);
    }
}
