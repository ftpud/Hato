use std::{ops::Range, rc::Rc};

use gpui::{
    Action, AnyElement, App, AppContext, Context, DismissEvent, Empty, Entity, EventEmitter,
    HighlightStyle, InteractiveElement as _, IntoElement, ParentElement, Pixels, Render,
    RenderOnce, SharedString, Styled, StyledText, Subscription, WeakEntity, Window, deferred, div,
    prelude::FluentBuilder, px, rems,
};
use gpui_base::TestSupportExt as _;
use gpui_base::input::CompletionHighlighter;
use lsp_types::CompletionItem;

const POPOVER_GAP: Pixels = px(4.);

/// Hato patch: per-item presentation supplied by the embedder in `item.data.presentation`:
/// `{icon: {text, color, background}, bold, mutedFrom}`. Colors are `#rrggbb[aa]`; `mutedFrom`
/// is the UTF-8 offset in `label` where the muted part (e.g. parameters) starts, and `bold`
/// applies to the label before it.
struct Presentation {
    icon: Option<(SharedString, Option<gpui::Hsla>, Option<gpui::Hsla>)>,
    bold: bool,
    muted_from: Option<usize>,
}
/// Label runs: name (optionally bold) and muted tail, split at query matches as ordered,
/// non-overlapping highlight ranges.
fn label_runs(
    label: &str,
    bold: bool,
    muted_from: Option<usize>,
    muted: gpui::Hsla,
    matches: &[Range<usize>],
) -> Vec<(Range<usize>, HighlightStyle)> {
    let split = muted_from.filter(|m| *m < label.len() && label.is_char_boundary(*m)).unwrap_or(label.len());
    let mut cuts = vec![0, split, label.len()];
    for m in matches {
        cuts.push(m.start);
        cuts.push(m.end);
    }
    cuts.sort_unstable();
    cuts.dedup();
    cuts.windows(2)
        .filter(|w| w[0] < w[1])
        .map(|w| {
            let range = w[0]..w[1];
            let style = HighlightStyle {
                color: (range.start >= split).then_some(muted),
                font_weight: (bold && range.start < split).then_some(gpui::FontWeight::BOLD),
                ..Default::default()
            };
            (range, style)
        })
        .collect()
}
fn presentation(item: &CompletionItem) -> Presentation {
    let p = item.data.as_ref().and_then(|d| d.get("presentation"));
    let color = |v: Option<&serde_json::Value>| {
        v.and_then(|v| v.as_str()).and_then(|s| gpui::Rgba::try_from(s).ok()).map(gpui::Hsla::from)
    };
    Presentation {
        icon: p.and_then(|p| p.get("icon")).and_then(|icon| {
            let text = icon.get("text")?.as_str()?.chars().take(2).collect::<String>();
            Some((text.into(), color(icon.get("color")), color(icon.get("background"))))
        }),
        bold: p.and_then(|p| p.get("bold")).and_then(|b| b.as_bool()).unwrap_or(false),
        muted_from: p.and_then(|p| p.get("mutedFrom")).and_then(|m| m.as_u64()).map(|m| m as usize),
    }
}

/// Drop ranges a custom highlighter cannot safely paint, then order the rest.
///
/// A range past the label, or one that begins or ends inside a character,
/// would split a glyph. Empty ranges paint nothing, so they go too. What
/// remains is sorted and merged: GPUI builds text runs assuming highlights
/// are ordered and do not overlap, and an overlap makes the run longer than
/// the label.
fn retained_highlight_ranges(
    label: &str,
    ranges: impl IntoIterator<Item = Range<usize>>,
) -> Vec<Range<usize>> {
    let mut ranges: Vec<Range<usize>> = ranges
        .into_iter()
        .filter(|range| {
            range.start < range.end
                && range.end <= label.len()
                && label.is_char_boundary(range.start)
                && label.is_char_boundary(range.end)
        })
        .collect();
    ranges.sort_by_key(|range| range.start);

    let mut merged: Vec<Range<usize>> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut() {
            if range.start <= last.end {
                last.end = last.end.max(range.end);
                continue;
            }
        }
        merged.push(range);
    }
    merged
}

