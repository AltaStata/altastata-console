import { createTheme } from "@mui/material/styles";

/**
 * Visual target: mycloud/altastata-ui (JavaFX desktop, "AltaStata Cloud File Explorer").
 * Light theme, narrow row spacing, blue selection, near-flat surfaces, thin dividers.
 */
export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#1976d2" },
    background: {
      default: "#f5f5f5",
      paper: "#ffffff",
    },
    divider: "rgba(0,0,0,0.12)",
  },
  typography: {
    fontFamily: [
      "-apple-system",
      "BlinkMacSystemFont",
      '"Segoe UI"',
      "Roboto",
      "Helvetica",
      "Arial",
      "sans-serif",
    ].join(","),
    fontSize: 13,
  },
  shape: { borderRadius: 4 },
  components: {
    MuiListItemButton: {
      styleOverrides: {
        root: {
          paddingTop: 4,
          paddingBottom: 4,
        },
      },
    },
  },
});
