//! Generic module-to-editor seams. Language policy and server protocols live in TS plugins.
use std::{cell::RefCell, collections::HashMap, ops::Range, rc::Rc, sync::{Arc, LazyLock, RwLock}, time::Duration};
use futures::channel::oneshot;
use gpui_kit::*;
use gpui_component::input::{CompletionProvider, HoverProvider, DefinitionProvider, EditorState, FoldRange, HighlightStyleResolver, InputEdit, InputHighlighter, Rope};
use gpui_component::highlighter::SyntaxHighlighter;
use serde_json::{json, Value};
use crate::{kernel::Kernel, router::Reply};

pub struct ModuleDefinitions {
    pub kernel: Arc<Kernel>, pub module: String, pub method: String, pub args: Value, pub document: String,
}
impl DefinitionProvider for ModuleDefinitions {
    fn definitions(&self, text: &Rope, offset: usize, _window: &mut Window, cx: &mut App) -> Task<anyhow::Result<Vec<lsp_types::LocationLink>>> {
        let (tx, rx) = oneshot::channel();
        let mut args = self.args.as_object().cloned().unwrap_or_default();
        args.insert("document".into(), json!(self.document));
        args.insert("text".into(), json!(text.to_string()));
        args.insert("position".into(), module_position(text, offset));
        // Invoke only the module that rendered this control, never a module named by its data.
        self.kernel.router.invoke(&self.module, json!({"kind":"call", "method":self.method, "args":args, "caller":"native.editor"}),
            Reply::Native(Box::new(move |result| { let _ = tx.send(result); })), Duration::from_secs(180));
        let text = text.to_string();
        cx.spawn(async move |_| {
            let mut value = rx.await.map_err(|_| anyhow::anyhow!("Editor provider disconnected"))?
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if let Some(links) = value.as_array_mut() { for link in links { if let Some(range) = link.get_mut("originSelectionRange") { native_ranges(range, &text); } } }
            Ok(serde_json::from_value(value)?)
        })
    }
}

/// The editor uses Unicode scalar columns; module language providers use UTF-16.
fn module_position(text: &Rope, offset: usize) -> Value {
    let value = text.to_string();
    let offset = offset.min(value.len());
    let before = &value[..value.floor_char_boundary(offset)];
    let line = before.bytes().filter(|b| *b == b'\n').count();
    let column = before.rsplit('\n').next().unwrap_or("").encode_utf16().count();
    json!({"line": line, "character": column})
}
pub fn native_position(text: &str, line: u32, character: u32) -> gpui_component::input::Position {
    let mut units = 0; let mut column = 0;
    for c in text.lines().nth(line as usize).unwrap_or("").chars() {
        if units + c.len_utf16() > character as usize { break; }
        units += c.len_utf16(); column += 1;
    }
    gpui_component::input::Position::new(line, column)
}
fn native_ranges(value: &mut Value, text: &str) {
    if let Some(object) = value.as_object_mut() {
        if let (Some(line), Some(character)) = (object.get("line").and_then(Value::as_u64), object.get("character").and_then(Value::as_u64)) {
            let position = native_position(text, line as u32, character as u32);
            object.insert("character".into(), json!(position.character));
        } else { for child in object.values_mut() { native_ranges(child, text); } }
    } else if let Some(items) = value.as_array_mut() { for item in items { native_ranges(item, text); } }
}
/// Generic callbacks to the module that owns a rendered editor.
pub struct ModuleIntelligence {
    pub kernel: Arc<Kernel>, pub module: String, pub method: String, pub args: Value,
    pub document: String, pub triggers: Vec<String>,
    /// Completion items most recently offered, so an accepted one can be resolved for its
    /// `additionalTextEdits` (e.g. auto-imports), which gpui-component does not apply itself.
    pub offered: Option<Offered>,
}
pub type Offered = Rc<RefCell<Option<(std::time::Instant, Vec<lsp_types::CompletionItem>)>>>;
impl ModuleIntelligence {
    fn request<T: serde::de::DeserializeOwned + 'static>(&self, text: &Rope, offset: usize, context: Option<Value>, cx: &mut App) -> Task<anyhow::Result<T>> {
        let (tx, rx) = oneshot::channel();
        let mut args = self.args.as_object().cloned().unwrap_or_default();
        args.insert("document".into(), json!(self.document));
        args.insert("text".into(), json!(text.to_string()));
        args.insert("position".into(), module_position(text, offset));
        if let Some(context) = context { args.insert("context".into(), context); }
        self.kernel.router.invoke(&self.module, json!({"kind":"call", "method":self.method, "args":args, "caller":"native.editor"}),
            Reply::Native(Box::new(move |result| { let _ = tx.send(result); })), Duration::from_secs(180));
        let text = text.to_string();
        cx.spawn(async move |_| {
            let mut value = rx.await.map_err(|_| anyhow::anyhow!("Editor provider disconnected"))?
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            native_ranges(&mut value, &text);
            Ok(serde_json::from_value(value)?)
        })
    }
}
impl HoverProvider for ModuleIntelligence {
    fn hover(&self, text: &Rope, offset: usize, _: &mut Window, cx: &mut App) -> Task<anyhow::Result<Option<lsp_types::Hover>>> {
        self.request(text, offset, None, cx)
    }
}
impl CompletionProvider for ModuleIntelligence {
    fn completions(&self, text: &Rope, offset: usize, trigger: lsp_types::CompletionContext, _: &mut Window, cx: &mut App) -> Task<anyhow::Result<lsp_types::CompletionResponse>> {
        let task = self.request::<lsp_types::CompletionResponse>(text, offset, Some(json!(trigger)), cx);
        let offered = self.offered.clone();
        cx.spawn(async move |_| {
            let response = task.await?;
            if let Some(offered) = offered {
                let items = match &response { lsp_types::CompletionResponse::Array(items) => items.clone(), lsp_types::CompletionResponse::List(list) => list.items.clone() };
                *offered.borrow_mut() = Some((std::time::Instant::now(), items));
            }
            Ok(response)
        })
    }
    fn is_completion_trigger(&self, _: usize, new_text: &str, _: &mut App) -> bool {
        new_text.chars().last().is_some_and(|c| c.is_alphanumeric() || c == '_') || self.triggers.iter().any(|t| new_text.ends_with(t))
    }
}

