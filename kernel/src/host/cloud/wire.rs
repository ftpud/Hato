use anyhow::{bail, Result};
use tokio_tungstenite::tungstenite::{Bytes, Message};

pub(super) const OPEN: u8 = 1;
pub(super) const DATA: u8 = 2;
pub(super) const CREDIT: u8 = 3;
pub(super) const CLOSE: u8 = 4;
pub(super) const WINDOW: usize = 4;
pub(super) const MAX_CHANNELS: usize = 32;
pub(super) const MAX_DATA: usize = 16 * 1024;
pub(super) const MAX_MESSAGE: usize = 64 * 1024;
pub(super) const CHUNK: usize = MAX_DATA - 17;

pub(super) struct Frame {
    pub op: u8,
    pub id: u32,
    pub payload: Bytes,
}

impl Frame {
    pub fn decode(bytes: Bytes) -> Result<Self> {
        if bytes.len() < 5 {
            bail!("truncated relay frame");
        }
        let id = u32::from_be_bytes(bytes[1..5].try_into()?);
        if id == 0 {
            bail!("invalid relay channel ID");
        }
        Ok(Self {
            op: bytes[0],
            id,
            payload: bytes.slice(5..),
        })
    }

    pub fn message(self) -> Message {
        let mut bytes = Vec::with_capacity(5 + self.payload.len());
        bytes.push(self.op);
        bytes.extend_from_slice(&self.id.to_be_bytes());
        bytes.extend_from_slice(&self.payload);
        Message::Binary(bytes.into())
    }

    pub fn control(op: u8, id: u32, value: u8) -> Self {
        Self {
            op,
            id,
            payload: vec![value].into(),
        }
    }
}
