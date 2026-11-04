//! Native terminal element: renders the kernel-owned alacritty grid for a PTY handle and sends
//! keystrokes straight to the PTY (high-frequency input never crosses into JS). Mouse selection,
//! copy/paste and Cmd/Ctrl+click on web links are native terminal behavior, like in any terminal.
use crate::host::pty::PtySession;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{viewport_to_point, TermMode};
use std::cell::Cell as StdCell;
use std::rc::Rc;
use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor};
use gpui_kit::*;
use gpui_component::ActiveTheme;
use std::sync::atomic::Ordering;
use std::sync::Arc;

pub struct TerminalView {
    pub session: Arc<PtySession>,
    focus: FocusHandle,
    cell: Option<(Pixels, Pixels)>,
    font_size: Pixels,
    measured_font: Option<(SharedString, FontWeight)>,
    /// Painted grid bounds (set during prepaint) for mapping mouse positions to cells.
    bounds: Rc<StdCell<Option<Bounds<Pixels>>>>,
    selecting: bool,
    /// Link under the pointer while Cmd/Ctrl is held: (url, [(viewport row, col start, col end)]).
    hover_link: Option<(String, Vec<(usize, usize, usize)>)>,
    last_mouse: Option<Point<Pixels>>,
}

/// Character span [start, end) of the http(s) URL covering `idx` in a logical line.
pub(crate) fn find_link(chars: &[char], idx: usize) -> Option<(usize, usize)> {
    let starts_at = |i: usize, p: &str| p.chars().enumerate().all(|(k, c)| chars.get(i + k).is_some_and(|x| x.to_ascii_lowercase() == c));
    let stop = |c: char| c.is_whitespace() || c.is_control() || "<>\"'`{}|\\^".contains(c);
    let mut i = 0;
    while i < chars.len() {
        if !(starts_at(i, "https://") || starts_at(i, "http://")) || (i > 0 && chars[i - 1].is_alphanumeric()) { i += 1; continue; }
        let mut end = i;
        while end < chars.len() && !stop(chars[end]) { end += 1; }
        // Trim trailing punctuation and closing brackets that are not part of the URL.
        loop {
            let Some(&last) = chars[i..end].last() else { break };
            let unbalanced = |open: char, close: char| last == close && chars[i..end].iter().filter(|&&c| c == open).count() < chars[i..end].iter().filter(|&&c| c == close).count();
            if ".,;:!?".contains(last) || unbalanced('(', ')') || unbalanced('[', ']') { end -= 1; } else { break; }
        }
        let scheme = if starts_at(i, "https://") { 8 } else { 7 };
        if end > i + scheme && (i..end).contains(&idx) { return Some((i, end)); }
        i = end.max(i + 1);
    }
    None
}

fn rgb(hex: u32) -> Hsla { gpui_kit::rgb(hex).into() }

const PALETTE: [u32; 16] = [
    0x23242f, 0xed8796, 0xa6d6ad, 0xe8cd97, 0x91b7ed, 0xb6a0ff, 0x8bd5ca, 0xd4d4e0,
    0x686b82, 0xf5a4b0, 0xbce6c1, 0xf0ddb1, 0xaccbfa, 0xc8b8ff, 0xa5e5dc, 0xf1f1f7,
];

const LIGHT_PALETTE: [u32; 16] = [
    0x28293b, 0xb83650, 0x287340, 0x8b6516, 0x345fa8, 0x6847c7, 0x237779, 0x62657e,
    0x555870, 0xc13f5b, 0x337d4c, 0x926c1b, 0x416ab4, 0x7958d8, 0x2b8082, 0x767990,
];

fn indexed(i: u8, palette: &[u32; 16]) -> Hsla {
    match i {
        0..=15 => rgb(palette[i as usize]),
        16..=231 => {
            let i = i - 16;
            let c = |v: u8| if v == 0 { 0 } else { 55 + v as u32 * 40 };
            rgb((c(i / 36) << 16) | (c((i / 6) % 6) << 8) | c(i % 6))
        }
        _ => {
            let v = 8 + (i as u32 - 232) * 10;
            rgb((v << 16) | (v << 8) | v)
        }
    }
}