/// Module syntax scheme for the current appearance: per-capture styles that may carry token
/// backgrounds/underlines, which gpui-component's highlight theme cannot express. `generation`
/// changes whenever the scheme changes so cached editors can be reconfigured.
#[derive(Default)]
struct SyntaxOverlay { generation: u64, styles: HashMap<String, HighlightStyle>, decorated: bool }
static OVERLAY: LazyLock<RwLock<SyntaxOverlay>> = LazyLock::new(Default::default);

/// Replace the active overlay (empty map = no module scheme).
pub fn set_overlay(styles: HashMap<String, HighlightStyle>) {
    let mut o = OVERLAY.write().unwrap();
    if o.styles == styles { return; }
    o.decorated = styles.values().any(|s| s.background_color.is_some() || s.underline.is_some()) || styles.contains_key("bracket.0");
    o.styles = styles; o.generation += 1;
}
/// (generation, whether editors need the overlay-aware highlighter).
pub fn overlay_state() -> (u64, bool) { let o = OVERLAY.read().unwrap(); (o.generation, o.decorated) }

/// Resolve a capture through the overlay ("function.method" falls back to "function"), else the theme.
struct OverlayResolver<'a>(&'a dyn HighlightStyleResolver, &'a HashMap<String, HighlightStyle>);
impl HighlightStyleResolver for OverlayResolver<'_> {
    fn style(&self, name: &str) -> Option<HighlightStyle> {
        let mut key = name;
        loop {
            if let Some(style) = self.1.get(key) { return Some(*style); }
            match key.rfind('.') { Some(i) => key = &key[..i], None => return self.0.style(name) }
        }
    }
}
fn with_overlay<T>(resolver: &dyn HighlightStyleResolver, f: impl FnOnce(&dyn HighlightStyleResolver, &[HighlightStyle]) -> T) -> T {
    let o = OVERLAY.read().unwrap();
    // Scheme bracket palette: `bracket.0`, `bracket.1`, ... cycled by nesting depth.
    let brackets: Vec<HighlightStyle> = (0..16).map_while(|i| o.styles.get(&format!("bracket.{i}")).copied()).collect();
    if o.styles.is_empty() { f(resolver, &brackets) } else { f(&OverlayResolver(resolver, &o.styles), &brackets) }
}

