//! Native terminal element: renders the kernel-owned alacritty grid for a PTY handle and sends
//! keystrokes straight to the PTY (high-frequency input never crosses into JS).
use crate::host::pty::PtySession;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::TermMode;
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
        TerminalView { session, focus: cx.focus_handle(), cell: None, font_size: px(13.0), measured_font: None }
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
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let module_palette = super::theme::terminal_palette(cx);
        let palette = match &module_palette { Some(p) => p, None if cx.theme().mode.is_dark() => &PALETTE, None => &LIGHT_PALETTE };
        let default_fg = cx.theme().foreground;
        let default_bg = cx.theme().background;
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
            Frame { rows: out_rows, cursor: if show_cursor { Some((cur.column.0, cursor_line as usize)) } else { None }, exited: self.session.exit.lock().clone() }
        };
        let session = self.session.clone();
        let focused = self.focus.is_focused(window);
        let font2 = font.clone();
        div()
            .id("terminal")
            .track_focus(&self.focus)
            .size_full()
            .bg(default_bg)
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| {
                window.focus(&this.focus, cx);
                cx.notify();
            }))
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _window, cx| {
                if ev.keystroke.modifiers.platform && ev.keystroke.key == "v" {
                    if let Some(item) = cx.read_from_clipboard() {
                        if let Some(text) = item.text() {
                            let _ = this.session.write(text.as_bytes());
                        }
                    }
                    cx.stop_propagation();
                    return;
                }
                if let Some(bytes) = this.key_bytes(&ev.keystroke) {
                    let _ = this.session.write(&bytes);
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
