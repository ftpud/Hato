import type { AppModule, ImageAttachment, UiNode } from "./types";

/** Default wallpaper strength; low enough that panel text stays readable. */
export const WALLPAPER_OPACITY = 0.28;

/** Wrap a panel's root node in a full-size column that paints `image` behind it. */
export function withWallpaper(node: UiNode, image: ImageAttachment, opacity = WALLPAPER_OPACITY): UiNode {
  if (!(opacity > 0)) return node;
  return { type: "column", key: "panel-wallpaper", grow: true, backgroundImage: image,
    backgroundImageStyle: { opacity: Math.min(1, opacity) }, children: [node] };
}

/** Paint `image` behind everything a panel module renders. Modal/overlay roots are left untouched. */
export function wallpapered(mod: AppModule, image: ImageAttachment, opacity = WALLPAPER_OPACITY): AppModule {
  const render = mod.render;
  if (!render) return mod;
  const wrap = (node: UiNode): UiNode =>
    node && (node.type === "row" || node.type === "column") ? withWallpaper(node, image, opacity) : node;
  mod.render = function (this: AppModule, ctx: Parameters<NonNullable<AppModule["render"]>>[0]) {
    const out = render.call(this, ctx);
    return out instanceof Promise ? out.then(wrap) : wrap(out);
  };
  return mod;
}