fn resolve(c: &AnsiColor, colors: &alacritty_terminal::term::color::Colors, fg: bool, default_fg: Hsla, default_bg: Hsla, palette: &[u32; 16]) -> Hsla {
    match c {
        AnsiColor::Spec(rgbv) => rgb(((rgbv.r as u32) << 16) | ((rgbv.g as u32) << 8) | rgbv.b as u32),
        AnsiColor::Indexed(i) => {
            if let Some(o) = colors[*i as usize] {
                rgb(((o.r as u32) << 16) | ((o.g as u32) << 8) | o.b as u32)
            } else {
                indexed(*i, palette)
            }
        }
        AnsiColor::Named(n) => {
            let idx = *n as usize;
            if let Some(o) = colors[idx] {
                return rgb(((o.r as u32) << 16) | ((o.g as u32) << 8) | o.b as u32);
            }
            match n {
                NamedColor::Foreground | NamedColor::BrightForeground => default_fg,
                NamedColor::Background => default_bg,
                NamedColor::Cursor => default_fg,
                NamedColor::DimForeground => rgb(palette[8]),
                _ if idx < 16 => rgb(palette[idx]),
                _ if idx >= NamedColor::DimBlack as usize => {
                    let base = idx - NamedColor::DimBlack as usize;
                    let mut h = rgb(palette[base.min(7)]);
                    h.l *= 0.7;
                    h
                }
                _ => if fg { default_fg } else { default_bg },
            }
        }
    }
}

impl TerminalView {
    pub fn new(session: Arc<PtySession>, cx: &mut Context<Self>) -> Self {
        TerminalView { session, focus: cx.focus_handle(), cell: None, font_size: px(13.0), measured_font: None,
            bounds: Rc::new(StdCell::new(None)), selecting: false, hover_link: None, last_mouse: None }
    }

    /// Viewport cell under a window position, clamped to the grid, plus the cell half.
    fn cell_at(&self, pos: Point<Pixels>) -> Option<(usize, usize, Side)> {
        let (cw, ch) = self.cell?;
        let b = self.bounds.get()?;
        let (rows, cols) = { let t = self.session.term.lock(); (t.screen_lines(), t.columns()) };
        let fx = ((pos.x - b.origin.x - px(4.0)) / cw).max(0.0);
        let fy = ((pos.y - b.origin.y - px(2.0)) / ch).max(0.0);
        let col = (fx.floor() as usize).min(cols.saturating_sub(1));
        let row = (fy.floor() as usize).min(rows.saturating_sub(1));
        Some((row, col, if fx.fract() < 0.5 { Side::Left } else { Side::Right }))
    }

    fn grid_point(&self, row: usize, col: usize) -> GridPoint {
        let offset = self.session.term.lock().grid().display_offset();
        viewport_to_point(offset, GridPoint::new(row, Column(col)))
    }

    /// The web link at a viewport cell, following soft-wrapped rows.
    fn link_at(&self, row: usize, col: usize) -> Option<(String, Vec<(usize, usize, usize)>)> {
        let term = self.session.term.lock();
        let (rows, cols, offset) = (term.screen_lines(), term.columns(), term.grid().display_offset());
        let cell = |r: usize, c: usize| &term.grid()[viewport_to_point(offset, GridPoint::new(r, Column(c)))];
        let wraps = |r: usize| cell(r, cols - 1).flags.contains(Flags::WRAPLINE);
        let (mut r0, mut r1) = (row, row);
        while r0 > 0 && wraps(r0 - 1) { r0 -= 1; }
        while r1 + 1 < rows && wraps(r1) { r1 += 1; }
        let (mut chars, mut at, mut target) = (Vec::new(), Vec::new(), None);
        for r in r0..=r1 {
            for c in 0..cols {
                let x = cell(r, c);
                if x.flags.contains(Flags::WIDE_CHAR_SPACER) { continue; }
                if (r, c) == (row, col) { target = Some(chars.len()); }
                chars.push(x.c);
                at.push((r, c));
            }
        }
        let (start, end) = find_link(&chars, target?)?;
        let url: String = chars[start..end].iter().collect();
        let mut spans: Vec<(usize, usize, usize)> = Vec::new();
        for &(r, c) in &at[start..end] {
            match spans.last_mut() { Some((sr, _, e)) if *sr == r => *e = c + 1, _ => spans.push((r, c, c + 1)) }
        }
        Some((url, spans))
    }

