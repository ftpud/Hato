import type { UiNode } from './types';
export interface TableStyle { density: 'compact' | 'comfortable' | 'spacious'; stripes: boolean; dividers: boolean }
export const defaultTableStyle: TableStyle = { density: 'comfortable', stripes: true, dividers: false };
export function normalizeTableStyle(raw: any): TableStyle {
  return { density: ['compact','comfortable','spacious'].includes(raw?.density) ? raw.density : 'comfortable', stripes: raw?.stripes !== false, dividers: raw?.dividers === true };
}
export const listRowHeight = (style: TableStyle) => ({ compact: 22, comfortable: 28, spacious: 34 }[style.density]);
/** A reusable code-native table with module-supplied cell content. The control column is `controlWidth`
 *  wide (default 240); a row may widen its own control (e.g. sliders). `header` adds column titles. */
export function uiTable(key: string, rows: { key: string; label: string; description?: string; control: UiNode; controlWidth?: number }[], style = defaultTableStyle,
  options: { header?: [string, string]; controlWidth?: number } = {}): UiNode {
  const width = options.controlWidth ?? 240;
  return { type: 'column', key, gap: 0, style: { borderColor: 'border', borderWidth: 1, radius: 8 }, children: [
    ...(options.header ? [{ type: 'row', key: 'head', gap: 16, padding: 10, bg: 'panel', children: [{ type: 'label', key: 'name', text: options.header[0], grow: true, size: 'xs', weight: 'semibold', color: 'muted' }, { type: 'label', key: 'value', text: options.header[1], width, size: 'xs', weight: 'semibold', color: 'muted' }] } as UiNode] : []),
    ...rows.map((row, i): UiNode => ({ type: 'row', key: row.key, gap: 16, padding: style.density === 'compact' ? 6 : style.density === 'spacious' ? 14 : 10, align: 'center', style: { ...(style.stripes && i % 2 === 1 ? { background: 'raised' } : {}), ...(style.dividers ? { borderBottom: 1, borderColor: 'border' } : {}) }, children: [
      { type: 'column', key: 'label', grow: true, gap: 3, children: [{ type: 'label', key: 'name', text: row.label, size: 'sm', wrap: true }, ...(row.description ? [{ type: 'label', key: 'description', text: row.description, size: 'xs', color: 'muted', wrap: true } as UiNode] : [])] },
      { type: 'column', key: 'control', width: row.controlWidth ?? width, style: { noShrink: true }, children: [row.control] },
    ] })),
  ] };
}