use crate::{
    ActiveTheme, IndexPath, Selectable, ThemeStyled as _, actions, h_flex,
    input::{
        self, EditorState,
        popovers::{CaretAnchoredPopup, editor_popover, render_markdown},
    },
    label::Label,
    list::{List, ListDelegate, ListEvent, ListState},
    menu::MenuItemElement,
};

struct ContextMenuDelegate {
    query: SharedString,
    menu: Entity<CompletionMenu>,
    items: Vec<Rc<CompletionItem>>,
    selected_ix: usize,
    highlight: Rc<CompletionHighlighter>,
}

impl ContextMenuDelegate {
    fn set_items(&mut self, items: Vec<CompletionItem>) {
        self.items = items.into_iter().map(Rc::new).collect();
        self.selected_ix = 0;
    }

    fn selected_item(&self) -> Option<&Rc<CompletionItem>> {
        self.items.get(self.selected_ix)
    }
}

#[derive(IntoElement)]
struct CompletionMenuItem {
    ix: usize,
    item: Rc<CompletionItem>,
    children: Vec<AnyElement>,
    selected: bool,
    query: SharedString,
    highlight: Rc<CompletionHighlighter>,
}

impl CompletionMenuItem {
    fn new(
        ix: usize,
        item: Rc<CompletionItem>,
        query: SharedString,
        highlight: Rc<CompletionHighlighter>,
    ) -> Self {
        Self {
            ix,
            item,
            children: vec![],
            selected: false,
            query,
            highlight,
        }
    }
}
impl Selectable for CompletionMenuItem {
    fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.selected
    }
}

impl ParentElement for CompletionMenuItem {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}
impl RenderOnce for CompletionMenuItem {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let item = self.item;

        let deprecated = item.deprecated.unwrap_or(false);
        let look = presentation(&item);
        let muted = cx.theme().muted_foreground;
        // Keep label colors and weight without underlining query matches.
        let matches = retained_highlight_ranges(
            &item.label,
            (self.highlight)(self.query.as_ref(), item.as_ref()),
        );
        let highlights = label_runs(&item.label, look.bold, look.muted_from, muted, &matches);
        let params = item.label_details.as_ref().and_then(|d| d.detail.clone());
        let right = item
            .label_details
            .as_ref()
            .and_then(|d| d.description.clone())
            .or_else(|| item.detail.clone());
        let icon = look.icon.map(|(text, color, background)| {
            let color = color.unwrap_or(muted);
            div()
                .flex_none()
                .size(px(16.))
                .rounded_full()
                .border_1()
                .border_color(color)
                .when_some(background, |this, bg| this.bg(bg))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(10.))
                .line_height(px(10.))
                .font_weight(gpui::FontWeight::BOLD)
                .text_color(color)
                .child(text)
        });

        MenuItemElement::new(self.ix)
            .aria_label(item.label.clone())
            .selected(self.selected)
            .text_sm()
            .font_family(cx.theme().mono_font_family.clone())
            .py_0()
            .px_1p5()
            // Overlay scrollbars paint inside the list viewport; reserve a lane.
            .pr_5()
            .h(rems(24. / 16.))
            .rounded(cx.theme().radius)
            .when(deprecated, |this| this.line_through())
            .child(
                h_flex()
                    .w_full()
                    .gap_4()
                    .justify_between()
                    .child(
                        h_flex()
                            .min_w_0()
                            .gap_1p5()
                            .children(icon)
                            .child(
                                h_flex()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_color(cx.theme().foreground)
                                    .child(
                                        div()
                                            .flex_none()
                                            .when(look.bold && look.muted_from.is_none(), |this| this.font_weight(gpui::FontWeight::BOLD))
                                            .child(StyledText::new(item.label.clone()).with_highlights(highlights)),
                                    )
                                    .when_some(params, |this, params| {
                                        this.child(div().text_color(muted).child(params))
                                    }),
                            ),
                    )
                    .when_some(right, |this, detail| {
                        this.child(
                            Label::new(detail)
                                .flex_none()
                                .text_color(muted)
                                .when(deprecated, |this| this.line_through()),
                        )
                    }),
            )
            .children(self.children)
    }
}

