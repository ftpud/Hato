//! Trusted security preferences and confirmation. Module nodes can only refer to this surface.
use super::*;

const BANNER_LABEL: &str = "Show the auto-approve warning banner";
const BANNER_DESCRIPTION: &str = "Turning this off hides the auto-approve warning everywhere.";
const INDICATOR_LABEL: &str = "Auto-approve ON · Open Settings → Security";
const INDICATOR_HEIGHT: Pixels = px(28.);

const LABEL: &str = "Automatically approve all security requests";
const DESCRIPTION: &str =
    "Hato will grant module and agent permission requests without asking. Anyone or anything that can run code in Hato gets full access. Stays on after restarting Hato until you turn it off.";

impl Shell {
    pub(super) fn security_preferences(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let enabled = self.kernel.approvals.auto_approve_enabled();
        let warning = cx.theme().warning;
        let control = gpui_component::switch::Switch::new("trusted-security-auto-approve")
            .checked(enabled)
            .color(warning)
            .tooltip(LABEL)
            .on_change(cx.listener(|this, enabled: &bool, window, cx| {
                if *enabled {
                    let cancel = cx.focus_handle().tab_stop(true);
                    window.focus(&cancel, cx);
                    this.security_confirm = Some(cancel);
                } else {
                    this.change_auto_approve(false);
                }
                cx.notify();
            }));
        let approvals = &self.kernel.approvals;
        let row = h_flex()
            .gap_4()
            .items_center()
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_1()
                    .child(
                        h_flex()
                            .gap_2()
                            .flex_wrap()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(LABEL))
                            .child(
                                div()
                                    .px_2()
                                    .rounded(px(4.0))
                                    .text_xs()
                                    .text_color(warning)
                                    .bg(warning.opacity(0.2))
                                    .child("Not recommended"),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(DESCRIPTION),
                    ),
            )
            .child(control);
        v_flex().gap_3().p_3().rounded(px(8.0)).border_1().border_color(cx.theme().border)
            .child(row)
            .when(enabled, |card| {
                let banner = gpui_component::switch::Switch::new("trusted-security-warning-banner")
                    .checked(approvals.show_auto_approve_warning_banner())
                    .accessibility_label(BANNER_LABEL)
                    .on_change(cx.listener(|this, enabled: &bool, _, cx| {
                        if let Err(error) = this.kernel.approvals.set_auto_approve_warning_banner_from_native_ui(*enabled) {
                            log::error!("could not save automatic approvals warning banner setting: {error}");
                            this.toasts.push(motion::Toast::new("error".into(), "Hato couldn’t save the warning banner setting.".into()));
                        }
                        cx.notify();
                    }));
                card.child(h_flex().gap_4().items_center().justify_between()
                    .debug_selector(|| "trusted-security-warning-banner-setting".into())
                    .child(
                        v_flex().flex_1().min_w_0().gap_1()
                            .child(div().text_sm().child(BANNER_LABEL))
                            .child(div().text_xs().text_color(cx.theme().muted_foreground).child(BANNER_DESCRIPTION)),
                    )
                    .child(banner))
            })
            .into_any_element()
    }

    pub(super) fn auto_approve_indicator(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let approvals = &self.kernel.approvals;
        if !approvals.auto_approve_enabled() || !approvals.show_auto_approve_warning_banner() {
            return None;
        }
        let kernel = self.kernel.clone();
        let warning = cx.theme().warning;
        let background = cx.theme().background.blend(warning.opacity(0.16));
        let shield = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4l16 16M5 8v4c0 4 3 7 7 9a19 19 0 0 0 4-3M9 4l3-1 7 3v6c0 1-.2 2-.5 3"/></svg>"#;
        let button = Button::new("trusted-security-indicator")
            .small()
            .ghost()
            .text_color(warning)
            .icon(
                gpui_component::Icon::default()
                    .data(shield)
                    .text_color(warning),
            )
            .accessibility_label(INDICATOR_LABEL)
            .tooltip(INDICATOR_LABEL)
            .on_click(move |_, _, _| {
                kernel
                    .router
                    .emit("settings.open", &json!({"category": "security"}))
            });
        let top = self
            .window_chrome
            .security_banner_top(window, INDICATOR_HEIGHT);
        Some(
            h_flex()
                .absolute()
                .top(top)
                .left_0()
                .right_0()
                .h(INDICATOR_HEIGHT)
                .px_2()
                .justify_end()
                .bg(background)
                .border_b_1()
                .border_color(warning.opacity(0.4))
                .debug_selector(|| "trusted-security-banner".into())
                .child(button.label("Auto-approve ON"))
                .into_any_element(),
        )
    }

    pub(super) fn security_confirmation(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let cancel_focus = self.security_confirm.clone()?;
        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .occlude()
                .bg(black().opacity(0.5))
                .flex()
                .items_center()
                .justify_center()
                .capture_key_down(cx.listener(move |this, ev: &KeyDownEvent, window, cx| {
                    if ev.keystroke.key == "escape" {
                        this.security_confirm = None;
                        window.prevent_default();
                        cx.stop_propagation();
                        cx.notify();
                    }
                }))
                .child(
                    v_flex()
                        .w(px(520.0))
                        .max_w(relative(0.94))
                        .gap_3()
                        .p_4()
                        .rounded(px(10.0))
                        .border_2()
                        .border_color(cx.theme().warning)
                        .bg(cx.theme().background)
                        .shadow_lg()
                        .child(
                            div()
                                .text_lg()
                                .font_weight(FontWeight::BOLD)
                                .child("Enable automatic approvals?"),
                        )
                        .child(div().text_sm().child(DESCRIPTION))
                        .child(
                            h_flex()
                                .justify_end()
                                .gap_2()
                                .child(
                                    Button::new("trusted-security-cancel")
                                        .primary()
                                        .track_focus(&cancel_focus)
                                        .label("Cancel")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.security_confirm = None;
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    Button::new("trusted-security-enable")
                                        .danger()
                                        .label("Enable auto-approve")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            if this.security_confirm.take().is_some() {
                                                this.change_auto_approve(true);
                                            }
                                            cx.notify();
                                        })),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }

    fn change_auto_approve(&mut self, enabled: bool) {
        if let Err(error) = self
            .kernel
            .approvals
            .set_auto_approve_from_native_ui(enabled)
        {
            log::error!("could not save automatic approvals setting: {error}");
            let message = if enabled {
                "Hato couldn’t save the setting. Automatic approvals are off."
            } else {
                "Automatic approvals are off now. Hato couldn’t save the change, so they may come back on after restart."
            };
            self.toasts
                .push(super::motion::Toast::new("error".into(), message.into()));
        }
    }
}