    fn update_hover(&mut self, modifiers: &Modifiers, cx: &mut Context<Self>) {
        let next = if modifiers.platform || modifiers.control {
            self.last_mouse.and_then(|p| self.cell_at(p)).and_then(|(r, c, _)| self.link_at(r, c))
        } else { None };
        if next.as_ref().map(|l| &l.1) != self.hover_link.as_ref().map(|l| &l.1) { self.hover_link = next; cx.notify(); }
    }

    fn finish_selection(&mut self, cx: &mut Context<Self>) {
        if !self.selecting { return; }
        self.selecting = false;
        let mut term = self.session.term.lock();
        if term.selection.as_ref().is_some_and(|s| s.is_empty()) { term.selection = None; }
        drop(term);
        cx.notify();
    }

    fn copy_selection(&self, cx: &mut Context<Self>) -> bool {
        let text = self.session.term.lock().selection_to_string();
        match text {
            Some(t) if !t.is_empty() => { cx.write_to_clipboard(ClipboardItem::new_string(t)); true }
            _ => false,
        }
    }

    fn paste(&self, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else { return };
        let bracketed = self.session.term.lock().mode().contains(TermMode::BRACKETED_PASTE);
        let bytes = if bracketed {
            // Strip ESC so pasted text cannot end bracketed-paste mode early.
            format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', "")).into_bytes()
        } else {
            text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
        };
        let _ = self.session.write(&bytes);
    }

    fn key_bytes(&self, ks: &Keystroke) -> Option<Vec<u8>> {
        let m = &ks.modifiers;
        let app_cursor = self.session.term.lock().mode().contains(TermMode::APP_CURSOR);
        let arrow = |c: char| -> Vec<u8> {
            if m.shift || m.alt || m.control {
                let modv = 1 + (m.shift as u8) + 2 * (m.alt as u8) + 4 * (m.control as u8);
                format!("\x1b[1;{modv}{c}").into_bytes()
            } else if app_cursor {
                format!("\x1bO{c}").into_bytes()
            } else {
                format!("\x1b[{c}").into_bytes()
            }
        };
        if m.platform {
            return None; // cmd-shortcuts belong to the app (copy/paste handled separately)
        }
        let seq: Vec<u8> = match ks.key.as_str() {
            "enter" => b"\r".to_vec(),
            "tab" => if m.shift { b"\x1b[Z".to_vec() } else { b"\t".to_vec() },
            "backspace" => if m.alt { b"\x1b\x7f".to_vec() } else { b"\x7f".to_vec() },
            "escape" => b"\x1b".to_vec(),
            "up" => arrow('A'),
            "down" => arrow('B'),
            "right" => arrow('C'),
            "left" => arrow('D'),
            "home" => b"\x1b[H".to_vec(),
            "end" => b"\x1b[F".to_vec(),
            "pageup" => b"\x1b[5~".to_vec(),
            "pagedown" => b"\x1b[6~".to_vec(),
            "delete" => b"\x1b[3~".to_vec(),
            "insert" => b"\x1b[2~".to_vec(),
            "f1" => b"\x1bOP".to_vec(),
            "f2" => b"\x1bOQ".to_vec(),
            "f3" => b"\x1bOR".to_vec(),
            "f4" => b"\x1bOS".to_vec(),
            "space" => if m.control { vec![0] } else { b" ".to_vec() },
            k if m.control && k.len() == 1 => {
                let c = k.as_bytes()[0].to_ascii_lowercase();
                match c {
                    b'a'..=b'z' => vec![c - b'a' + 1],
                    b'[' => vec![27],
                    b'\\' => vec![28],
                    b']' => vec![29],
                    b'^' => vec![30],
                    b'_' | b'-' => vec![31],
                    _ => return None,
                }
            }
            _ => {
                let s = ks.key_char.clone()?;
                let mut v = Vec::new();
                if m.alt {
                    v.push(0x1b);
                }
                v.extend_from_slice(s.as_bytes());
                v
            }
        };
        Some(seq)
    }
}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle { self.focus.clone() }
}

