use gpui_kit::ScrollHandle;
use std::{cell::Cell, rc::Rc};

#[derive(Clone, Copy)]
pub struct Geometry { pub max: f32, pub offset: f32 }

#[derive(Clone, Copy)]
pub struct PrependAnchor { pub base: Geometry, pub last_max: f32, pub stable_frames: u8 }

pub struct TranscriptScroll {
    pub handle: ScrollHandle,
    pub following: Rc<Cell<bool>>,
    pub geometry: Rc<Cell<Option<Geometry>>>,
    pub last_user: Option<String>,
    pub first_message: Option<String>,
    pub prepend: Rc<Cell<Option<PrependAnchor>>>,
    pub history_requested: Rc<Cell<bool>>,
}
impl Default for TranscriptScroll {
    fn default() -> Self {
        Self { handle: ScrollHandle::new(), following: Rc::new(Cell::new(true)), geometry: Rc::new(Cell::new(None)), last_user: None, first_message: None, prepend: Rc::new(Cell::new(None)), history_requested: Rc::new(Cell::new(false)) }
    }
}

/// Preserve the distance to existing content when older rows are inserted above it.
pub fn prepended_offset(base: Geometry, new_max: f32) -> f32 {
    (base.offset - (new_max - base.max)).clamp(-new_max.max(0.0), 0.0)
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
