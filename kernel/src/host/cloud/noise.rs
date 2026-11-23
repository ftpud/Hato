use anyhow::{bail, Context, Result};
use snow::{Builder, HandshakeState};

const PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
const PROLOGUE: &[u8] = b"Hato Cloud relay v1";

pub(super) struct Keys {
    private: [u8; 32],
    peer: Option<[u8; 32]>,
}

impl Keys {
    pub fn new(private: &str, peer: Option<&str>) -> Result<Self> {
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
            peer: peer.map(parse).transpose()?,
        })
    }

    pub fn handshake(&self, initiator: bool) -> Result<HandshakeState> {
        let builder = Builder::new(PATTERN.parse()?)
            .local_private_key(&self.private)?
            .prologue(PROLOGUE)?;
        if initiator {
            let peer = self
                .peer
                .as_ref()
                .context("desktop connections require a pinned host key")?;
            Ok(builder.remote_public_key(peer)?.build_initiator()?)
        } else {
            Ok(builder.build_responder()?)
        }
    }

    pub fn peer(&self) -> Option<&[u8]> {
        self.peer.as_ref().map(|key| key.as_slice())
    }
}

pub(super) fn generate() -> Result<snow::Keypair> {
    Ok(Builder::new(PATTERN.parse()?).generate_keypair()?)
}
