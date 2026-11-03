use gpui_component::{ActiveTheme, Icon, Sizable};
use gpui_kit::{px, rgb, App, Styled};

pub fn icon(kind: &str, expanded: bool, cx: &App) -> Icon {
    let page = "<path d='M14 2H5v20h14V7Zm0 0v5h5'/>";
    let (paths, color) = match kind {
        "folder" if expanded => ("<path d='M3 7V4h6l2 3h10v3M2 10h21l-4 10H4Z'/>", cx.theme().muted_foreground),
        "folder" => ("<path d='M3 5h6l2 2h10v15H3Z'/>", cx.theme().muted_foreground),
        "code" => ("<path d='M14 2H5v20h14V7Zm0 0v5h5M10 11l-3 3 3 3m4-6 3 3-3 3'/>", cx.theme().primary),
        "config" => ("<path d='M14 2H5v20h14V7Zm0 0v5h5M10 11H9v3H8l1 1v3h1m4-7h1v3h1l-1 1v3h-1'/>", rgb(if cx.theme().mode.is_dark() { 0xd9b86a } else { 0xa46e23 }).into()),
        "text" => ("<path d='M14 2H5v20h14V7Zm0 0v5h5M8 12h8m-8 4h8m-8 3h5'/>", cx.theme().primary),
        "image" => ("<path d='M14 2H5v20h14V7Zm0 0v5h5M7 19l4-5 3 3 2-2 2 4'/><circle cx='9' cy='10' r='1'/>", cx.theme().success),
        "archive" => ("<path d='M14 2H5v20h14V7Zm0 0v5h5M11 3v3m0 2v3m0 2v3m-1 2h3v2h-3Z'/>", cx.theme().warning),
        "link" => ("<path d='M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2M14 11a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2'/>", cx.theme().muted_foreground),
        _ => (page, cx.theme().muted_foreground),
    };
    Icon::default().data(format!("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>{paths}</svg>").as_bytes()).with_size(px(16.0)).text_color(color)
}
