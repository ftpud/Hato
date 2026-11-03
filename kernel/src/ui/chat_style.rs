use gpui_component::{ActiveTheme, Icon};
use gpui_kit::{rgb, App, Hsla};

pub struct Palette { pub base: Hsla, pub panel: Hsla, pub user: Hsla, pub answer: Hsla, pub border: Hsla, pub text: Hsla, pub muted: Hsla, pub accent: Hsla, pub agent: Hsla }
impl Palette {
    pub fn new(cx: &App) -> Self {
        let dark = cx.theme().mode.is_dark();
        let c = |light, dark_color| rgb(if dark { dark_color } else { light }).into();
        let token = |name, fallback| super::theme::token(cx, name, fallback);
        Self { base: token("surface", c(0xffffff, 0x171923)), panel: token("field", c(0xf4f6fc, 0x202331)), user: token("selection", c(0xedf0ff, 0x282d48)), answer: token("answer", c(0xf6f8fd, 0x202431)), border: token("border", c(0xdce3f3, 0x353c51)), text: token("text", c(0x273450, 0xe2e8f5)), muted: token("muted", c(0x596b8e, 0xa1aec9)), accent: token("primary", c(0x4654e5, 0x8793ff)), agent: token("agentEdge", c(0xb7dfcc, 0x5c9b85)) }
    }
}
pub fn icon(name: &str) -> Icon {
    let path = match name {
        "send" => "<path d='m22 2-7 20-4-9-9-4Z'/><path d='M22 2 11 13'/>",
        "paperclip" => "<path d='m21 11-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5'/>",
        "sliders-horizontal" => "<path d='M3 6h3m4 0h11M3 18h11m4 0h3'/><circle cx='8' cy='6' r='2'/><circle cx='16' cy='18' r='2'/>",
        "message-square" => "<path d='M21 15a2 2 0 0 1-2 2H7l-5 5V4a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2Z'/>",
        "graduation-cap" => "<path d='m2 8 10-5 10 5-10 5Zm4 2v7q6 5 12 0v-7M22 8v8'/>",
        "copy" => "<rect x='8' y='8' width='13' height='13' rx='2'/><path d='M16 5V3H3v13h2'/>",
        "warning" => "<path d='m12 3 10 18H2Z'/><path d='M12 9v5m0 3h.01'/>",
        "terminal" => "<rect x='3' y='4' width='18' height='16' rx='2'/><path d='m7 9 3 3-3 3m6 0h4'/>",
        "git-branch" => "<circle cx='6' cy='3' r='2'/><circle cx='6' cy='20' r='2'/><circle cx='18' cy='6' r='2'/><path d='M6 5v13M18 8c0 7-12 4-12 10'/>",
        "files" => "<path d='M14 2H6v16h14V8Z'/><path d='M14 2v6h6M3 6v16h13'/>",
        "folder" => "<path d='M3 5h6l2 2h10v13H3Z'/>",
        "refresh" => "<path d='M20 7a8 8 0 1 0 0 10M20 3v5h-5'/>",
        "collapse" => "<path d='m8 8 4-4 4 4M8 16l4 4 4-4M4 12h16'/>",
        "locate" => "<circle cx='12' cy='12' r='7'/><circle cx='12' cy='12' r='2'/><path d='M12 2v3m0 14v3M2 12h3m14 0h3'/>",
        "search" => "<circle cx='10' cy='10' r='7'/><path d='m15 15 6 6'/>",
        "x" => "<path d='m6 6 12 12M6 18 18 6'/>",
        _ => "<path d='M12 4v16M4 12h16'/>",
    };
    Icon::default().data(format!("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>{path}</svg>").as_bytes())
}

/// Keep tool summaries in one visual row even when an agent supplies multiline titles.
pub fn single_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    #[test]
    fn tool_summaries_remove_line_breaks_and_tabs() {
        assert_eq!(super::single_line("Run command\n  cargo test\r\n\t--all"), "Run command cargo test --all");
        assert_eq!(super::single_line("Inspect 日本語 files"), "Inspect 日本語 files");
    }
}

/// Filled sector for known usage; a dashed outline means the agent has not reported it.
pub fn usage_pie(value: Option<f64>, dark: bool) -> Icon {
    let value = value.filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 1.0));
    let track = if dark { "#353c51" } else { "#dce3f3" };
    let fill = match value { Some(v) if v >= 0.9 => "#d95050", Some(v) if v >= 0.75 => "#bd8120", _ if dark => "#8793ff", _ => "#4654e5" };
    let body = match value {
        None => format!("<circle cx='9' cy='9' r='7' fill='none' stroke='{track}' stroke-width='2' stroke-dasharray='2 2'/>"),
        Some(v) => {
            let sector = if v >= 1.0 { format!("<circle cx='9' cy='9' r='7' fill='{fill}'/>") }
                else if v <= 0.0 { String::new() }
                else {
                    let angle = v * std::f64::consts::TAU;
                    let (x, y) = (9.0 + 7.0 * angle.sin(), 9.0 - 7.0 * angle.cos());
                    format!("<path d='M9 9 L9 2 A7 7 0 {} 1 {x:.3} {y:.3} Z' fill='{fill}'/>", if v > 0.5 { 1 } else { 0 })
                };
            format!("<circle cx='9' cy='9' r='7' fill='{track}'/>{sector}")
        }
    };
    Icon::default().data(format!("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'>{body}</svg>").as_bytes())
}
