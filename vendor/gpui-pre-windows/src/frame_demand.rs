//! Coalesced frame demand shared by the UI and vsync threads.
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) struct FrameDemand(AtomicBool);

impl Default for FrameDemand {
    fn default() -> Self { Self(AtomicBool::new(true)) }
}

impl FrameDemand {
    pub(crate) fn request(&self) { self.0.store(true, Ordering::Release); }
    pub(crate) fn take(&self) -> bool { self.0.swap(false, Ordering::AcqRel) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_frame_is_requested_but_idle_ticks_are_not() {
        let demand = FrameDemand::default();
        assert!(demand.take());
        assert!(!demand.take());
        assert!(!demand.take());
    }

    #[test]
    fn multiple_updates_coalesce_without_losing_the_next_frame() {
        let demand = FrameDemand::default();
        demand.take();
        demand.request();
        demand.request();
        assert!(demand.take());
        assert!(!demand.take());
        demand.request();
        assert!(demand.take());
    }

    #[test]
    fn request_during_a_frame_survives_until_the_next_tick() {
        let demand = std::sync::Arc::new(FrameDemand::default());
        assert!(demand.take());
        let producer = demand.clone();
        std::thread::spawn(move || producer.request()).join().unwrap();
        assert!(demand.take());
        assert!(!demand.take());
    }
}