struct Frame {
    rows: Vec<(Vec<(String, Hsla, bool)>, Vec<(usize, usize, Hsla)>)>,
    cursor: Option<(usize, usize)>,
    exited: Option<String>,
    /// Underlined link cells: (row, col start, col end).
    links: Vec<(usize, usize, usize)>,
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let module_palette = super::theme::terminal_palette(cx);
        let palette = match &module_palette { Some(p) => p, None if cx.theme().mode.is_dark() => &PALETTE, None => &LIGHT_PALETTE };
        let default_fg = cx.theme().foreground;
        let default_bg = cx.theme().background;
        let selection_bg = cx.theme().selection;
        self.session.dirty.store(false, Ordering::SeqCst);
        let font_key = (cx.theme().mono_font_family.clone(), super::theme::font_weight(cx));
        if self.measured_font.as_ref() != Some(&font_key) { self.cell = None; self.measured_font = Some(font_key.clone()); }
        let font = Font { family: font_key.0, features: Default::default(), fallbacks: None, weight: font_key.1, style: FontStyle::Normal };
        if self.font_size != cx.theme().mono_font_size { self.font_size = cx.theme().mono_font_size; self.cell = None; }
        let font_size = self.font_size;
        if self.cell.is_none() {
            let shaped = window.text_system().shape_line("MMMMMMMMMM".into(), font_size, &[TextRun { len: 10, font: font.clone(), color: default_fg, background_color: None, underline: None, strikethrough: None }], None);
            let w = shaped.width / 10.0;
            self.cell = Some((w, (font_size * 1.35).round()));
        }
        let (cw, ch) = self.cell.unwrap();
        // Snapshot the grid (brief lock; parsing continues on the reader thread).
        let frame = {
            let term = self.session.term.lock();
            let content = term.renderable_content();
            let rows = term.screen_lines();
            let cols = term.columns();
            let colors = content.colors;
            let selection = content.selection;
            let mut grid: Vec<Vec<(char, Hsla, Hsla, bool)>> = vec![vec![(' ', default_fg, default_bg, false); cols]; rows];
            let offset = content.display_offset as i32;
            for cell in content.display_iter {
                let line = cell.point.line.0 + offset;
                if line < 0 || line as usize >= rows || cell.point.column.0 >= cols {
                    continue;
                }
                let mut fg = resolve(&cell.fg, colors, true, default_fg, default_bg, palette);
                let mut bg = resolve(&cell.bg, colors, false, default_fg, default_bg, palette);
                if cell.flags.contains(Flags::INVERSE) {
                    std::mem::swap(&mut fg, &mut bg);
                }
                if cell.flags.contains(Flags::DIM) {
                    fg.l *= 0.7;
                }
                if selection.is_some_and(|s| s.contains(cell.point)) {
                    bg = selection_bg;
                }
                let c = if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::HIDDEN) { ' ' } else { cell.c };
                grid[line as usize][cell.point.column.0] = (c, fg, bg, cell.flags.contains(Flags::BOLD));
            }
            let cur = content.cursor.point;
            let cursor_line = cur.line.0 + offset;
            let show_cursor = term.mode().contains(TermMode::SHOW_CURSOR) && cursor_line >= 0 && (cursor_line as usize) < rows;
            let mut out_rows = Vec::with_capacity(rows);
            for row in grid {
                let mut runs: Vec<(String, Hsla, bool)> = Vec::new();
                let mut bgs: Vec<(usize, usize, Hsla)> = Vec::new();
                for (x, (c, fg, bg, bold)) in row.into_iter().enumerate() {
                    match runs.last_mut() {
                        Some((s, f, b)) if *f == fg && *b == bold => s.push(c),
                        _ => runs.push((c.to_string(), fg, bold)),
                    }
                    if bg != default_bg {
                        match bgs.last_mut() {
                            Some((_, end, b)) if *b == bg && *end == x => *end = x + 1,
                            _ => bgs.push((x, x + 1, bg)),
                        }
                    }
                }
                out_rows.push((runs, bgs));
            }
            Frame { rows: out_rows, cursor: if show_cursor { Some((cur.column.0, cursor_line as usize)) } else { None }, exited: self.session.exit.lock().clone(),
                links: self.hover_link.as_ref().map(|l| l.1.clone()).unwrap_or_default() }
        };
        let session = self.session.clone();
        let focused = self.focus.is_focused(window);
        let font2 = font.clone();
        let grid_bounds = self.bounds.clone();
        let link_cursor = self.hover_link.is_some();
        let root = div()
            .id("terminal")
            .track_focus(&self.focus)
            .size_full()
            .bg(default_bg);
        let root = if link_cursor { root.cursor_pointer() } else { root.cursor(CursorStyle::IBeam) };
        root
            .on_mouse_down(MouseButton::Left, cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                window.focus(&this.focus, cx);
                this.last_mouse = Some(ev.position);
                let Some((row, col, side)) = this.cell_at(ev.position) else { cx.notify(); return };
                if ev.modifiers.platform || ev.modifiers.control {
                    if let Some((url, _)) = this.link_at(row, col) { cx.open_url(&url); return; }
                }
                let point = this.grid_point(row, col);
                let mut term = this.session.term.lock();
                if ev.modifiers.shift && term.selection.is_some() {
                    if let Some(sel) = term.selection.as_mut() { sel.update(point, side); }
                } else {
                    let ty = match ev.click_count { 2 => SelectionType::Semantic, n if n >= 3 => SelectionType::Lines, _ => SelectionType::Simple };
                    term.selection = Some(Selection::new(ty, point, side));
                }
                drop(term);
                this.selecting = true;
                cx.notify();
            }))
            // macOS may deliver Ctrl+click as a secondary click.
            .on_mouse_down(MouseButton::Right, cx.listener(|this, ev: &MouseDownEvent, _, cx| {
                if !ev.modifiers.control { return; }
                if let Some((url, _)) = this.cell_at(ev.position).and_then(|(r, c, _)| this.link_at(r, c)) { cx.open_url(&url); cx.stop_propagation(); }
            }))
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, _, cx| {
                this.last_mouse = Some(ev.position);
                if this.selecting && ev.pressed_button == Some(MouseButton::Left) {
                    if let Some((row, col, side)) = this.cell_at(ev.position) {
                        let point = this.grid_point(row, col);
                        if let Some(sel) = this.session.term.lock().selection.as_mut() { sel.update(point, side); }
                        cx.notify();
                    }
                }
                this.update_hover(&ev.modifiers, cx);
            }))
            .on_modifiers_changed(cx.listener(|this, ev: &ModifiersChangedEvent, _, cx| { this.update_hover(&ev.modifiers, cx); }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, _, cx| { this.finish_selection(cx); }))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, _, cx| { this.finish_selection(cx); }))
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _window, cx| {
                let m = &ev.keystroke.modifiers;
                let key = ev.keystroke.key.as_str();
                // Copy: Cmd+C, Ctrl+Shift+C, or Ctrl+C while text is selected (Ctrl+C without a
                // selection still interrupts). Paste: Cmd+V, Ctrl+V, Ctrl+Shift+V.
                if key == "c" && (m.platform || m.control) {
                    let has_selection = this.session.term.lock().selection.as_ref().is_some_and(|s| !s.is_empty());
                    if m.platform || m.shift || has_selection {
                        let copied = this.copy_selection(cx);
                        if copied && m.control && !m.shift { this.session.term.lock().selection = None; cx.notify(); }
                        if copied || !m.platform { cx.stop_propagation(); }
                        return;
                    }
                }
                if key == "v" && (m.platform || m.control) {
                    this.paste(cx);
                    cx.stop_propagation();
                    return;
                }
                if let Some(bytes) = this.key_bytes(&ev.keystroke) {
                    let had_selection = { let mut t = this.session.term.lock(); t.selection.take().is_some() };
                    let _ = this.session.write(&bytes);
                    if had_selection { cx.notify(); }
                    cx.stop_propagation();
                }
            }))
            .on_scroll(cx.listener(move |this, ev: &ScrollEvent, _, cx| {
                let d = ev.delta.pixel_delta(ch);
                let lines = (d.y / ch).round() as i32;
                if lines != 0 {
                    this.session.term.lock().scroll_display(alacritty_terminal::grid::Scroll::Delta(lines));
                    cx.notify();
                }
            }))
            .child(
                canvas(
                    move |bounds, _, _| {
                        grid_bounds.set(Some(bounds));
                        let cols = ((bounds.size.width - px(8.0)) / cw).floor().max(10.0) as u16;
                        let rows = ((bounds.size.height - px(4.0)) / ch).floor().max(3.0) as u16;
                        let _ = session.resize(cols, rows);
                        frame
                    },
                    move |bounds, frame, window, cx| {
                        let origin = bounds.origin + point(px(4.0), px(2.0));
                        for (y, (runs, bgs)) in frame.rows.iter().enumerate() {
                            let top = origin.y + ch * y as f32;
                            for (x0, x1, bg) in bgs {
                                window.paint_quad(fill(Bounds::new(point(origin.x + cw * *x0 as f32, top), size(cw * (*x1 - *x0) as f32, ch)), *bg));
                            }
                            let mut x = 0usize;
                            for (text, fg, bold) in runs {
                                let n = text.chars().count();
                                let trimmed = text.trim_end();
                                if !trimmed.is_empty() {
                                    let mut f = font2.clone();
                                    if *bold {
                                        f.weight = FontWeight::BOLD;
                                    }
                                    let s: SharedString = trimmed.to_string().into();
                                    let line = window.text_system().shape_line(s.clone(), font_size, &[TextRun { len: s.len(), font: f, color: *fg, background_color: None, underline: None, strikethrough: None }], Some(cw));
                                    let _ = line.paint(point(origin.x + cw * x as f32, top), ch, TextAlign::Left, None, window, cx);
                                }
                                x += n;
                            }
                        }
                        for (row, c0, c1) in &frame.links {
                            let r = Bounds::new(point(origin.x + cw * *c0 as f32, origin.y + ch * (*row as f32 + 1.0) - px(2.0)), size(cw * (*c1 - *c0) as f32, px(1.0)));
                            window.paint_quad(fill(r, default_fg));
                        }
                        if let Some((cx_, cy)) = frame.cursor {
                            let r = Bounds::new(point(origin.x + cw * cx_ as f32, origin.y + ch * cy as f32), size(cw, ch));
                            if focused {
                                window.paint_quad(fill(r, Hsla { a: 0.55, ..default_fg }));
                            } else {
                                window.paint_quad(outline(r, default_fg, BorderStyle::Solid));
                            }
                        }
                        let _ = frame.exited;
                    },
                )
                .size_full(),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::find_link;
    fn link(text: &str, at: usize) -> Option<String> {
        let chars: Vec<char> = text.chars().collect();
        find_link(&chars, at).map(|(a, b)| chars[a..b].iter().collect())
    }
    #[test]
    fn finds_web_links_and_trims_punctuation() {
        assert_eq!(link("see https://example.com/a?b=1.", 8).as_deref(), Some("https://example.com/a?b=1"));
        assert_eq!(link("(http://x.io/path) done", 3).as_deref(), Some("http://x.io/path"));
        assert_eq!(link("wiki https://en.wikipedia.org/wiki/Rust_(language) ok", 10).as_deref(), Some("https://en.wikipedia.org/wiki/Rust_(language)"));
        assert_eq!(link("<https://a.dev/x>", 3).as_deref(), Some("https://a.dev/x"));
        assert_eq!(link("no link here", 3), None);
        assert_eq!(link("https://", 2), None);
        assert_eq!(link("xhttps://a.dev", 3), None);
        assert_eq!(link("https://a.dev  later", 16), None);
    }
}