/// Module-supplied highlight queries for bundled grammars (`codeViewer.highlightQuery`). The
/// grammar keeps its parser, injections and locals; an invalid query is ignored. Returns a key
/// that changes with the active query so editors can be re-highlighted.
static QUERIES: LazyLock<RwLock<HashMap<String, (u64, Option<gpui_component::highlighter::LanguageConfig>)>>> = LazyLock::new(Default::default);
pub fn register_highlights(language: &str, query: Option<&str>) -> u64 {
    use gpui_component::highlighter::LanguageRegistry;
    use std::hash::{Hash, Hasher};
    let key = query.map(|q| { let mut h = std::collections::hash_map::DefaultHasher::new(); q.hash(&mut h); h.finish() | 1 }).unwrap_or(0);
    let current = QUERIES.read().unwrap().get(language).map(|(k, _)| *k).unwrap_or(0);
    if current == key || language.is_empty() || language.len() > 64 { return current; }
    let registry = LanguageRegistry::singleton();
    let mut queries = QUERIES.write().unwrap();
    let original = match queries.get(language) { Some((_, original)) => original.clone(), None => registry.language(language) };
    let Some(original) = original else { return current };
    let Some(grammar) = original.language.clone() else { return current };
    match query {
        Some(q) if q.len() <= 256 * 1024 => match tree_sitter::Query::new(&grammar, q) {
            Ok(_) => {
                let mut config = original.clone();
                config.highlights = q.to_string().into();
                registry.register(language, &config);
            }
            Err(err) => { log::warn!("ignoring highlight query for {language}: {err}"); return current; }
        },
        Some(_) => return current,
        None => registry.register(language, &original),
    }
    queries.insert(language.to_string(), (key, Some(original)));
    key
}

/// Restyle spans by their text: `{baseCapture: {text: capture}}` (e.g. `{"type": {"Runnable":
/// "type.interface"}}`), so a module can apply semantic classes that survive edits.
pub type NameCaptures = Rc<RefCell<Vec<(String, HashMap<String, String>)>>>;
pub fn parse_name_captures(spec: &Value) -> Vec<(String, HashMap<String, String>)> {
    spec.as_object().into_iter().flatten().take(16).filter(|(base, _)| !base.is_empty() && base.len() <= 80).map(|(base, names)| {
        let names = names.as_object().into_iter().flatten().take(20_000)
            .filter_map(|(name, capture)| Some((name.clone(), capture.as_str().filter(|c| !c.is_empty() && c.len() <= 80 && name.len() <= 128)?.to_string()))).collect();
        (base.clone(), names)
    }).filter(|(_, names): &(String, HashMap<String, String>)| !names.is_empty()).collect()
}

const OPEN_BRACKETS: [&str; 3] = ["(", "[", "{"];
const CLOSE_BRACKETS: [&str; 3] = [")", "]", "}"];
/// Byte offsets and nesting depth of bracket tokens in `range` (strings and comments excluded).
fn bracket_depths(tree: &tree_sitter::Tree, range: &Range<usize>) -> Vec<(usize, bool, usize)> {
    fn visit<'t>(node: tree_sitter::Node<'t>, range: &Range<usize>, out: &mut Vec<tree_sitter::Node<'t>>) {
        if node.end_byte() <= range.start || node.start_byte() >= range.end || out.len() > 20_000 { return; }
        if node.child_count() == 0 {
            if !node.is_named() && (OPEN_BRACKETS.contains(&node.kind()) || CLOSE_BRACKETS.contains(&node.kind())) { out.push(node); }
            return;
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) { visit(child, range, out); }
    }
    let mut leaves = Vec::new();
    visit(tree.root_node(), range, &mut leaves);
    // Bracket children per ancestor, computed once per call.
    let mut cache: HashMap<usize, Vec<(usize, bool)>> = HashMap::new();
    leaves.into_iter().map(|leaf| {
        let pos = leaf.start_byte();
        let close = CLOSE_BRACKETS.contains(&leaf.kind());
        let mut depth: isize = if close { -1 } else { 0 };
        let mut ancestor = leaf.parent();
        while let Some(a) = ancestor {
            let kids = cache.entry(a.id()).or_insert_with(|| {
                let mut cursor = a.walk();
                a.children(&mut cursor).filter(|c| !c.is_named()).filter_map(|c| {
                    if OPEN_BRACKETS.contains(&c.kind()) { Some((c.start_byte(), true)) } else if CLOSE_BRACKETS.contains(&c.kind()) { Some((c.start_byte(), false)) } else { None }
                }).collect()
            });
            let net: isize = kids.iter().filter(|(p, _)| *p < pos).map(|(_, open)| if *open { 1 } else { -1 }).sum();
            depth += net.max(0);
            ancestor = a.parent();
        }
        (pos, close, depth.max(0) as usize)
    }).collect()
}
/// Lay `spans` over sorted, contiguous `styles`, splitting where needed. Overlaid styles are
/// merged so a token keeps its background.
fn overlay_spans(styles: Vec<(Range<usize>, HighlightStyle)>, spans: &[(Range<usize>, HighlightStyle)]) -> Vec<(Range<usize>, HighlightStyle)> {
    if spans.is_empty() { return styles; }
    let mut out = Vec::with_capacity(styles.len() + spans.len() * 2);
    let mut next = 0;
    for (range, style) in styles {
        let mut cursor = range.start;
        while next < spans.len() && spans[next].0.end <= cursor { next += 1; }
        let mut i = next;
        while i < spans.len() && spans[i].0.start < range.end {
            let (span, over) = &spans[i];
            let (start, end) = (span.start.max(cursor), span.end.min(range.end));
            if start >= end { i += 1; continue; }
            if cursor < start { out.push((cursor..start, style)); }
            let merged = style.highlight(*over);
            out.push((start..end, merged)); cursor = end;
            i += 1;
        }
        if cursor < range.end { out.push((cursor..range.end, style)); }
    }
    out
}