impl EventEmitter<DismissEvent> for ContextMenuDelegate {}

impl ListDelegate for ContextMenuDelegate {
    type Item = CompletionMenuItem;

    fn items_count(&self, _: usize, _: &gpui::App) -> usize {
        self.items.len()
    }

    fn render_item(
        &mut self,
        ix: crate::IndexPath,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Option<Self::Item> {
        let item = self.items.get(ix.row)?;
        Some(CompletionMenuItem::new(
            ix.row,
            item.clone(),
            self.query.clone(),
            self.highlight.clone(),
        ))
    }

    fn set_selected_index(
        &mut self,
        ix: Option<crate::IndexPath>,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) {
        self.selected_ix = ix.map(|i| i.row).unwrap_or(0);
        cx.notify();
    }

    fn confirm(&mut self, _: bool, window: &mut Window, cx: &mut Context<ListState<Self>>) {
        let Some(item) = self.selected_item() else {
            return;
        };

        self.menu.update(cx, |this, cx| {
            this.select_item(&item, window, cx);
        });
    }
}

/// A context menu for code completions and code actions.
pub struct CompletionMenu {
    offset: usize,
    editor: WeakEntity<EditorState>,
    list: Entity<ListState<ContextMenuDelegate>>,
    open: bool,

    /// The offset of the first character that triggered the completion.
    pub(crate) trigger_start_offset: Option<usize>,
    query: SharedString,
    _subscriptions: Vec<Subscription>,
}

impl CompletionMenu {
    /// Creates a new `CompletionMenu` with the given offset and completion items.
    ///
    /// NOTE: This element should not call from EditorState::new, unless that will stack overflow.
    pub(crate) fn new(
        editor: Entity<EditorState>,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<Self> {
        cx.new(|cx| {
            let view = cx.entity();
            let menu = ContextMenuDelegate {
                query: SharedString::default(),
                menu: view,
                items: vec![],
                selected_ix: 0,
                highlight: Rc::new(gpui_base::input::highlight_prefix),
            };

            let list = cx.new(|cx| ListState::new(menu, window, cx));

            let _subscriptions =
                vec![
                    cx.subscribe(&list, |this: &mut Self, _, ev: &ListEvent, cx| {
                        match ev {
                            ListEvent::Confirm(_) => {
                                this.dismiss(cx);
                            }
                            _ => {}
                        }
                        cx.notify();
                    }),
                ];

            Self {
                offset: 0,
                editor: editor.downgrade(),
                list,
                open: false,
                trigger_start_offset: None,
                query: SharedString::default(),
                _subscriptions,
            }
        })
    }

    fn select_item(&mut self, item: &CompletionItem, window: &mut Window, cx: &mut Context<Self>) {
        let item = item.clone();
        let range = self.trigger_start_offset.unwrap_or(self.offset)..self.offset;

        let editor = self.editor.clone();

        cx.spawn_in(window, async move |_, cx| {
            editor.update_in(cx, |editor, window, cx| {
                editor.insert_completion(&item, range, window, cx);
            })
        })
        .detach();

        self.dismiss(cx);
    }

    pub(crate) fn handle_action(
        &mut self,
        action: Box<dyn Action>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.open {
            return false;
        }

        cx.propagate();
        if input::Enter::is_primary(&*action) {
            self.on_action_enter(window, cx);
        } else if action.partial_eq(&input::Escape) {
            self.on_action_escape(window, cx);
        } else if action.partial_eq(&input::MoveUp) {
            self.on_action_up(window, cx);
        } else if action.partial_eq(&input::MoveDown) {
            self.on_action_down(window, cx);
        } else {
            return false;
        }

        true
    }

    fn on_action_enter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.list.read(cx).delegate().selected_item().cloned() else {
            return;
        };
        self.select_item(&item, window, cx);
    }

