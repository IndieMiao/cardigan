import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { constants, gzipSync } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * C-795: write a `.gz` sibling for every emitted JS and CSS file. The server
 * (`apps/server/src/web/static.ts`) returns it to clients that accept gzip.
 * A sibling is only written when it is actually smaller than the original.
 */
function precompressAssets(): Plugin {
  return {
    name: "cardigan:precompress-assets",
    apply: "build",
    async writeBundle(options, bundle) {
      const dir = options.dir;
      if (dir === undefined) {
        return;
      }
      const writes: Promise<void>[] = [];
      for (const output of Object.values(bundle)) {
        if (!/\.(?:m?js|css)$/.test(output.fileName)) {
          continue;
        }
        const source = output.type === "chunk" ? output.code : output.source;
        const raw = typeof source === "string" ? Buffer.from(source) : source;
        const gzip = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
        if (gzip.byteLength < raw.byteLength) {
          writes.push(writeFile(join(dir, `${output.fileName}.gz`), gzip));
        }
      }
      await Promise.all(writes);
    },
  };
}

/**
 * C-795: stable third-party code goes into its own chunks, so a deploy that
 * only touches app code keeps their file names and browsers keep them cached.
 * Lucide icons stay with the code that uses them: the set grows with the UI.
 */
const VENDOR_GROUPS = [
  {
    name: "vendor-react",
    test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
  },
  {
    name: "vendor-markdown",
    test: /[\\/]node_modules[\\/](?:markdown-it|entities|linkify-it|mdurl|uc\.micro|punycode\.js)[\\/]/,
  },
  {
    name: "vendor-ui",
    test: /[\\/]node_modules[\\/](?:@radix-ui[\\/][^\\/]+|@floating-ui[\\/][^\\/]+|react-remove-scroll(?:-bar)?|react-style-singleton|use-callback-ref|use-sidecar|aria-hidden|get-nonce|tslib|tailwind-merge|class-variance-authority|clsx)[\\/]/,
  },
];

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [react(), tailwindcss(), precompressAssets()],
  // font-src 'self' intentionally excludes data URLs, including tiny Unicode slices.
  build: {
    assetsInlineLimit: (path) => (path.endsWith(".woff2") ? false : undefined),
    rolldownOptions: {
      output: { codeSplitting: { groups: VENDOR_GROUPS } },
    },
  },
});
