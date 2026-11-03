//! Bounded PTY output journal with absolute byte cursors. No shell or command policy.
use std::collections::VecDeque;
use serde_json::{json, Value};
#[derive(Default)]
pub struct OutputJournal { bytes: VecDeque<u8>, end: u64 }
const CAPACITY: usize = 512 * 1024;
impl OutputJournal {
    pub fn push(&mut self, bytes: &[u8]) {
        self.end += bytes.len() as u64;
        self.bytes.extend(bytes);
        let excess = self.bytes.len().saturating_sub(CAPACITY);
        self.bytes.drain(..excess);
    }
    pub fn read(&self, cursor: Option<u64>, limit: usize) -> Value {
        let start = self.end - self.bytes.len() as u64;
        let requested = cursor.unwrap_or(self.end.saturating_sub(limit as u64));
        let from = requested.clamp(start, self.end);
        let bytes: Vec<u8> = self.bytes.iter().skip((from - start) as usize).take(limit).copied().collect();
        // Keep an incomplete trailing UTF-8 character for the next read.
        let used = match std::str::from_utf8(&bytes) {
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            _ => bytes.len(),
        };
        json!({ "text": String::from_utf8_lossy(&bytes[..used]), "cursor": from + used as u64,
            "endCursor": self.end, "truncated": requested < start })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_reads_and_tail_do_not_replay_previous_output() {
        let mut output = OutputJournal::default(); output.push(b"one\n");
        assert_eq!(output.read(None, 0)["cursor"], 4);
        output.push(b"two\n");
        assert_eq!(output.read(Some(4), 100)["text"], "two\n");
        assert_eq!(output.read(None, 4)["text"], "two\n");
        assert_eq!(output.read(Some(8), 100)["text"], "");
    }
    #[test]
    fn bounds_history_and_reports_lost_output() {
        let mut output = OutputJournal::default(); output.push(&vec![b'x'; CAPACITY + 100]);
        let read = output.read(Some(0), 10);
        assert_eq!(read["truncated"], true); assert_eq!(read["cursor"], 110);
        assert_eq!(output.bytes.len(), CAPACITY);
    }
    #[test]
    fn preserves_split_utf8_characters_across_reads() {
        let mut output = OutputJournal::default(); output.push(&[b'a', 0xe2, 0x82]);
        assert_eq!(output.read(Some(0), 100)["text"], "a");
        assert_eq!(output.read(Some(0), 100)["cursor"], 1);
        output.push(&[0xac]); assert_eq!(output.read(Some(1), 100)["text"], "€");
    }
}
