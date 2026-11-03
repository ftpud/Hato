// Theme policy stays in the hot-swappable shell. Alpha applies to surfaces, never text.
export function animePalette(opacity: string) {
  const alpha = opacity === "airy" ? "66" : opacity === "solid" ? "d9" : "99";
  const colors = {
    background: "#11152b" + alpha, panel: "#191c38" + alpha,
    raised: "#292647b8", hover: "#68507c88", border: "#d7b6f04d",
    text: "#fff1fc", muted: "#c1b5d9", primary: "#f5a9d0",
    primaryHover: "#ffd1e7", primaryActive: "#d98dbb", primaryText: "#241b38",
    selection: "#9c7acd66", scrollbarThumb: "#b49bca80", scrollbarThumbHover: "#e0bcebb3",
    success: "#9ae4cf", warning: "#ffd398", danger: "#ff9cb7",
    surface: "#14182b33", field: "#15182db3", answer: "#27233d66", agentEdge: "#c2abeb",
  };
  return { light: colors, dark: colors };
}
export const animeTerminal = ["#17172e", "#ff9cb7", "#9ae4cf", "#ffd398", "#9fc5ff", "#e8b0ed", "#9ce1e8", "#e8dff4", "#706683", "#ffbfd1", "#baf2df", "#ffe1b5", "#bed8ff", "#f6cffa", "#c6f5f5", "#fff1fc"];
