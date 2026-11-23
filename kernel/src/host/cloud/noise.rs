use anyhow::{bail, Context, Result};
use snow::{Builder, HandshakeState, TransportState};

const PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
const PROLOGUE: &[u8] = b"Hato Cloud relay v1";

pub(super) struct Keys {
    private: [u8; 32],
    peer: [u8; 32],
}

impl Keys {
    pub fn new(private: &str, peer: &str) -> Result<Self> {
        fn parse(value: &str) -> Result<[u8; 32]> {
            let mut bytes = [0; 32];
            hex::decode_to_slice(value, &mut bytes).context("expected a 32-byte hex Noise key")?;
            if bytes == [0; 32] {
                bail!("missing Noise key");
            }
            Ok(bytes)
        }
        Ok(Self {
            private: parse(private)?,
            peer: parse(peer)?,
        })
    }

    pub fn handshake(&self, initiator: bool) -> Result<HandshakeState> {
        let builder = Builder::new(PATTERN.parse()?)
            .local_private_key(&self.private)?
            .prologue(PROLOGUE)?;
        if initiator {
            Ok(builder.remote_public_key(&self.peer)?.build_initiator()?)
        } else {
            Ok(builder.build_responder()?)
        }
    }

    pub fn peer(&self) -> &[u8] {
        &self.peer
    }

    pub fn finish(&self, state: HandshakeState) -> Result<TransportState> {
        if state.get_remote_static() != Some(self.peer.as_slice()) {
            bail!("Noise peer key does not match the configured pin");
        }
        Ok(state.into_transport_mode()?)
    }
}

pub(super) fn generate() -> Result<snow::Keypair> {
    Ok(Builder::new(PATTERN.parse()?).generate_keypair()?)
}
