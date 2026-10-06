import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri serves the built pages from dist/; in dev it loads them from this fixed port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    // Loaded from disk by the webview, not the network: three + three-vrm in one chunk is fine.
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      input: { pet: "pet.html", panel: "panel.html", room: "room.html", indicator: "indicator.html" },
    },
  },
});
