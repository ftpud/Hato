//! Honors the operating system's reduced-motion preference.
//!
//! Every Base transition, spring, presence and reveal consults
//! [`App::reduce_motion`], but GPUI never reads the platform's setting into
//! that flag: it stays `false` until something sets it. [`init`] reads the
//! setting when Base initializes and writes it into the flag, so an
//! application inherits the user's choice by calling `gpui_base::init` or
//! `gpui_component::init`.
//!
//! The setting is read on the platforms below; everywhere else the flag is
//! left alone.
//!
//! - macOS: `NSWorkspace.accessibilityDisplayShouldReduceMotion`, the
//!   "Reduce motion" switch under Accessibility → Display.
//! - Windows: `SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION)`, the
//!   "Animation effects" switch under Accessibility → Visual effects, whose
//!   off state asks for reduced motion.
//! - Linux: the `reduced-motion` key of the `org.freedesktop.appearance`
//!   namespace of the XDG desktop portal's Settings interface, which GNOME
//!   and KDE back with their own animation switches. The portal answers over
//!   D-Bus, so the reading lands a moment after `init` returns, and Base keeps
//!   following the portal's change signal for the life of the application.
//!
//! An application can explicitly select its motion mode. The last system
//! reading is retained while an override is active.

//! Under GPUI's test scheduler the platform is never consulted, whichever
//! crate's tests are running: a probe that answers from another thread would
//! break the scheduler's determinism, and a test wanting reduced motion sets
//! the flag itself.

use gpui::{App, Global};

/// What Base last wrote into [`App::set_reduce_motion`], and whether it is
/// already listening for the platform to change its mind.
#[derive(Default)]
struct SystemReduceMotion {
    applied: Option<bool>,
    following: bool,
    raw: Option<bool>,
    requested: Option<MotionMode>,
}

impl Global for SystemReduceMotion {}

/// Applies the system's reduced-motion preference during `gpui_base::init`.
pub(crate) fn init(cx: &mut App) {
    apply_system_reduce_motion(cx);
}

/// Refresh the system preference and ensure the platform listener is installed.
pub fn apply_system_reduce_motion(cx: &mut App) {
    if is_test_scheduler(cx) {
        return;
    }
    apply_preference(platform::read(), cx);
    let state = cx.default_global::<SystemReduceMotion>();
    if !state.following {
        state.following = true;
        platform::follow(cx);
    }
}

/// The app preference. Off and Reduced both stop legacy decorative animations.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MotionMode {
    System,
    On,
    Reduced,
    Off,
}

pub fn set_motion_mode(mode: MotionMode, cx: &mut App) {
    if cx.default_global::<SystemReduceMotion>().requested == Some(mode) {
        return;
    }
    cx.default_global::<SystemReduceMotion>().requested = Some(mode);
    apply_preference(None, cx);
    cx.refresh_windows();
}

pub fn surface_motion(cx: &App) -> crate::motion::SurfaceMotion {
    use crate::motion::SurfaceMotion;
    match cx
        .try_global::<SystemReduceMotion>()
        .and_then(|state| state.requested)
    {
        Some(MotionMode::Off) => SurfaceMotion::Off,
        _ if cx.reduce_motion() => SurfaceMotion::Reduced,
        _ => SurfaceMotion::Full,
    }
}

/// Whether the application runs on GPUI's deterministic test scheduler,
/// which must not be woken by a platform answering from its own thread.
fn is_test_scheduler(cx: &App) -> bool {
    cx.background_executor()
        .scheduler_executor()
        .scheduler()
        .as_test()
        .is_some()
}

/// Writes one reading of the system preference into the flag, unless the
/// application has taken the flag over since the reading Base last applied.
fn apply_preference(preference: Option<bool>, cx: &mut App) {
    let state = cx.default_global::<SystemReduceMotion>();
    if let Some(preference) = preference {
        state.raw = Some(preference);
    }
    let (raw, requested, applied) = (state.raw, state.requested, state.applied);
    let reduce = match requested {
        Some(MotionMode::On) => false,
        Some(MotionMode::Off | MotionMode::Reduced) => true,
        Some(MotionMode::System) => raw.unwrap_or(false),
        None if preference.is_some() && cx.reduce_motion() == applied.unwrap_or(false) => {
            preference.unwrap_or(false)
        }
        None => return,
    };
    cx.set_reduce_motion(reduce);
    cx.default_global::<SystemReduceMotion>().applied = Some(reduce);
}

