//! Kernel -> UI thread message bridge. The GPUI side drains it asynchronously; the kernel never
//! blocks on the UI thread.
use futures::channel::mpsc;
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug)]
pub enum UiMsg {
    /// A UI module produced a new keyed tree.
    Tree { module: String, generation: u64, tree: Arc<Value> },
    /// A UI module failed to render.
    RenderError { module: String, error: String },
    /// Module generation table changed (status bar / diagnostics).
    ModulesChanged,
    ApprovalsChanged,
    /// Terminal content changed for a PTY handle.
    TerminalDirty(String),
    /// A native folder picker was requested; reply via the channel.
    PickFolder(crossbeam_channel::Sender<Option<String>>),
    Toast { level: String, text: String },
    /// Open an http(s) URL in the system browser.
    OpenUrl(String),
    Quit,
}

#[derive(Clone)]
pub struct UiBridge {
    tx: Option<mpsc::UnboundedSender<UiMsg>>,
}

impl UiBridge {
    pub fn new() -> (UiBridge, mpsc::UnboundedReceiver<UiMsg>) {
        let (tx, rx) = mpsc::unbounded();
        (UiBridge { tx: Some(tx) }, rx)
    }
    pub fn disconnected() -> UiBridge { UiBridge { tx: None } }
    pub fn send(&self, m: UiMsg) {
        if let Some(tx) = &self.tx {
            let _ = tx.unbounded_send(m);
        }
    }
    pub fn connected(&self) -> bool { self.tx.is_some() }
}
