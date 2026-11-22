// Presentation of debugger values, shared by the Debug panel's Variables tree and the editor's
// debug hover. It is pure, with no service calls. Callers own loading and pass children in through
// a lookup. Works from DAP `Variable` fields as js-debug and java-debug report them.
import type { MenuItem, TreeRow, UiColor } from "./types";
import type { DebugVariable } from "./debug";

/** DAP `presentationHint`, passed through by the debug service when the adapter sends it. */
export interface VariableHint { kind?: string; attributes?: string[]; visibility?: string; lazy?: boolean }
export type ValueVariable = DebugVariable & { presentationHint?: VariableHint };

export type ValueKind =
  | "string" | "number" | "boolean" | "null" | "undefined" | "bigint" | "symbol" | "regexp"
  | "array" | "map" | "set" | "collection" | "date" | "enum" | "function" | "class" | "error" | "promise"
  | "object" | "virtual" | "unavailable";

export interface ValueView {
  kind: ValueKind;
  /** One-line value text (strings quoted and escaped, collections as "size N"). */
  summary: string;
  /** Semantic color for `summary`. */
  color: UiColor;
  /** Short type name for the row badge (package stripped, generics kept short). */
  badge?: string;
  /** Element count for collections and arrays, when known. */
  size?: number;
  /** The full value differs from `summary` (truncated string or multi-line). */
  truncated: boolean;
  iconSvg: string;
}

const icon = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
/** Kind glyphs: shape carries the kind, so meaning never depends on color alone. */
export const valueIcons = {
  primitive: icon("<circle cx='12' cy='12' r='3.2' fill='currentColor'/>"),
  string: icon("<path d='M7 7h4v4c0 3-1.5 5-4 6M14 7h4v4c0 3-1.5 5-4 6'/>"),
  array: icon("<path d='M8 4H5v16h3M16 4h3v16h-3'/>"),
  map: icon("<path d='M8 4c-2 0-3 1-3 3v2.5c0 1.5-1 2.5-2 2.5 1 0 2 1 2 2.5V17c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2.5c0 1.5 1 2.5 2 2.5-1 0-2 1-2 2.5V17c0 2-1 3-3 3'/>"),
  object: icon("<rect x='4.5' y='4.5' width='15' height='15' rx='3'/><path d='M9 10h6M9 14h4'/>"),
  date: icon("<rect x='4' y='5.5' width='16' height='14' rx='2'/><path d='M4 10h16M8 3.5v4M16 3.5v4'/>"),
  enumeration: icon("<path d='M5 7h3M5 12h3M5 17h3M11 7h8M11 12h8M11 17h8'/>"),
  fn: icon("<path d='M14 4c-3 0-3.5 2-4 5l-1.5 7c-.5 2.5-1.5 4-4 4M7 10h8'/>"),
  error: icon("<path d='M12 3.5 21 19.5H3z'/><path d='M12 10v4M12 17v.2'/>"),
  promise: icon("<circle cx='12' cy='12' r='8'/><path d='M12 7.5V12l3 2'/>"),
  virtual: icon("<path d='M5 12h14' stroke-dasharray='2 3'/>"),
};

const STRING_MAX = 120;
const JAVA_BOXED = new Set(["Integer", "Long", "Short", "Byte", "Double", "Float", "Character", "Boolean", "BigDecimal", "BigInteger", "AtomicInteger", "AtomicLong", "AtomicBoolean"]);
const JAVA_DATES = /^(Instant|LocalDate|LocalDateTime|LocalTime|ZonedDateTime|OffsetDateTime|OffsetTime|Date|Timestamp|Calendar|GregorianCalendar|Duration|Period)$/;
const MAP_TYPES = /(Map|Dictionary|Properties|Hashtable|Record)$/;
const SET_TYPES = /Set$/;
const LIST_TYPES = /(List|Collection|Queue|Deque|Vector|Stack|Iterable|Array|Buffer)$|\[\]$/;

