import type { UiMotionEasing, UiMotionTiming, UiTransition } from "./types";

export const motionDuration = { fast: 120, base: 180, slow: 240 } as const;
export const motionEasing = {
  enter: [0.2, 0, 0, 1] as UiMotionEasing,
  exit: [0.4, 0, 1, 1] as UiMotionEasing,
};
export const motionExitRatio = 0.7;

export const interactionMotion: UiMotionTiming = {
  durationMs: motionDuration.fast,
  easing: motionEasing.enter,
};

export const anchoredMotion: UiTransition = {
  enter: { durationMs: motionDuration.base, easing: motionEasing.enter, opacity: 0, offsetPx: [0, -4] },
  exit: { durationMs: Math.round(motionDuration.base * motionExitRatio), easing: motionEasing.exit, opacity: 0, offsetPx: [0, -4] },
};

/** For surfaces opening upward from their anchor (bottom-anchored popovers). */
export const anchoredAboveMotion: UiTransition = {
  enter: { ...anchoredMotion.enter!, offsetPx: [0, 4] },
  exit: { ...anchoredMotion.exit!, offsetPx: [0, 4] },
};

export const tooltipMotion: UiTransition = {
  ...anchoredMotion,
  enter: { ...anchoredMotion.enter!, offsetPx: [0, 4] },
  exit: { ...anchoredMotion.exit!, offsetPx: [0, 4] },
};

export const toastMotion: UiTransition = {
  enter: { durationMs: motionDuration.base, easing: motionEasing.enter, opacity: 0, offsetPx: [0, 8] },
  exit: { durationMs: Math.round(motionDuration.base * motionExitRatio), easing: motionEasing.exit, opacity: 0 },
};

/** Docked panes: the pane's real size animates (neighbours follow like a divider drag) while its
 *  content keeps its open size and slides from the dock edge. Opacity 0 marks the closed end of
 *  the progress; Full motion does not fade the pane, Reduced fades it in without movement.
 *  Both legs decelerate: closing should feel like a quick, controlled push, not a fall. */
export const dockRevealMotion: UiTransition = {
  enter: { durationMs: 260, easing: motionEasing.enter, opacity: 0 },
  exit: { durationMs: 210, easing: [0.4, 0, 0.2, 1], opacity: 0 },
};
