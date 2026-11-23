use super::wire::{Frame, CHUNK, DATA, WINDOW};
use super::Config;
use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use snow::TransportState;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};
use tokio::sync::{mpsc, Semaphore};
use tokio_tungstenite::tungstenite::Bytes;

pub struct Channel {
    pub(super) pipe: DuplexStream,
    pub(super) failure: Arc<Mutex<Option<&'static str>>>,
    pub(super) _lifetime: tokio::sync::oneshot::Sender<()>,
}

impl AsyncRead for Channel {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let capacity = buf.remaining();
        match Pin::new(&mut self.pipe).poll_read(cx, buf) {
            Poll::Ready(Ok(())) if before == buf.filled().len() && capacity > 0 => {
                match *self.failure.lock() {
                    Some(error) => {
                        Poll::Ready(Err(io::Error::new(io::ErrorKind::ConnectionAborted, error)))
                    }
                    None => Poll::Ready(Ok(())),
                }
            }
            result => result,
        }
    }
}

impl AsyncWrite for Channel {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.pipe).poll_write(cx, data)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.pipe).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.pipe).poll_shutdown(cx)
    }
}

pub(super) struct Tunnel {
    pub id: u32,
    pub inbox: mpsc::Receiver<Bytes>,
    pub credit: Arc<Semaphore>,
    pub commands: mpsc::Sender<super::Command>,
}

impl Tunnel {
    async fn send(&self, op: u8, payload: Bytes) -> Result<()> {
        self.commands
            .send(super::Command::Frame(Frame {
                op,
                id: self.id,
                payload,
            }))
            .await?;
        Ok(())
    }

    async fn data(&self, payload: Bytes) -> Result<()> {
        self.credit.acquire().await?.forget();
        self.send(DATA, payload).await
    }

    async fn read_handshake(&mut self, state: &mut snow::HandshakeState) -> Result<()> {
        let bytes = self
            .inbox
            .recv()
            .await
            .ok_or_else(|| anyhow!("Cloud handshake channel closed"))?;
        if state.read_message(&bytes, &mut [])? != 0 {
            bail!("unexpected Noise handshake payload");
        }
        self.send(super::wire::CREDIT, Bytes::from_static(&[1]))
            .await
    }

    async fn write_handshake(&self, state: &mut snow::HandshakeState) -> Result<()> {
        let mut bytes = vec![0; 128];
        let len = state.write_message(&[], &mut bytes)?;
        bytes.truncate(len);
        self.data(bytes.into()).await
    }

    pub async fn authenticate(
        &mut self,
        config: &Arc<Config>,
        initiator: bool,
    ) -> Result<TransportState> {
        let mut state = config.keys.handshake(initiator)?;
        if initiator {
            self.write_handshake(&mut state).await?;
            self.read_handshake(&mut state).await?;
            if state.get_remote_static() != config.keys.peer() {
                bail!("Noise host key does not match the configured pin");
            }
        } else {
            self.read_handshake(&mut state).await?;
            let peer = state
                .get_remote_static()
                .ok_or_else(|| anyhow!("Noise desktop key missing"))?;
            if !config.authorize_desktop(peer).await? {
                bail!("Noise desktop key is not authorized");
            }
            self.write_handshake(&mut state).await?;
        }
        Ok(state.into_transport_mode()?)
    }

    pub async fn bridge<T: AsyncRead + AsyncWrite + Unpin>(
        &mut self,
        stream: &mut T,
        state: TransportState,
    ) -> Result<()> {
        let (mut input, mut output) = tokio::io::split(stream);
        let state = Mutex::new(state);
        let tx = self.commands.clone();
        let id = self.id;
        let send = async {
            let mut plain = vec![0; CHUNK + 1];
            let mut cipher = vec![0; super::wire::MAX_DATA];
            loop {
                let permit = self.credit.acquire().await?;
                let n = input.read(&mut plain[1..]).await?;
                plain[0] = u8::from(n > 0);
                let len = state.lock().write_message(&plain[..=n], &mut cipher)?;
                permit.forget();
                tx.send(super::Command::Frame(Frame {
                    op: DATA,
                    id,
                    payload: Bytes::copy_from_slice(&cipher[..len]),
                }))
                .await?;
                if n == 0 {
                    return Ok::<_, anyhow::Error>(());
                }
            }
        };
        let receive = async {
            let mut plain = vec![0; super::wire::MAX_DATA];
            while let Some(bytes) = self.inbox.recv().await {
                let len = state.lock().read_message(&bytes, &mut plain)?;
                match &plain[..len] {
                    [0] => {
                        output.shutdown().await?;
                        tx.send(super::Command::Frame(Frame::control(
                            super::wire::CREDIT,
                            id,
                            1,
                        )))
                        .await?;
                        return Ok::<_, anyhow::Error>(());
                    }
                    [1, data @ ..] if !data.is_empty() => output.write_all(data).await?,
                    _ => bail!("invalid encrypted Cloud record"),
                }
                tx.send(super::Command::Frame(Frame::control(
                    super::wire::CREDIT,
                    id,
                    1,
                )))
                .await?;
            }
            bail!("Cloud channel closed before authenticated EOF")
        };
        tokio::try_join!(send, receive)?;
        Ok(())
    }
}

pub(super) fn inbox() -> (mpsc::Sender<Bytes>, mpsc::Receiver<Bytes>) {
    mpsc::channel(WINDOW)
}
