// Syntax color schemes for the native editor, diff and Markdown code views. A scheme is plain
// JSON, so users can drop custom ones into `<sharedDir>/syntax-schemes/*.json`. Bundled into
// workspace-layout, which passes the selected scheme to the native `theme` node as `syntax`.
//
// Token keys are tree-sitter capture names ("keyword", "type", "string.escape", ...). A dotted
// capture without its own entry falls back to its parent ("function.method" → "function").

export interface SyntaxToken { color?: string; background?: string; bold?: boolean; italic?: boolean; underline?: boolean; fontWeight?: number }
export interface SyntaxPalette {
  tokens: Record<string, SyntaxToken>;
  editor?: { background?: string; foreground?: string; activeLine?: string; lineNumber?: string; activeLineNumber?: string; gutter?: string; invisible?: string };
}
/** `light`/`dark` per appearance; a scheme with only one applies it to both. */
export interface SyntaxScheme { id: string; name: string; light?: SyntaxPalette; dark?: SyntaxPalette }

// "Weird": the ftpud Java palette from VibeEditor — token backgrounds for types, strings,
// annotations and constants, bold navy keywords.
const weirdLight: SyntaxPalette = {
  editor: { background: "#f8faff", foreground: "#25324d" },
  tokens: {
    variable: { color: "#000000" },
    keyword: { color: "#000080", bold: true },
    "type.builtin": { color: "#000080", bold: true },
    "constant.builtin": { color: "#000080", bold: true },
    "variable.builtin": { color: "#000080", bold: true },
    "variable.special": { color: "#000080", bold: true },
    "function.builtin": { color: "#000080", bold: true },
    boolean: { color: "#000080", bold: true },
    number: { color: "#0000ff" },
    attribute: { color: "#808000", background: "#e4ffcd" },
    tag: { color: "#000000" },
    type: { color: "#000000", background: "#adc9ff" },
    constructor: { color: "#000000", bold: true },
    constant: { color: "#800080", background: "#e4ffcd", bold: true, italic: true },
    property: { color: "#800080", bold: true },
    function: { color: "#000000", bold: true },
    "function.method": { color: "#000000" },
    string: { color: "#008000", background: "#dfffdf", bold: true },
    "string.escape": { color: "#008000", background: "#ffd4aa", bold: true },
    "string.regex": { color: "#0000ff" },
    comment: { color: "#808080", italic: true },
    "comment.doc": { color: "#808080", italic: true },
    operator: { color: "#25324d" },
    punctuation: { color: "#25324d" },
  },
};
const weirdDark: SyntaxPalette = {
  editor: { background: "#171e2e", foreground: "#dce4f5" },
  tokens: {
    variable: { color: "#d4d4d4" },
    keyword: { color: "#7aa2f7" },
    "type.builtin": { color: "#7aa2f7" },
    "constant.builtin": { color: "#7aa2f7" },
    "variable.builtin": { color: "#7aa2f7" },
    "variable.special": { color: "#7aa2f7" },
    "function.builtin": { color: "#7aa2f7" },
    boolean: { color: "#7aa2f7" },
    number: { color: "#8db6ff" },
    attribute: { color: "#c2c07e", background: "#304231" },
    type: { color: "#cbd8e8", background: "#29384a" },
    constructor: { color: "#f0f0f0", bold: true },
    constant: { color: "#caa2d1", background: "#304231", bold: true, italic: true },
    property: { color: "#d9a0e8", bold: true },
    function: { color: "#f0f0f0", bold: true },
    "function.method": { color: "#f0f0f0", bold: true },
    string: { color: "#9ac8a2", background: "#293d30", bold: true },
    "string.escape": { color: "#9ac8a2", background: "#293d30", bold: true },
    comment: { color: "#99a39b", background: "#293a32", italic: true },
    "comment.doc": { color: "#99a39b", background: "#293a32", italic: true },
  },
};

export const bundledSchemes: SyntaxScheme[] = [
  { id: "default", name: "Default" },
  { id: "weird", name: "Weird (ftpud)", light: weirdLight, dark: weirdDark },
];

const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
function palette(value: any): SyntaxPalette | undefined {
  if (!value || typeof value !== "object" || !value.tokens || typeof value.tokens !== "object") return undefined;
  const tokens: Record<string, SyntaxToken> = {};
  for (const [name, t] of Object.entries<any>(value.tokens).slice(0, 256)) {
    if (!/^[a-z_][a-z0-9_.-]{0,79}$/i.test(name) || !t || typeof t !== "object") continue;
    const token: SyntaxToken = {};
    if (HEX.test(t.color)) token.color = t.color;
    if (HEX.test(t.background)) token.background = t.background;
    for (const flag of ["bold", "italic", "underline"] as const) if (typeof t[flag] === "boolean") token[flag] = t[flag];
    if (typeof t.fontWeight === "number" && t.fontWeight >= 100 && t.fontWeight <= 900) token.fontWeight = t.fontWeight;
    tokens[name] = token;
  }
  const editor: Record<string, string> = {};
  for (const key of ["background", "foreground", "activeLine", "lineNumber", "activeLineNumber", "gutter", "invisible"])
    if (HEX.test(value.editor?.[key])) editor[key] = value.editor[key];
  return { tokens, ...(Object.keys(editor).length ? { editor } : {}) };
}

/** Validate a user scheme file. `fallbackId` (file name) is used when the JSON has no id. */
export function parseScheme(text: string, fallbackId: string): SyntaxScheme {
  let raw: any;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`); }
  if (!raw || typeof raw !== "object") throw new Error("a scheme must be a JSON object");
  const light = palette(raw.light), dark = palette(raw.dark), both = palette(raw);
  if (!light && !dark && !both) throw new Error("a scheme needs `tokens`, or `light`/`dark` objects with `tokens`");
  const id = `custom:${String(raw.id || fallbackId).replace(/[^a-z0-9_.-]/gi, "-").slice(0, 60)}`;
  return { id, name: String(raw.name || fallbackId).slice(0, 80), light: light || both || dark, dark: dark || both || light };
}

/** Native `theme.syntax` value for a scheme (undefined keeps the built-in highlighting). */
export function schemeNode(scheme: SyntaxScheme | undefined) {
  if (!scheme || (!scheme.light && !scheme.dark)) return undefined;
  return { light: scheme.light || scheme.dark, dark: scheme.dark || scheme.light };
}
