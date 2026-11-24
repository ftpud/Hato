// Glass surfaces for the Ember shell (concept: a floating graphite card with a lit top edge, glass
// chips and an ember glow). Pure style data over palette tokens; themes without these tokens fall
// back to the plain `background` the caller also sets.
import type { UiColor, UiStyle } from "./types";

/** Floating card: a top sheen that settles into the base tint, a lit edge and a soft shadow. */
export const glassCard: UiStyle = {
  gradient: { angle: 180, from: "cardTop", to: "cardBottom", toAt: 0.34 },
  shadows: [{ y: 1, color: "highlight", inset: true }, { y: 18, blur: 40, color: "depth" }],
};
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
