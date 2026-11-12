// Settings-field presentation over the native `slider` and `colorPicker` nodes. Modules choose
// bounds, units, swatches and labels; the renderer owns dragging and the picker popover.
import type { Json, SettingField, UiNode } from "./types";

type Range = Extract<SettingField, { type: "range" }>;
type Color = Extract<SettingField, { type: "color" }>;

/** A balanced palette that reads on light and dark themes. */
export const defaultSwatches = ["#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#d946ef", "#ec4899", "#64748b"];
const HEX = /^#[0-9a-fA-F]{6}$/;

export function validControlValue(field: Range | Color, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === "") return !!field.allowDefault;
  if (field.type === "color") return HEX.test(value);
  const n = Number(value);
  return Number.isFinite(n) && n >= field.min && n <= field.max;
}

const resetButton = (action: string, value: Json, disabled: boolean, label: string): UiNode =>
  ({ type: "button", key: "default", text: "↺", action, value, small: true, variant: "ghost", disabled, tooltip: `Reset to ${label}`, style: { width: 24, padding: 0, noShrink: true } });

/** Native slider with live value; `↺` (when `allowDefault`) fires `resetAction` with `{ ...payload, value: "" }`. */
export function rangeControl(key: string, f: Omit<Range, "type" | "key" | "label">, action: string, resetAction: string, payload: Record<string, Json> = {}, disabled = false): UiNode {
  const n = f.value === "" ? null : Number(f.value);
  const value = n === null || !Number.isFinite(n) ? null : n;
  return { type: "row", key: `${key}:range`, gap: 6, align: "center", children: [
    { type: "slider", key, value, min: f.min, max: f.max, step: f.step || 1, action, showValue: true, unit: f.unit || "",
      emptyLabel: f.defaultLabel || "Default", disabled, grow: true },
    ...(f.allowDefault ? [resetButton(resetAction, { ...payload, value: "" }, disabled || value === null, (f.defaultLabel || "default").toLowerCase())] : []),
  ] };
}

/** Native color picker showing the hex value; `↺` (when `allowDefault`) clears it. */
export function colorControl(key: string, f: Omit<Color, "type" | "key" | "label">, action: string, resetAction: string, payload: Record<string, Json> = {}, disabled = false): UiNode {
  const value = HEX.test(f.value) ? f.value.toUpperCase() : null;
  return { type: "row", key: `${key}:color`, gap: 6, align: "center", children: [
    { type: "colorPicker", key, value, action, swatches: (f.swatches?.length ? f.swatches : defaultSwatches).filter(c => HEX.test(c)),
      label: value || "Default", disabled },
    ...(f.allowDefault ? [resetButton(resetAction, { ...payload, value: "" }, disabled || !value, "the default color")] : []),
  ] };
}
