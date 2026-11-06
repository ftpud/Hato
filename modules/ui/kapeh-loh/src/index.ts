import type { AppModule, UiNode } from "../../../../sdk/types";

const COFFEE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/></svg>`;

let open = false;

const mod: AppModule = {
  id: "kapeh-loh", moduleApiVersion: 1,
  activate(_ctx, previous) { open = !!previous?.open; },
  snapshot: () => ({ open }),
  render(): UiNode {
    return {
      type: "dropdown", key: "kapeh-loh-menu", text: "Kapeh", iconSvg: COFFEE_SVG, variant: "ghost", action: "toggle", open,
      menuWidth: 260, tooltip: "KAPEH NOT LOH", style: { background: "transparent", borderWidth: 0 },
      children: [
        { type: "column", key: "body", gap: 6, padding: 16, children: [
          { type: "label", key: "title", text: "KAPEH NOT LOH", size: "lg", weight: "bold" },
          { type: "button", key: "write-chat", text: "Write to AI chat", action: "writeChat", variant: "primary", small: true,
            tooltip: "Add “kapeh loh” to the AI chat input" },
          { type: "label", key: "esc", text: "esc to close", color: "muted", size: "xs" },
        ] },
      ],
    };
  },
  onEvent(ctx, event) {
    if (event.action === "toggle") { open = !!event.value; ctx.ui.invalidate(); }
    else if (event.action === "writeChat") { ctx.events.emit("kapeh-loh.chatInput", { text: "kapeh loh" }); open = false; ctx.ui.invalidate(); }
  },
};
export default mod;
