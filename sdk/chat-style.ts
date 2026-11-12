// Chat presentation as plain style data (formerly hardcoded "surface" presets in the renderer).
// Colors are theme tokens from the layout's color scheme; change them here and hot reload.
import type { UiStyle } from "./types";

export const chatStyle = {
  // The hosting panel supplies the frame; a second border/radius here drew a card inside a card.
  root: { position: "relative", background: "surface", color: "text", fontSize: 14, font: "ui" },
  toolbar: { background: "field", borderBottom: 1, borderColor: "border", wrap: true },
  // The split divider above already draws the separating line.
  composer: { background: "surface" },
  settings: { background: "surface", color: "text" },
  picker: { background: "surface", color: "text", borderWidth: 1, borderColor: "border", radius: 12 },
  control: { height: 32, fontSize: 14, radius: 8, background: "surface", borderColor: "border", color: "text", paddingX: 12, gap: 8 },
  iconControl: { height: 32, width: 32, radius: 8, background: "surface", borderColor: "border", color: "text", padding: 0, noShrink: true },
  fieldControl: { height: 36, radius: 8, background: "surface", borderColor: "border", color: "text", fullWidth: true, justify: "between" },
  primary: { height: 32, fontSize: 14, radius: 8, background: "primary", color: "primaryText", paddingX: 12, noShrink: true },
  iconPrimary: { height: 32, width: 32, radius: 8, background: "primary", color: "primaryText", padding: 0, noShrink: true },
  result: { fullWidth: true, height: 34, color: "text", justify: "start" },
  attach: { height: 32, width: 32, padding: 0, noShrink: true, radius: 8, background: "field", borderColor: "border" },
  textarea: { background: "field" },
} satisfies Record<string, UiStyle>;

export const sidebarButtonStyle = (selected: boolean): UiStyle => ({
  padding: 0, noShrink: true, radius: 10, borderWidth: 0,
  background: selected ? "selection" : "surface", color: selected ? "primary" : "muted",
});
