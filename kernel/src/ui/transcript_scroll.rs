use gpui_kit::ScrollHandle;
use std::{cell::{Cell, RefCell}, collections::HashMap, rc::Rc};

#[derive(Clone, Copy)]
pub struct Geometry { pub max: f32, pub offset: f32 }

#[derive(Clone, Copy)]
/// `applied` is the offset the anchor last set; any difference by the next frame is the user's own
/// scrolling (wheel/trackpad momentum), which the anchor carries along instead of undoing.
pub struct PrependAnchor { pub base: Geometry, pub last_max: f32, pub stable_frames: u8, pub anchor_y: Option<f32>, pub applied: Option<f32> }

pub struct TranscriptScroll {
    pub handle: ScrollHandle,
    pub following: Rc<Cell<bool>>,
    pub geometry: Rc<Cell<Option<Geometry>>>,
    pub last_user: Option<String>,
    pub first_message: Option<String>,
    pub last_message: Option<String>,
    pub scroll_reset: Option<u64>,
    pub viewport_y: Rc<Cell<f32>>,
    pub positions: Rc<RefCell<HashMap<String, f32>>>,
    pub anchor_key: Rc<RefCell<Option<String>>>,
    pub bottom_requested: Rc<Cell<bool>>,
    pub user_scrolled_up: Rc<Cell<bool>>,
    pub prepend: Rc<Cell<Option<PrependAnchor>>>,
    pub history_requested: Rc<Cell<bool>>,
    /// Viewport height from the last paint; older history is prefetched within this distance of the top.
    pub viewport_h: Rc<Cell<f32>>,
}
impl Default for TranscriptScroll {
    fn default() -> Self {
        Self { handle: ScrollHandle::new(), following: Rc::new(Cell::new(true)), geometry: Rc::new(Cell::new(None)), last_user: None, first_message: None, last_message: None, scroll_reset: None, viewport_y: Default::default(), positions: Default::default(), anchor_key: Default::default(), bottom_requested: Default::default(), user_scrolled_up: Default::default(), prepend: Rc::new(Cell::new(None)), history_requested: Rc::new(Cell::new(false)), viewport_h: Rc::new(Cell::new(0.0)) }
    }
}

/// How close to the top (px, as a negative offset bound) older history starts loading: about one
/// viewport ahead, so trackpad momentum runs into loaded content instead of the edge.
pub fn prefetch_offset(viewport_h: f32) -> f32 { -viewport_h.clamp(48.0, 1200.0) }

/// Shift an in-progress anchor by the user's scrolling since the anchor last set the offset.
pub fn carry_user_scroll(mut anchor: PrependAnchor, current_offset: f32) -> PrependAnchor {
    if let Some(applied) = anchor.applied {
        let moved = current_offset - applied;
        if moved.abs() > 0.5 {
            anchor.anchor_y = anchor.anchor_y.map(|y| y + moved);
            anchor.base.offset += moved;
            anchor.stable_frames = 0;
        }
    }
    anchor
}

/// Preserve the distance to existing content when older rows are inserted above it.
pub fn prepended_offset(base: Geometry, new_max: f32) -> f32 {
    (base.offset - (new_max - base.max)).clamp(-new_max.max(0.0), 0.0)
}

/// Anchor retained content even when rows are inserted at one edge and removed at the other.
pub fn anchored_offset(current: Geometry, old_y: f32, new_y: f32) -> f32 {
    (current.offset + old_y - new_y).clamp(-current.max.max(0.0), 0.0)
}

/// Follow layout growth and resizes, but preserve an intentional scroll into history.
pub fn following_bottom(following: bool, previous: Option<Geometry>, current: Geometry) -> bool {
    let moved_up = previous.is_some_and(|old| current.offset > old.offset + 1.0 && current.max >= old.max - 1.0);
    if moved_up { return false; }
    following || current.max + current.offset <= 2.0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepending_messages_preserves_the_visible_content() {
        let base = Geometry { max: 1000.0, offset: -20.0 };
        assert_eq!(prepended_offset(base, 1500.0), -520.0);
        assert_eq!(prepended_offset(base, 1700.0), -720.0);
        assert_eq!(prepended_offset(base, 900.0), 0.0);
    }
    #[test]
    fn retained_content_stays_anchored_when_the_window_slides_in_either_direction() {
        assert_eq!(anchored_offset(Geometry { max: 1000.0, offset: -20.0 }, 100.0, 600.0), -520.0);
        assert_eq!(anchored_offset(Geometry { max: 1000.0, offset: -900.0 }, -100.0, -500.0), -500.0);
        assert_eq!(anchored_offset(Geometry { max: 100.0, offset: -50.0 }, 0.0, 900.0), -100.0);
    }
    #[test]
    fn anchoring_keeps_the_users_own_scrolling() {
        let anchor = PrependAnchor { base: Geometry { max: 1000.0, offset: -20.0 }, last_max: 1000.0, stable_frames: 1, anchor_y: Some(100.0), applied: Some(-520.0) };
        let moved = carry_user_scroll(anchor, -480.0);
        assert_eq!(moved.anchor_y, Some(140.0));
        assert_eq!(moved.base.offset, 20.0);
        assert_eq!(moved.stable_frames, 0);
        let still = carry_user_scroll(anchor, -520.0);
        assert_eq!(still.anchor_y, Some(100.0));
        assert_eq!(prefetch_offset(10.0), -48.0);
        assert_eq!(prefetch_offset(700.0), -700.0);
    }
    #[test]
    fn follows_content_growth_and_viewport_changes() {
        let old = Some(Geometry { max: 100.0, offset: -100.0 });
        assert!(following_bottom(true, old, Geometry { max: 180.0, offset: -100.0 }));
        assert!(following_bottom(true, old, Geometry { max: 60.0, offset: -60.0 }));
        assert!(following_bottom(true, old, Geometry { max: 200.0, offset: -200.0 }));
    }
    #[test]
    fn reading_history_stays_put_until_the_user_returns_to_bottom() {
        let old = Some(Geometry { max: 100.0, offset: -100.0 });
        assert!(!following_bottom(true, old, Geometry { max: 100.0, offset: -50.0 }));
        assert!(!following_bottom(false, Some(Geometry { max: 100.0, offset: -50.0 }), Geometry { max: 180.0, offset: -50.0 }));
        assert!(following_bottom(false, None, Geometry { max: 180.0, offset: -180.0 }));
    }
}