    fn on_action_escape(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.dismiss(cx);
    }

    fn on_action_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.list.update(cx, |this, cx| {
            this.on_action_select_prev(&actions::SelectUp, window, cx)
        });
    }

    fn on_action_down(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.list.update(cx, |this, cx| {
            this.on_action_select_next(&actions::SelectDown, window, cx)
        });
    }

    /// Synchronize a hidden editor menu without dismissing a newer response.
    pub(crate) fn hide(&mut self, cx: &mut Context<Self>) {
        self.open = false;
        self.trigger_start_offset = None;
        cx.notify();
    }

    /// Dismiss the menu in response to a user action.
    fn dismiss(&mut self, cx: &mut Context<Self>) {
        self.hide(cx);
        let editor = self.editor.clone();
        cx.spawn(async move |_, cx| {
            let _ = editor.update(cx, |editor, cx| editor.dismiss_completion_overlay(cx));
        })
        .detach();
    }

    /// Sets the trigger start offset if it is not already set.
    pub(crate) fn update_query(&mut self, start_offset: usize, query: impl Into<SharedString>) {
        if self.trigger_start_offset.is_none() {
            self.trigger_start_offset = Some(start_offset);
        }
        self.query = query.into();
    }

    pub(crate) fn show(
        &mut self,
        offset: usize,
        items: impl Into<Vec<CompletionItem>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let items = items.into();
        self.offset = offset;
        self.open = true;
        self.list.update(cx, |this, cx| {
            let longest_ix = items
                .iter()
                .enumerate()
                .max_by_key(|(_, item)| {
                    item.label.len() + item.detail.as_ref().map(|d| d.len()).unwrap_or(0)
                })
                .map(|(ix, _)| ix)
                .unwrap_or(0);

            this.delegate_mut().query = self.query.clone();
            this.delegate_mut().set_items(items);
            this.set_selected_index(Some(IndexPath::new(0)), window, cx);
            this.set_item_to_measure_index(IndexPath::new(longest_ix), window, cx);
        });

        cx.notify();
    }

    /// Replace the label highlighter and repaint an open menu.
    pub(crate) fn set_highlight(
        &mut self,
        highlight: Rc<CompletionHighlighter>,
        cx: &mut Context<Self>,
    ) {
        self.list.update(cx, |list, cx| {
            if Rc::ptr_eq(&list.delegate().highlight, &highlight) {
                return;
            }
            list.delegate_mut().highlight = highlight;
            cx.notify();
        });
    }
}

