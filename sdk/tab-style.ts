import type { UiStyle } from './types';
// Reference: quiet tabs, slate labels and a fine indigo underline for the active file.
export function fileTabStyle(active: boolean): UiStyle {
  return { background: active ? 'field' : 'surface', color: active ? 'text' : 'muted',
    borderBottom: 2, borderColor: active ? 'primary' : 'surface', radius: 5 };
}
export function terminalTabStyle(active: boolean): UiStyle {
  return { background: active ? 'selection' : 'surface', color: active ? 'primary' : 'muted', radius: 6 };
}
export function tabButtonStyle(active: boolean, terminal = false): UiStyle {
  const { background, color } = terminal ? terminalTabStyle(active) : fileTabStyle(active);
  return { background, color, fontWeight: 400, radius: 4, paddingX: 9, paddingY: 5, minHeight: 30 };
}