/// Parse a module scheme's `tokens` map into native styles. Unknown keys and bad colors are ignored.
pub fn scheme_styles(tokens: &Value, color: impl Fn(&str) -> Option<Hsla>) -> HashMap<String, HighlightStyle> {
    let mut out = HashMap::new();
    for (name, t) in tokens.as_object().into_iter().flatten().take(256) {
        if name.is_empty() || name.len() > 80 { continue; }
        let weight = t["fontWeight"].as_f64().map(|w| FontWeight(w.clamp(100.0, 900.0) as f32))
            .or_else(|| t["bold"].as_bool().map(|b| if b { FontWeight::BOLD } else { FontWeight::NORMAL }));
        let style = HighlightStyle {
            color: t["color"].as_str().and_then(&color),
            background_color: t["background"].as_str().and_then(&color),
            font_weight: weight,
            font_style: t["italic"].as_bool().map(|i| if i { FontStyle::Italic } else { FontStyle::Normal }),
            underline: t["underline"].as_bool().filter(|u| *u).map(|_| UnderlineStyle { thickness: px(1.0), color: None, wavy: false }),
            ..Default::default()
        };
        out.insert(name.clone(), style);
    }
    out
}

/// Text an accepted completion item inserts (mirrors gpui-component's `insert_completion`).
pub fn completion_text(item: &lsp_types::CompletionItem) -> &str {
    match &item.text_edit {
        Some(lsp_types::CompletionTextEdit::Edit(e)) => &e.new_text,
        Some(lsp_types::CompletionTextEdit::InsertAndReplace(e)) => &e.new_text,
        None => item.insert_text.as_deref().unwrap_or(&item.label),
    }
}
/// The single inserted segment between two texts (common prefix/suffix), with its start.
pub fn inserted(before: &str, after: &str) -> Option<(usize, String)> {
    if after.len() <= before.len() { return None; }
    let prefix = before.bytes().zip(after.bytes()).take_while(|(a, b)| a == b).count();
    let max_suffix = before.len() - prefix;
    let suffix = before.bytes().rev().zip(after.bytes().rev()).take(max_suffix).take_while(|(a, b)| a == b).count();
    let (start, end) = (after.floor_char_boundary(prefix), after.len() - suffix);
    (start < end && after.is_char_boundary(end)).then(|| (start, after[start..end].to_string()))
}
/// Byte offset of a zero-based UTF-16 LSP position.
pub fn byte_offset(text: &str, line: u32, character: u32) -> usize {
    let mut offset = 0;
    for (i, l) in text.split_inclusive('\n').enumerate() {
        if i == line as usize {
            let mut units = 0;
            for (b, c) in l.char_indices() {
                if units >= character as usize || c == '\n' { return offset + b; }
                units += c.len_utf16();
            }
            return offset + l.trim_end_matches('\n').len();
        }
        offset += l.len();
    }
    text.len()
}
/// Apply LSP text edits (e.g. import lines) to an editor without moving the user's caret.
pub fn apply_text_edits(state: &mut EditorState, edits: &[lsp_types::TextEdit], window: &mut Window, cx: &mut Context<EditorState>) {
    let text = state.value().to_string();
    let mut ranges: Vec<(Range<usize>, &str)> = edits.iter().map(|e| (byte_offset(&text, e.range.start.line, e.range.start.character)
        ..byte_offset(&text, e.range.end.line, e.range.end.character), e.new_text.as_str())).filter(|(r, _)| r.start <= r.end).collect();
    ranges.sort_by_key(|(r, _)| std::cmp::Reverse(r.start));
    let mut cursor = state.cursor();
    for (range, new_text) in ranges {
        state.set_selected_range(range.clone(), cx);
        state.replace(new_text.to_string(), window, cx);
        if range.end <= cursor { cursor = cursor + new_text.len() - (range.end - range.start); }
    }
    state.set_selected_range(cursor..cursor, cx);
}
/// One-shot call to the module that rendered an editor; resolves with the method's JSON result.
pub fn module_call(kernel: &Arc<Kernel>, module: &str, method: &str, args: Value, cx: &mut App) -> Task<anyhow::Result<Value>> {
    let (tx, rx) = oneshot::channel();
    kernel.router.invoke(module, json!({"kind":"call", "method":method, "args":args, "caller":"native.editor"}),
        Reply::Native(Box::new(move |result| { let _ = tx.send(result); })), Duration::from_secs(60));
    cx.spawn(async move |_| rx.await.map_err(|_| anyhow::anyhow!("Editor provider disconnected"))?.map_err(|e| anyhow::anyhow!(e.to_string())))
}
pub fn position_json(text: &str, offset: usize) -> Value { module_position(&Rope::from_str(text), offset) }

