import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // font-src 'self' intentionally excludes data URLs, including tiny Unicode slices.
  build: {
    assetsInlineLimit: (path) => (path.endsWith(".woff2") ? false : undefined),
  },
});
