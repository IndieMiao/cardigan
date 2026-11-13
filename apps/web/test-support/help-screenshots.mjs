import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-206: local fixture only; no business server, credentials or real data.
const output = process.argv[2];
assert(output, "Pass a screenshot output directory");
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "help-screenshot-entry",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__help")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/__help",
              `<!doctype html>
          <html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
          <body><div id="root"></div><script type="module" src="/test-support/responsive-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium();
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"]) {
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await browser.send("Page.navigate", {
        url: `${origin}__help#/p/p-1/help`,
      });
      await browser.evaluate(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 10000;
        function check() {
          if (document.querySelector('.help-markdown .status-passed')) return resolve(true);
          if (performance.now() > deadline) return reject(new Error('Help did not load'));
          setTimeout(check, 50);
        }
        check();
      })`);
      await browser.evaluate("document.fonts.ready");
      assert(
        await browser.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
        "Help page overflows horizontally",
      );
      assert(
        await browser.evaluate(
          "document.querySelectorAll('.help-directory a').length >= 2",
        ),
      );
      const save = async (suffix) => {
        const { data } = await browser.send("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          resolve(output, `${width}-${theme}-${suffix}.png`),
          Buffer.from(data, "base64"),
        );
      };
      await save("identifiers");
      await browser.evaluate(
        "document.querySelector('.status-blocked').scrollIntoView({block: 'start'})",
      );
      await save("statuses");
      if (width === 390) {
        await browser.evaluate(
          "scrollTo(0, 0); document.querySelector('[aria-label=\"打开导航\"]').click()",
        );
        await browser.evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        assert(
          await browser.evaluate(
            "Boolean(document.querySelector('[role=dialog] a[href$=\"/help\"]'))",
          ),
        );
        await save("drawer");
        await browser.evaluate(
          "document.querySelector('[role=dialog] a[href$=\"/help\"]').click()",
        );
      }
      await browser.evaluate(
        "document.querySelector('.help-directory a[href*=\"02-navigation\"]').click()",
      );
      await browser.evaluate(
        "new Promise(resolve => setTimeout(resolve, 100))",
      );
      assert.equal(
        await browser.evaluate(
          "document.querySelector('.help-article').getAttribute('aria-label')",
        ),
        "查找工作和记录",
      );
    }
  }
  assert.deepEqual(browser.errors, [], "Browser runtime errors");
  console.log(
    "Help screenshots: 1440/390, light/dark, directory and drawer passed.",
  );
} finally {
  await browser?.close();
  await server.close();
}