/// Module line markers painted in a strip at the editor's left edge (e.g. Git change bars).
/// `line..end_line` (zero-based, exclusive); an empty range is a deletion point between lines.
pub struct LineMarker { pub line: usize, pub end_line: usize, pub color: Hsla, pub value: Value }
/// Module-chosen code font (`codeViewer.font`): family, weight 100–900, size in px, and line
/// height as a multiple of the size. Unset fields keep the editor's theme defaults.
pub fn code_font(mut editor: gpui_component::input::Editor, font: &Value) -> gpui_component::input::Editor {
    if let Some(family) = font["family"].as_str().map(str::trim).filter(|f| !f.is_empty() && f.len() <= 128) { editor = editor.font_family(SharedString::from(family.to_owned())); }
    if let Some(size) = font["size"].as_f64().filter(|v| v.is_finite()) { editor = editor.text_size(px(size.clamp(8.0, 40.0) as f32)); }
    if let Some(height) = font["lineHeight"].as_f64().filter(|v| v.is_finite()) { editor = editor.line_height(relative(height.clamp(1.0, 3.0) as f32)); }
    if let Some(weight) = font["weight"].as_f64().filter(|v| v.is_finite()) { editor = editor.font_weight(FontWeight(weight.clamp(100.0, 900.0) as f32)); }
    editor
}

pub fn line_markers(spec: &Value, color: impl Fn(&str) -> Option<Hsla>) -> Vec<LineMarker> {
    spec.as_array().into_iter().flatten().take(5000).filter_map(|m| {
        let line = m["line"].as_u64()? as usize;
        let end_line = m["endLine"].as_u64().map(|e| e as usize).unwrap_or(line + 1).max(line);
        Some(LineMarker { line, end_line, color: m["color"].as_str().and_then(&color)?, value: m.get("value").cloned().unwrap_or(Value::Null) })
    }).collect()
}
/// Window-space vertical extents of each marker for the current layout (visible lines only).
pub fn marker_spans(state: &EditorState, markers: &[LineMarker]) -> Vec<(Pixels, Pixels, usize)> {
    use gpui_component::input::RopeExt;
    let (Some(line_height), text) = (state.line_height(), state.text()) else { return vec![] };
    let rows = text.lines_len();
    let top_of = |row: usize| { let o = text.line_start_offset(row.min(rows.saturating_sub(1))); state.range_to_bounds(&(o..o)).map(|b| b.origin.y) };
    let mut out = Vec::new();
    for (i, m) in markers.iter().enumerate() {
        if m.line >= rows.max(1) + 1 { continue; }
        if m.end_line == m.line {
            // Deletion: a short wedge on the boundary above `line`.
            let y = if m.line >= rows { top_of(rows.saturating_sub(1)).map(|y| y + line_height) } else { top_of(m.line) };
            if let Some(y) = y { out.push((y - px(3.0), y + px(3.0), i)); }
            continue;
        }
        let (Some(first), Some(last)) = (top_of(m.line), top_of(m.end_line.min(rows).saturating_sub(1))) else { continue };
        // The last line's top plus one line height includes its soft-wrapped rows only when the
        // next line exists; use the next line's top when available.
        let bottom = if m.end_line < rows { top_of(m.end_line).unwrap_or(last + line_height) } else { last + line_height };
        out.push((first, bottom.max(first + px(2.0)), i));
    }
    out
}