#[cfg(target_os = "macos")]
mod platform {
    use futures::StreamExt as _;
    use gpui::App;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification};
    use objc2_foundation::NSNotification;

    pub(super) fn read() -> Option<bool> {
        Some(NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion())
    }

    pub(super) fn follow(cx: &mut App) {
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let (send, mut signals) = futures::channel::mpsc::unbounded();
        let callback = block2::RcBlock::new(move |_: std::ptr::NonNull<NSNotification>| {
            let _ = send.unbounded_send(());
        });
        // The notification center retains the block and may invoke it off the UI thread.
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification),
                None,
                None,
                &callback,
            )
        };
        cx.spawn(async move |cx| {
            while signals.next().await.is_some() {
                cx.update(|cx| super::apply_preference(read(), cx));
            }
            unsafe { center.removeObserver((&*observer).as_ref()) };
        })
        .detach();
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use futures::StreamExt as _;
    use gpui::App;
    use windows::Win32::{
        Foundation::BOOL,
        UI::WindowsAndMessaging::{
            SPI_GETCLIENTAREAANIMATION, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SystemParametersInfoW,
        },
    };
    use windows::{Foundation::TypedEventHandler, UI::ViewManagement::UISettings};

    pub(super) fn read() -> Option<bool> {
        let mut animations_enabled = BOOL(0);
        // SAFETY: SPI_GETCLIENTAREAANIMATION writes one BOOL through `pvParam`
        // and ignores `uiParam`; the BOOL outlives the call.
        unsafe {
            SystemParametersInfoW(
                SPI_GETCLIENTAREAANIMATION,
                0,
                Some((&mut animations_enabled as *mut BOOL).cast()),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        }
        .ok()?;
        Some(!animations_enabled.as_bool())
    }

    pub(super) fn follow(cx: &mut App) {
        let Ok(settings) = UISettings::new() else {
            return;
        };
        let (send, mut signals) = futures::channel::mpsc::unbounded();
        let Ok(token) = settings.AnimationsEnabledChanged(&TypedEventHandler::new(move |_, _| {
            let _ = send.unbounded_send(());
            Ok(())
        })) else {
            return;
        };
        cx.spawn(async move |cx| {
            while signals.next().await.is_some() {
                cx.update(|cx| super::apply_preference(read(), cx));
            }
            let _ = settings.RemoveAnimationsEnabledChanged(token);
        })
        .detach();
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use ashpd::desktop::settings::{ReducedMotion, Settings};
    use futures::StreamExt as _;
    use gpui::App;

    /// The portal answers asynchronously; [`follow`] applies the first reading.
    pub(super) fn read() -> Option<bool> {
        None
    }

    pub(super) fn follow(cx: &mut App) {
        cx.spawn(async move |cx| {
            let settings = Settings::new().await.ok()?;
            let current = settings.reduced_motion().await.ok()?;
            cx.update(|cx| super::apply_preference(Some(reduces(current)), cx));
            let mut changes = settings.receive_reduced_motion_changed().await.ok()?;
            while let Some(preference) = changes.next().await {
                cx.update(|cx| super::apply_preference(Some(reduces(preference)), cx));
            }
            Some(())
        })
        .detach();
    }

    fn reduces(preference: ReducedMotion) -> bool {
        matches!(preference, ReducedMotion::ReducedMotion)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use gpui::App;

    pub(super) fn read() -> Option<bool> {
        None
    }

    pub(super) fn follow(_cx: &mut App) {}
}

#[cfg(test)]
mod tests {
    use gpui::TestAppContext;

    use super::{apply_preference, apply_system_reduce_motion};

    #[gpui::test]
    fn a_system_preference_for_reduced_motion_sets_the_flag(cx: &mut TestAppContext) {
        cx.update(|cx| {
            apply_preference(Some(true), cx);
            assert!(cx.reduce_motion());
        });
    }

    #[gpui::test]
    fn an_unknown_system_preference_leaves_the_flag_alone(cx: &mut TestAppContext) {
        cx.update(|cx| {
            apply_preference(None, cx);
            assert!(!cx.reduce_motion());

            cx.set_reduce_motion(true);
            apply_preference(None, cx);
            assert!(cx.reduce_motion());
        });
    }

    #[gpui::test]
    fn the_system_drives_the_flag_until_the_application_sets_it(cx: &mut TestAppContext) {
        cx.update(|cx| {
            apply_preference(Some(true), cx);
            apply_preference(Some(false), cx);
            assert!(!cx.reduce_motion());
            apply_preference(Some(true), cx);
            assert!(cx.reduce_motion());

            cx.set_reduce_motion(false);
            apply_preference(Some(true), cx);
            assert!(!cx.reduce_motion());
        });
    }

    #[gpui::test]
    fn the_test_scheduler_is_never_asked_for_the_platform_preference(cx: &mut TestAppContext) {
        cx.update(|cx| {
            apply_system_reduce_motion(cx);
            assert!(!cx.reduce_motion());
        });
        cx.run_until_parked();
        cx.update(|cx| assert!(!cx.reduce_motion()));
    }

    #[gpui::test]
    fn a_flag_the_application_set_before_the_first_reading_is_kept(cx: &mut TestAppContext) {
        cx.update(|cx| {
            cx.set_reduce_motion(true);
            apply_preference(Some(false), cx);
            assert!(cx.reduce_motion());
        });
    }
}
