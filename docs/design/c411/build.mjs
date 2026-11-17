import { build } from "../../../apps/web/node_modules/vite/dist/node/index.js";
import react from "../../../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(
  new URL("../../../apps/web/package.json", import.meta.url),
);
await build({
  configFile: false,
  root: process.cwd(),
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "react/jsx-dev-runtime": require.resolve("react/jsx-dev-runtime"),
      "react/jsx-runtime": require.resolve("react/jsx-runtime"),
      "react-dom/client": require.resolve("react-dom/client"),
      "react-dom": require.resolve("react-dom"),
      react: require.resolve("react"),
    },
  },
  build: {
    outDir: "build/c411-prototype",
    assetsInlineLimit: 0,
    rollupOptions: { input: resolve("docs/design/c411/index.html") },
  },
});