/** Short display type: drops packages and long generic arguments ("java.util.HashMap<String,List<Foo>>" → "HashMap<String,…>"). */
export function shortType(type?: string): string | undefined {
  if (!type) return undefined;
  const t = type.trim();
  const lt = t.indexOf("<");
  const base = (lt < 0 ? t : t.slice(0, lt)).split(/[.$]/).pop() || t;
  if (lt < 0) return base;
  // Split generic arguments at top level only, so nested generics don't break apart.
  const body = t.slice(lt + 1, t.lastIndexOf(">"));
  const args: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c === "<") depth++; else if (c === ">") depth--;
    else if ((c === "," && depth === 0) || i === body.length) { args.push(body.slice(from, i).trim()); from = i + 1; }
  }
  const short = args.map(a => { const g = a.indexOf("<"); const n = (g < 0 ? a : a.slice(0, g)).split(/[.$]/).pop() || "?"; return g < 0 ? n : `${n}<…>`; });
  const inner = short.join(",");
  return `${base}<${inner.length > 24 ? short[0] + ",…" : inner}>`;
}

/** The element count adapters put in value text: "size=3", "Array(3)", "Map(2)", "int[3]", "(3)". */
function sizeOf(v: ValueVariable): number | undefined {
  const m = /\bsize=(\d+)/.exec(v.value) || /^[\w$.]*(?:Array|Map|Set|List)\((\d+)\)/.exec(v.value) || /\[(\d+)\]$/.exec(v.value) || /^[\w$.]+\[(\d+)\]/.exec(v.value);
  if (m) return Number(m[1]);
  return v.indexedVariables && v.indexedVariables > 0 ? v.indexedVariables : undefined;
}