impl Render for CompletionMenu {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            return Empty.into_any_element();
        }

        if self.list.read(cx).delegate().items.is_empty() {
            self.open = false;
            return Empty.into_any_element();
        }

        let Some(editor) = self.editor.upgrade() else {
            return Empty.into_any_element();
        };
        // The anchor is resolved in the popup's deferred prepaint from the
        // input's current-frame geometry; the content below is built there.
        let options = editor.read(cx).lsp().completion_menu;
        let configured_max = options.max_width;
        let list = self.list.clone();
        let menu = cx.weak_entity();

        deferred(CaretAnchoredPopup::new(
            self.editor.clone(),
            move |anchor, window, cx| {
                // `anchor` is in window coordinates, from the current frame.
                let max_width = configured_max.min(window.bounds().size.width - anchor.x);
                let vertical_layout =
                    anchor.x + configured_max + POPOVER_GAP + configured_max + POPOVER_GAP
                        > window.bounds().size.width;

                let selected_documentation = list
                    .read(cx)
                    .delegate()
                    .selected_item()
                    .and_then(|item| item.documentation.clone());

                div()
                    .flex()
                    .flex_row()
                    .gap(POPOVER_GAP)
                    .items_start()
                    .when(vertical_layout, |this| this.flex_col())
                    .child(
                        editor_popover("completion-menu", cx)
                            .popover_style(cx)
                            .text_sm()
                            // Each virtual row includes the menu's inter-item gap.
                            .pb_0p5()
                            .test_support()
                            .max_w(max_width)
                            .min_w(options.min_width.min(max_width))
                            .child(List::new(&list).max_h(options.max_height)),
                    )
                    .when_some(selected_documentation, |this, documentation| {
                        let mut doc = match documentation {
                            lsp_types::Documentation::String(s) => s.clone(),
                            lsp_types::Documentation::MarkupContent(mc) => mc.value.clone(),
                        };
                        if vertical_layout {
                            doc = doc.split("\n").next().unwrap_or_default().to_string();
                        }

                        this.child(
                            div().child(
                                editor_popover("completion-menu", cx)
                                    .popover_style(cx)
                                    .text_sm()
                                    .w(configured_max)
                                    .px_2()
                                    .child(render_markdown("doc", doc, window, cx)),
                            ),
                        )
                    })
                    .on_mouse_down_out({
                        let menu = menu.clone();
                        move |_, _, cx: &mut App| {
                            if let Some(menu) = menu.upgrade() {
                                menu.update(cx, |menu, cx| menu.dismiss(cx));
                            }
                        }
                    })
                    .into_any_element()
            },
        ))
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_runs_split_name_params_and_matches() {
        let muted = gpui::Hsla::default();
        let runs = label_runs("get(int a)", true, Some(3), muted, &[0..2]);
        let ranges: Vec<_> = runs.iter().map(|(r, _)| r.clone()).collect();
        assert_eq!(ranges, vec![0..2, 2..3, 3..10]);
        assert!(runs.iter().all(|(_, style)| style.underline.is_none()));
        assert!(runs[0].1.font_weight.is_some());
        assert!(runs[1].1.underline.is_none() && runs[1].1.color.is_none());
        assert_eq!(runs[2].1.color, Some(muted));
        assert!(runs[2].1.font_weight.is_none());
    }

    #[test]
    fn highlight_ranges_are_ordered_and_do_not_overlap() {
        assert_eq!(
            retained_highlight_ranges("flag", [2..3, 0..1]),
            vec![0..1, 2..3]
        );
        assert_eq!(retained_highlight_ranges("flag", [0..3, 2..4]), vec![0..4]);
        assert_eq!(
            retained_highlight_ranges("flag", [0..1, 1..2, 5..9, 2..3]),
            vec![0..3]
        );
        assert_eq!(retained_highlight_ranges("你", [0..1, 0..3]), vec![0..3]);
    }

    #[gpui::test]
    fn hiding_an_old_menu_does_not_dismiss_a_new_completion_response(
        cx: &mut gpui::TestAppContext,
    ) {
        cx.update(crate::init);
        let window = cx.add_empty_window();
        let (editor, menu) = window.update(|window, cx| {
            let editor = cx.new(|cx| EditorState::new(window, cx).default_value("co"));
            let menu = CompletionMenu::new(editor.clone(), window, cx);
            let old_items = vec![CompletionItem {
                label: "const".into(),
                ..Default::default()
            }];
            editor.update(cx, |editor, cx| {
                editor.present_completion_items(0, "c", old_items.clone(), cx);
            });
            menu.update(cx, |menu, cx| {
                menu.update_query(0, "c");
                menu.show(1, old_items, window, cx);
                // The overlay observes the old request being hidden while a
                // replacement request is pending. Its deferred dismissal must
                // not act on the replacement response that arrives next.
                menu.hide(cx);
            });
            editor.update(cx, |editor, cx| {
                editor.present_completion_items(
                    0,
                    "co",
                    vec![CompletionItem {
                        label: "const".into(),
                        ..Default::default()
                    }],
                    cx,
                );
            });
            (editor, menu)
        });

        cx.run_until_parked();

        cx.read(|cx| {
            let completion = editor.read(cx).completion_menu_state();
            assert!(completion.open, "an old menu dismissed the new response");
            assert_eq!(completion.query, "co");
            assert_eq!(completion.items.len(), 1);
            assert_eq!(completion.items[0].label, "const");
        });
        drop(menu);
    }
}
