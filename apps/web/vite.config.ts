import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [react(), tailwindcss()],
  // font-src 'self' intentionally excludes data URLs, including tiny Unicode slices.
  build: {
    assetsInlineLimit: (path) => (path.endsWith(".woff2") ? false : undefined),
  },
});