/** Escapes control characters so a value always fits one row. */
export function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/[\u0000-\u001f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function clip(s: string, max = STRING_MAX): [string, boolean] {
  return s.length > max ? [s.slice(0, max - 1) + "…", true] : [s, false];
}
/** Unquoted string content when `value` is a quoted literal ('x', "x"). */
function unquote(value: string): string | null {
  const q = value[0];
  if ((q === "\"" || q === "'" || q === "`") && value.length >= 2 && value.endsWith(q)) return value.slice(1, -1);
  return null;
}

/** "2026-11-22T10:15:00Z" → "3 min ago" / "in 2 h"; null when the text isn't a recognisable time. */
export function relativeTime(text: string, now = Date.now()): string | null {
  const iso = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/.exec(text)?.[0];
  const t = iso ? Date.parse(iso) : Date.parse(text);
  if (!Number.isFinite(t)) return null;
  const d = (t - now) / 1000, a = Math.abs(d);
  const [n, u] = a < 60 ? [Math.round(a), "s"] : a < 3600 ? [Math.round(a / 60), "min"] : a < 86400 ? [Math.round(a / 3600), "h"] : a < 86400 * 60 ? [Math.round(a / 86400), "d"] : [Math.round(a / (86400 * 30.4)), "mo"];
  if (a < 1) return "now";
  return d < 0 ? `${n} ${u} ago` : `in ${n} ${u}`;
}

/** Classifies a DAP variable and builds its one-line presentation. */
export function describeValue(v: ValueVariable): ValueView {
  const raw = v.value ?? "";
  const type = v.type?.trim();
  const badge = shortType(type);
  const base = (badge || "").replace(/<.*$/, "");
  const hint = v.presentationHint;
  const view = (kind: ValueKind, summary: string, color: UiColor, iconSvg: string, extra: Partial<ValueView> = {}): ValueView =>
    ({ kind, summary, color, badge, truncated: false, iconSvg, ...extra });

  if (hint?.lazy) return view("virtual", "…", "muted", valueIcons.virtual, { badge: badge || "getter" });
  if (hint?.kind === "virtual" || /^\[\[.*\]\]$|^\[\d+…\d+\]$/.test(v.name)) return view("virtual", raw, "muted", valueIcons.virtual);
  if (/^<?(not available|optimized out|unavailable)>?$/i.test(raw) || /^<error/i.test(raw)) return view("unavailable", raw, "muted", valueIcons.virtual);

  // Strings: quoted literals, java.lang.String, and Java boxed Character.
  const str = unquote(raw);
  if (str !== null || base === "String" || type === "string") {
    const content = str ?? raw.replace(/^String@\d+\s*/, "").replace(/^"(.*)"$/s, "$1");
    const [text, cut] = clip(escapeString(content));
    return view("string", `"${text}"`, "success", valueIcons.string, { truncated: cut || content.includes("\n"), size: content.length, badge: badge || "string" });
  }
  if (raw === "null" || raw === "None" || raw === "nil") return view("null", "null", "muted", valueIcons.primitive);
  if (raw === "undefined") return view("undefined", "undefined", "muted", valueIcons.primitive);
  if (raw === "true" || raw === "false") return view("boolean", raw, "primary", valueIcons.primitive, { badge: badge || "boolean" });
  if (/^-?\d+n$/.test(raw)) return view("bigint", raw, "info", valueIcons.primitive, { badge: badge || "bigint" });
  if (/^-?(\d[\d_]*(\.\d+)?([eE][+-]?\d+)?|NaN|Infinity|0x[\da-fA-F]+)[dDfFlL]?$/.test(raw) || type === "number") return view("number", raw, "info", valueIcons.primitive, { badge: badge || "number" });
  if (/^Symbol\(/.test(raw)) return view("symbol", raw, "warning", valueIcons.primitive);
  if (/^\/.+\/[dgimsuyv]*$/.test(raw)) return view("regexp", raw, "warning", valueIcons.primitive, { badge: badge || "RegExp" });

  // Java boxed primitives: "Integer@12 5" / "5" with a boxed type → show the bare value.
  if (JAVA_BOXED.has(base)) {
    const inner = raw.replace(/^[\w$.]+@[\da-f]+\s*/, "").replace(/^"(.*)"$/, "$1");
    return view(base === "Boolean" || base === "AtomicBoolean" ? "boolean" : "number", inner, base.startsWith("Bool") || base === "AtomicBoolean" ? "primary" : "info", valueIcons.primitive);
  }

  if (/^(ƒ|function\b|async\b|\(.*\)\s*=>|[\w$]+\s*=>)/.test(raw) || type === "function" || /\$\$Lambda|Function$|Supplier$|Consumer$|Runnable$|Callable$/.test(type || "")) {
    const sig = raw.replace(/^ƒ\s*/, "").replace(/\s*\{[\s\S]*$/, "");
    return view("function", clip(`ƒ ${sig}`, 80)[0], "muted", valueIcons.fn, { badge: badge || "function" });
  }
  if (/^class\s/.test(raw)) return view("class", raw.replace(/\s*\{[\s\S]*$/, ""), "muted", valueIcons.object);
  if (/^Promise\b/.test(raw) || base === "Promise" || /Future$/.test(base)) {
    const state = /<(pending|fulfilled|rejected)>|\b(pending|fulfilled|rejected|resolved|completed)\b/i.exec(raw);
    const s = (state?.[1] || state?.[2] || "").toLowerCase();
    return view("promise", s ? `${base || "Promise"} · ${s}` : raw, s === "rejected" ? "danger" : s ? "success" : "warning", valueIcons.promise);
  }
  if (/(Error|Exception|Throwable)$/.test(base) || /^[\w$.]*(Error|Exception)\b[:@]/.test(raw)) {
    const msg = raw.split("\n")[0].replace(/^[\w$.]+@[\da-f]+\s*/, "");
    return view("error", clip(msg, 100)[0], "danger", valueIcons.error, { truncated: raw.includes("\n") });
  }
  if (JAVA_DATES.test(base) || /^Date\b/.test(raw)) {
    const text = raw.replace(/^[\w$.]+@[\da-f]+\s*/, "").replace(/^Date\s+/, "").replace(/^"(.*)"$/, "$1");
    const rel = relativeTime(text);
    return view("date", rel ? `${text}  ·  ${rel}` : text, "warning", valueIcons.date);
  }
  if (hint?.kind === "enum" || /\bEnum\b/.test(type || "") || (/^[A-Z][A-Z0-9_]+$/.test(raw) && !!type && !/^(int|long|char)$/.test(type))) {
    return view("enum", raw.replace(/^[\w$.]+@[\da-f]+\s*/, ""), "warning", valueIcons.enumeration);
  }

  const size = sizeOf(v);
  const sized = (kind: ValueKind, iconSvg: string, color: UiColor = "default") =>
    view(kind, size !== undefined ? (size === 0 ? "empty" : `size ${size}`) : raw.replace(/^[\w$.]+@[\da-f]+\s*/, "") || raw, size === 0 ? "muted" : color, iconSvg, { size });
  if (MAP_TYPES.test(base) || /^Map\(/.test(raw)) return sized("map", valueIcons.map);
  if (SET_TYPES.test(base) || /^Set\(/.test(raw)) return sized("set", valueIcons.array);
  if (LIST_TYPES.test(base) || /^(Array|\w+Array)\(\d+\)/.test(raw) || /\[\d+\]$/.test(raw)) return sized("array", valueIcons.array);
  if (v.indexedVariables && v.indexedVariables > 0) return sized("collection", valueIcons.array);

  // Plain objects: drop the identity hash ("Foo@1a2b"), keep a short preview ("{a: 1, b: 2}").
  const preview = raw.replace(/^[\w$.]+@[\da-f]+\s*/, "").trim();
  // Keep the identity hash ("Foo@1a2b") when there's no preview: it tells two instances apart.
  const [text, cut] = clip(preview && preview !== base ? preview : raw || base, 100);
  return view(v.variablesReference > 0 ? "object" : "unavailable", text, "default", valueIcons.object, { truncated: cut });
}

/** Rows per page when a node has more indexed children than this. */
export const VALUE_PAGE = 100;

/** A children request: a whole node, or one page of an indexed node. */
export interface ChildRange { variablesReference: number; start?: number; count?: number;
  /** Pass to the debug service's `variables`: "named" for a paged node's fields, "indexed" for a page. */
  filter?: "named" | "indexed" }
export const childKey = (r: ChildRange) => r.start === undefined ? `${r.variablesReference}` : `${r.variablesReference}:${r.start}:${r.count}`;

export interface ValueTreeOptions {
  /** Loaded children per `childKey(range)`; missing means not loaded yet. */
  children: (key: string) => ValueVariable[] | undefined;
  expanded: ReadonlySet<string>;
  /** Row key → what expanding that row loads. Filled during the build. */
  ranges?: Map<string, ChildRange>;
  /** Row key → variable. Filled during the build (for context actions). */
  vars?: Map<string, ValueVariable>;
  /** Previous values by evaluateName (or row path) from the last stop; changed rows are marked. */
  previous?: ReadonlyMap<string, string>;
  /** Extra context menu per variable (e.g. "Add to watches"). */
  menu?: (v: ValueVariable, key: string) => MenuItem[];
  /** Row cap so a huge object can't stall the renderer. */
  maxRows?: number;
}

/** The identity used to compare a value across steps. */
export const valueIdentity = (v: ValueVariable, key: string) => v.evaluateName || key.replace(/^[^/]*\//, "");

function row(v: ValueVariable, key: string, depth: number, open: boolean, o: ValueTreeOptions): TreeRow {
  const d = describeValue(v);
  const prev = o.previous?.get(valueIdentity(v, key));
  const changed = prev !== undefined && prev !== v.value;
  const readOnly = v.presentationHint?.attributes?.includes("readOnly");
  const badges: { text: string; color?: UiColor }[] = [];
  if (changed) badges.push({ text: "changed", color: "warning" });
  if (d.kind === "string" && d.size !== undefined && d.size > 40) badges.push({ text: `${d.size} chars`, color: "muted" });
  const tooltip = [`${v.type ? `${v.type} ` : ""}${v.name}`, changed ? `was ${prev}` : "", readOnly ? "read-only" : "", d.truncated ? `${v.value.slice(0, 400)}${v.value.length > 400 ? "…" : ""}\n(right-click to copy the full value)` : ""]
    .filter(Boolean).join("\n");
  return {
    key, label: v.name, value: d.summary, valueColor: changed ? "warning" : d.color, badge: d.badge, badges: badges.length ? badges : undefined,
    iconSvg: d.iconSvg, iconColor: changed ? "warning" : d.color === "default" ? "muted" : d.color,
    depth, expandable: v.variablesReference > 0, expanded: open, selected: false,
    weight: v.presentationHint?.visibility === "private" || d.kind === "virtual" ? undefined : depth === 0 ? "medium" : undefined,
    tooltip: tooltip.slice(0, 500),
    contextMenu: [
      { text: "Copy value", action: "", copyText: v.value },
      ...(v.evaluateName ? [{ text: "Copy expression", action: "", copyText: v.evaluateName }] : []),
      ...(o.menu ? o.menu(v, key) : []),
    ],
  };
}

/** Tree rows for the children of `range` under `prefix`. Indexed nodes with more than VALUE_PAGE
 *  children become page groups ("[0…99]"), each loaded on expand. */
export function valueTreeRows(range: ChildRange, prefix: string, depth: number, o: ValueTreeOptions, out: TreeRow[] = [], indexed = 0): TreeRow[] {
  const max = o.maxRows ?? 2000;
  if (out.length >= max) return out;
  if (indexed > VALUE_PAGE && range.start === undefined) {
    // Named children (e.g. "length", internal fields) first, then the index pages.
    const named = o.children(childKey(range)) || [];
    const seen = new Set<string>();
    for (const v of named.filter(x => !/^\d+$/.test(x.name))) pushVar(v, prefix, depth, o, out, seen);
    for (let start = 0; start < indexed && out.length < max; start += VALUE_PAGE) {
      const count = Math.min(VALUE_PAGE, indexed - start);
      const key = `${prefix}/[${start}]`;
      const page: ChildRange = { variablesReference: range.variablesReference, start, count, filter: "indexed" };
      o.ranges?.set(key, page);
      const open = o.expanded.has(key);
      out.push({ key, label: `[${start}…${start + count - 1}]`, depth, expandable: true, expanded: open, selected: false, iconSvg: valueIcons.array, iconColor: "muted" } as TreeRow);
      if (open) valueTreeRows(page, key, depth + 1, o, out);
    }
    return out;
  }
  const list = o.children(childKey(range));
  if (!list) { out.push({ key: `${prefix}/…loading`, label: "Loading…", depth, expandable: false, expanded: false, selected: false, busy: true } as TreeRow); return out; }
  if (!list.length && depth > 0) out.push({ key: `${prefix}/…empty`, label: "No fields", depth, expandable: false, expanded: false, selected: false } as TreeRow);
  const seen = new Set<string>();
  for (const v of list) { if (out.length >= max) break; pushVar(v, prefix, depth, o, out, seen); }
  if (out.length >= max) out.push({ key: `${prefix}/…more`, label: "Too many rows. Narrow with a watch expression.", depth, expandable: false, expanded: false, selected: false } as TreeRow);
  return out;
}
function pushVar(v: ValueVariable, prefix: string, depth: number, o: ValueTreeOptions, out: TreeRow[], seen: Set<string>) {
  // Shadowed Java fields repeat a name; keys must stay unique and stable across refreshes.
  let key = `${prefix}/${v.name}`;
  for (let n = 2; seen.has(key); n++) key = `${prefix}/${v.name}#${n}`;
  seen.add(key);
  o.vars?.set(key, v);
  const paged = (v.indexedVariables || 0) > VALUE_PAGE;
  if (v.variablesReference > 0) o.ranges?.set(key, { variablesReference: v.variablesReference, ...(paged ? { filter: "named" as const } : {}) });
  const open = o.expanded.has(key) && v.variablesReference > 0;
  out.push(row(v, key, depth, open, o));
  if (open) valueTreeRows({ variablesReference: v.variablesReference }, key, depth + 1, o, out, v.indexedVariables || 0);
}

/** Snapshot of displayed values (identity → value) to diff against after the next step. */
export function valueSnapshot(vars: ReadonlyMap<string, ValueVariable>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [key, v] of vars) m.set(valueIdentity(v, key), v.value);
  return m;
}
