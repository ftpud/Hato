// Glass surfaces for the Ember shell (concept: a floating graphite card with a lit top edge, glass
// chips and an ember glow). Pure style data over palette tokens; themes without these tokens fall
// back to the plain `background` the caller also sets.
import type { UiColor, UiStyle } from "./types";

/** Floating card: a top sheen that settles into the base tint, a lit edge and a soft shadow. */
export const glassCard: UiStyle = {
  gradient: { angle: 180, from: "cardTop", to: "cardBottom", toAt: 0.34 },
  shadows: [{ y: 1, color: "highlight", inset: true }, { y: 18, blur: 40, color: "depth" }],
};
/** Quality of large-surface effects. GPUI rasterizes the whole window for every animation frame,
 *  so a gradient and blurred shadow on big docked panels cost GPU time on every spinner tick. */
export type SurfaceEffects = "full" | "reduced" | "flat";
export const surfaceEffectsOf = (value: unknown): SurfaceEffects =>
  value === "full" || value === "flat" ? value : "reduced";
/** Large docked/rail card. `full` is the floating-card look; `reduced` keeps the sheen and lit
 *  edge but drops the 40 px drop shadow (measured ~1.1 ms/frame on two panels); `flat` also drops
 *  the gradient (~1.5 ms more) and keeps only the lit edge. Floating surfaces keep `glassCard`. */
export const dockedCard = (effects: SurfaceEffects): UiStyle =>
  effects === "full" ? glassCard
    : effects === "reduced" ? { gradient: glassCard.gradient, shadows: [{ y: 1, color: "highlight", inset: true }] }
    : { shadows: [{ y: 1, color: "highlight", inset: true }] };
/** Raised glass chip: active rows, fields, the account box. */
export const glassChip: UiStyle = {
  gradient: { angle: 180, from: "glassTop", to: "glassBottom" },
  borderWidth: 1, borderColor: "glassEdge",
  shadows: [{ y: 1, color: "highlight", inset: true }, { y: 1, blur: 3, color: "chipDepth" }],
};
/** Recessed well: darker than the card, hairline edge (the account box). */
export const glassWell: UiStyle = { background: "well", borderWidth: 1, borderColor: "wellEdge" };
/** Glossy light tile (the pigeon logo). */
export const glossyTile: UiStyle = {
  gradient: { angle: 180, from: "tileTop", to: "tileBottom" },
  shadows: [{ y: 1, color: "#ffffff80", inset: true }, { y: 2, blur: 6, color: "depth" }],
};
/** Colored bloom around small accents (indicator bar, primary button). */
export const glow = (color: UiColor = "glow", blur = 6, spread = 0): UiStyle => ({ shadows: [{ blur, spread, color }] });
/** Hairline that fades out towards one end (use two, mirrored, for a centred rule). */
export const fadeLine = (towards: "left" | "right"): UiStyle => ({ gradient: { angle: towards === "left" ? 270 : 90, from: "#00000000", to: "rule" } });
