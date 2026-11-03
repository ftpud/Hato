// Reference palette only: geometry, typography, and layout remain in their owning modules.
// Bundled into workspace-layout; rebuild and hot reload it to change these colors.
export const colorScheme = {
  light: {
    background: "#f8f9ff",
    panel: "#ffffff",
    raised: "#f3f5fd",
    hover: "#edf1ff",
    border: "#dce4f3",
    text: "#26334d",
    muted: "#7788a8",
    primary: "#5965f3",
    primaryHover: "#4d59e4",
    primaryActive: "#424fd5",
    primaryText: "#ffffff",
    selection: "#eaf0ff",
    scrollbarThumb: "#c7d2e8",
    scrollbarThumbHover: "#a9b9d6",
    success: "#299875",
    warning: "#ad7b2c",
    danger: "#c25169",
    surface: "#ffffff",
    field: "#f3f5fd",
    answer: "#f7f8fe",
    agentEdge: "#b8e3d0",
  },
  // Retain the existing dark appearance and the user's light/dark preference.
  dark: {},
};
