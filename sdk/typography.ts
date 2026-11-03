// Preferences and defaults belong to modules; the native theme only applies this data.
export const fontOptions = [
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'system', label: 'System font' },
  { value: 'Menlo', label: 'Menlo' },
  { value: 'Monaco', label: 'Monaco' },
];
export function typography(font: string, size = "15", weight = "400") {
  return { fontFamily: font === 'system' ? '.SystemUIFont' : font,
    monoFontFamily: font === 'system' ? 'JetBrains Mono' : font, fontWeight: Number(weight), fontSize: Number(size), monoFontSize: Number(size) - 3 };
}