/// Ordered, bounded regex rules supplied by a module. No language names or keywords in Rust.
pub struct LexicalHighlighter {
    language: SharedString, regex: regex::Regex, captures: Vec<String>, spans: Vec<(Range<usize>, usize)>,
}
impl LexicalHighlighter {
    pub fn compile(language: &str, rules: &Value) -> Option<Self> {
        let rules = rules.as_array()?;
        if rules.is_empty() || rules.len() > 64 { return None; }
        let mut patterns = Vec::new(); let mut captures = Vec::new();
        for (i, rule) in rules.iter().enumerate() {
            let pattern = rule["pattern"].as_str()?;
            let capture = rule["capture"].as_str()?;
            if pattern.len() > 8192 || capture.len() > 80 { return None; }
            patterns.push(format!("(?P<token{i}>{pattern})")); captures.push(capture.to_string());
        }
        let regex = regex::RegexBuilder::new(&patterns.join("|")).size_limit(2 * 1024 * 1024).build().ok()?;
        Some(Self { language: language.to_string().into(), regex, captures, spans: vec![] })
    }
}
impl InputHighlighter for LexicalHighlighter {
    fn language(&self) -> SharedString { self.language.clone() }
    fn update(&mut self, _: Option<InputEdit>, text: &Rope, _: bool, _: &mut Window, _: &mut Context<EditorState>) {
        self.spans.clear();
        // Keep lexical work bounded for unusually large documents.
        if text.len() > 2 * 1024 * 1024 { return; }
        let text = text.to_string();
        for matched in self.regex.captures_iter(&text) {
            for i in 0..self.captures.len() {
                if let Some(m) = matched.name(&format!("token{i}")) {
                    if m.start() < m.end() { self.spans.push((m.start()..m.end(), i)); }
                    break;
                }
            }
        }
    }
    fn styles(&self, range: &Range<usize>, resolver: &dyn HighlightStyleResolver) -> Vec<(Range<usize>, HighlightStyle)> {
        with_overlay(resolver, |resolver, _| self.lexical_styles(range, resolver))
    }
    fn fold_ranges(&self, _: &Rope) -> Vec<FoldRange> { vec![] }
}
impl LexicalHighlighter {
    fn lexical_styles(&self, range: &Range<usize>, resolver: &dyn HighlightStyleResolver) -> Vec<(Range<usize>, HighlightStyle)> {
        let mut result = Vec::new(); let mut cursor = range.start;
        for (span, i) in &self.spans {
            if span.end <= range.start { continue; }
            if span.start >= range.end { break; }
            let start = span.start.max(range.start); let end = span.end.min(range.end);
            if cursor < start { result.push((cursor..start, HighlightStyle::default())); }
            result.push((start..end, resolver.style(&self.captures[*i]).unwrap_or_default())); cursor = end;
        }
        if cursor < range.end { result.push((cursor..range.end, HighlightStyle::default())); }
        result
    }
}
/// Tree-sitter highlighting used when an editor needs module-controlled styles (a lexical override
/// was removed, or the syntax scheme paints token backgrounds). Edits are applied incrementally
/// with a short synchronous budget; anything slower is reparsed shortly after typing settles.
/// Ordinary editors keep gpui-component's own background-parsing adapter.
struct GrammarHighlighter { inner: Rc<RefCell<SyntaxHighlighter>>, reparse: Rc<RefCell<Option<Task<()>>>>, names: NameCaptures }
const SYNC_PARSE: Duration = Duration::from_millis(4);
const MAX_GRAMMAR_BYTES: usize = 4 * 1024 * 1024;
impl GrammarHighlighter {
    fn new(language: &str, names: NameCaptures) -> Self { Self { inner: Rc::new(RefCell::new(SyntaxHighlighter::new(language))), reparse: Rc::new(RefCell::new(None)), names } }
    fn settle(&mut self, done: bool, text: &Rope, window: &mut Window, cx: &mut Context<EditorState>) {
        if done || text.len() > MAX_GRAMMAR_BYTES { self.reparse.borrow_mut().take(); return; }
        let (inner, text) = (self.inner.clone(), text.clone());
        let task = cx.spawn_in(window, async move |state, cx| {
            cx.background_executor().timer(Duration::from_millis(150)).await;
            // `update` skips unchanged text, so a deferred full parse uses a fresh highlighter.
            let language = inner.borrow().language().to_string();
            let mut fresh = SyntaxHighlighter::new(&language);
            fresh.update(None, &text, None);
            *inner.borrow_mut() = fresh;
            let _ = state.update(cx, |_, cx| cx.notify());
        });
        self.reparse.borrow_mut().replace(task);
    }
}
fn ts_edit(e: InputEdit) -> tree_sitter::InputEdit {
    tree_sitter::InputEdit {
        start_byte: e.start_byte, old_end_byte: e.old_end_byte, new_end_byte: e.new_end_byte,
        start_position: tree_sitter::Point::new(e.start_position.row, e.start_position.column),
        old_end_position: tree_sitter::Point::new(e.old_end_position.row, e.old_end_position.column),
        new_end_position: tree_sitter::Point::new(e.new_end_position.row, e.new_end_position.column),
    }
}
impl InputHighlighter for GrammarHighlighter {
    fn language(&self) -> SharedString { self.inner.borrow().language().clone() }
    fn update(&mut self, edit: Option<InputEdit>, text: &Rope, _: bool, window: &mut Window, cx: &mut Context<EditorState>) {
        let done = {
            let mut inner = self.inner.borrow_mut();
            if text.len() > MAX_GRAMMAR_BYTES { inner.edit_tree(edit.map(ts_edit), text); false }
            else { inner.update(edit.map(ts_edit), text, Some(SYNC_PARSE)) }
        };
        self.settle(done, text, window, cx);
    }
    fn styles(&self, range: &Range<usize>, resolver: &dyn HighlightStyleResolver) -> Vec<(Range<usize>, HighlightStyle)> {
        with_overlay(resolver, |resolver, brackets| {
            let inner = self.inner.borrow();
            let mut styles = inner.styles(range, resolver);
            let names = self.names.borrow();
            if !names.is_empty() {
                let bases: Vec<_> = names.iter().filter_map(|(base, map)| Some((resolver.style(base)?, map))).collect();
                let text = inner.text();
                for (span, style) in styles.iter_mut() {
                    if span.len() > 128 { continue; }
                    let Some((_, map)) = bases.iter().find(|(base, _)| base == style) else { continue };
                    if let Some(next) = map.get(&text.slice(span.clone()).to_string()).and_then(|capture| resolver.style(capture)) { *style = next; }
                }
            }
            if !brackets.is_empty() {
                if let Some(tree) = inner.tree() {
                    let spans: Vec<_> = bracket_depths(tree, range).into_iter()
                        .map(|(pos, _, depth)| (pos..pos + 1, brackets[depth % brackets.len()])).collect();
                    styles = overlay_spans(styles, &spans);
                }
            }
            styles
        })
    }
    fn fold_ranges(&self, _: &Rope) -> Vec<FoldRange> {
        fn collect(node: tree_sitter::Node, out: &mut Vec<FoldRange>) {
            let (start, end) = (node.start_position().row, node.end_position().row);
            if end.saturating_sub(start) < 2 { return; }
            out.push(FoldRange::new(start, end));
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) { collect(child, out); }
        }
        let inner = self.inner.borrow();
        let Some(tree) = inner.tree() else { return vec![] };
        let mut out = Vec::new(); let root = tree.root_node(); let mut cursor = root.walk();
        for child in root.named_children(&mut cursor) { collect(child, &mut out); }
        out.sort_by_key(|r| r.start_line); out.dedup_by_key(|r| r.start_line);
        out
    }
}
/// Install highlighting for a code editor. The module-aware factory replaces gpui-component's
/// default only when needed: lexical rules, a decorated syntax scheme, or a previous override.
pub fn configure_syntax(state: &mut EditorState, language: &str, rules: Value, names: NameCaptures, overridden: bool, cx: &mut Context<EditorState>) -> bool {
    let has_rules = rules.as_array().is_some_and(|rules| !rules.is_empty());
    let needed = has_rules || overridden || overlay_state().1 || !names.borrow().is_empty();
    if needed {
        state.set_highlighter_factory(Rc::new(move |lang| {
            Some(match LexicalHighlighter::compile(lang, &rules) {
                Some(highlighter) => Box::new(highlighter) as Box<dyn InputHighlighter>,
                None => Box::new(GrammarHighlighter::new(lang, names.clone())) as Box<dyn InputHighlighter>,
            })
        }), cx);
    }
    state.set_highlighter(language.to_string(), cx);
    needed
}

