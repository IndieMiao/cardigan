import { createServer } from "../../../apps/web/node_modules/vite/dist/node/index.js";
import react from "../../../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../../apps/web/package.json", import.meta.url),
);
const server = await createServer({
  configFile: false,
  root: process.cwd(),
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
  optimizeDeps: { entries: ["docs/design/c411/index.html"] },
  server: { host: "127.0.0.1", port: 5411, strictPort: true },
});
await server.listen();
server.printUrls();