#[cfg(test)]
mod tests {
    use super::LexicalHighlighter;
    use serde_json::json;
    #[test]
    fn provider_positions_translate_utf16_and_editor_columns() {
        let text = "// 😀\n😀target";
        let rope = gpui_component::input::Rope::from_str(text);
        assert_eq!(super::module_position(&rope, "// 😀\n😀".len()), json!({"line":1,"character":2}));
        assert_eq!(super::native_position(text, 1, 2).character, 1);
        let mut hover = json!({"range":{"start":{"line":1,"character":2},"end":{"line":1,"character":8}}});
        super::native_ranges(&mut hover, text);
        assert_eq!(hover["range"]["start"]["character"], 1);
        assert_eq!(hover["range"]["end"]["character"], 7);
    }
    #[test]
    fn language_package_lexical_rules_compile() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Hato-plugins/modules/services");
        let mut checked = 0;
        for entry in std::fs::read_dir(path).unwrap() {
            let manifest = entry.unwrap().path().join("manifest.json");
            let Ok(text) = std::fs::read_to_string(&manifest) else { continue; };
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            for language in value["contributes"]["languages"].as_array().into_iter().flatten() {
                if language["syntaxRules"].is_array() {
                    assert!(LexicalHighlighter::compile(language["id"].as_str().unwrap(), &language["syntaxRules"]).is_some(), "{}", manifest.display());
                    checked += 1;
                }
            }
        }
        assert!(checked > 0);
    }
    #[test]
    fn lexical_rules_respect_priority_and_unicode_offsets() {
        let h = LexicalHighlighter::compile("custom", &json!([
            {"pattern":"//[^\\n]*", "capture":"comment"},
            {"pattern":"\\bentity\\b", "capture":"keyword"}
        ])).unwrap();
        let text = "é // entity\nentity";
        let matches: Vec<_> = h.regex.find_iter(text).map(|m| (m.start(), m.as_str())).collect();
        assert_eq!(matches, vec![(3, "// entity"), (13, "entity")]);
        assert!(LexicalHighlighter::compile("custom", &json!([{"pattern":"(", "capture":"keyword"}])).is_none());
    }
}
#[cfg(test)]
mod highlight_query_tests {
    use std::sync::Mutex;
    use gpui_component::input::{HighlightStyleResolver, Rope};
    use gpui_component::highlighter::SyntaxHighlighter;
    use gpui_kit::{hsla, HighlightStyle};
    /// Resolves every capture to a distinct color so tests can read capture names back.
    struct Names(Mutex<Vec<String>>);
    impl HighlightStyleResolver for Names {
        fn style(&self, name: &str) -> Option<HighlightStyle> {
            let mut v = self.0.lock().unwrap();
            let i = v.iter().position(|n| n == name).unwrap_or_else(|| { v.push(name.to_string()); v.len() - 1 });
            Some(HighlightStyle { color: Some(hsla(i as f32 / 1000.0, 0.5, 0.5, 1.0)), ..Default::default() })
        }
    }
    #[test]
    fn module_query_overrides_bundled_grammar_and_brackets_nest() {
        // The Java query ships with the language-java plugin (nested checkout); skip without it.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Hato-plugins/modules/services/language-java/manifest.json");
        let Ok(manifest) = std::fs::read_to_string(path) else { return };
        let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        let query = manifest["contributes"]["languages"][0]["highlightQuery"].as_array().unwrap()
            .iter().map(|l| l.as_str().unwrap()).collect::<Vec<_>>().join("\n");
        let language = "java-query-test";
        let config = gpui_component::highlighter::LanguageRegistry::singleton().language("java").unwrap();
        gpui_component::highlighter::LanguageRegistry::singleton().register(language, &config);
        assert_ne!(super::register_highlights(language, Some(&query)), 0, "query must compile");
        let code = "@Component\nclass A implements EventHandler {\n void f() {\n  switch (t.get()) {\n   case DROPDOWN: X.CDS_NAME.add(this.ids);\n  }\n }\n}\n";
        let mut h = SyntaxHighlighter::new(language);
        h.update(None, &Rope::from_str(code), None);
        let names = Names(Mutex::new(vec![]));
        let captures: std::collections::HashMap<String, String> = h.styles(&(0..code.len()), &names).into_iter().filter_map(|(r, s)| {
            Some((code[r].to_string(), names.0.lock().unwrap()[(s.color?.h * 1000.0).round() as usize].clone()))
        }).collect();
        for (text, capture) in [("Component", "attribute"), ("EventHandler", "type"), ("switch", "keyword"), ("case", "keyword"),
            ("DROPDOWN", "constant"), ("CDS_NAME", "constant"), ("X", "type"), ("ids", "property"), ("{", "punctuation.bracket")] {
            assert_eq!(captures.get(text).map(String::as_str), Some(capture), "{text}");
        }
        let depths: Vec<String> = super::bracket_depths(h.tree().unwrap(), &(0..code.len())).iter().map(|(p, _, d)| format!("{}{d}", &code[*p..*p + 1])).collect();
        assert_eq!(depths, ["{0", "(1", ")1", "{1", "(2", "(3", ")3", ")2", "{2", "(3", ")3", "}2", "}1", "}0"]);
        assert_eq!(super::register_highlights(language, None), 0);
    }
    #[test]
    fn overlay_spans_split_and_merge() {
        let base = HighlightStyle { background_color: Some(hsla(0.0, 0.0, 0.5, 1.0)), ..Default::default() };
        let over = HighlightStyle { color: Some(hsla(0.5, 0.5, 0.5, 1.0)), ..Default::default() };
        let out = super::overlay_spans(vec![(0..4, base), (4..6, HighlightStyle::default())], &[(1..2, over), (4..5, over)]);
        let ranges: Vec<_> = out.iter().map(|(r, _)| r.clone()).collect();
        assert_eq!(ranges, [0..1, 1..2, 2..4, 4..5, 5..6]);
        assert_eq!(out[1].1.background_color, base.background_color);
        assert_eq!(out[1].1.color, over.color);
    }
}
