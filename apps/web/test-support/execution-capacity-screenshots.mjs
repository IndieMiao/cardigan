import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// Real execution view, deterministic fixture data, no business service or database.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.CAPACITY_SCREENSHOTS;
assert(output, "Set CAPACITY_SCREENSHOTS to an output directory");
await mkdir(output, { recursive: true });
const panel = "src/views/ExecutionCapacityPanel.tsx";
const baseline = execFileSync(
  "git",
  [
    "show",
    `${process.env.CAPACITY_BASELINE_REF ?? "origin/main"}:apps/web/${panel}`,
  ],
  { cwd: root, encoding: "utf8" },
);
for (const stage of ["before", "after"]) {
  const server = await createServer({
    root,
    server: { host: "localhost", port: 0 },
    plugins: [
      {
        name: "capacity-screenshot-entry",
        enforce: "pre",
        load(id) {
          if (stage === "before" && id === resolve(root, panel))
            return baseline;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (!request.url?.startsWith("/__capacity")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                "/__capacity",
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
    browser = await chromium();
    const { send, evaluate } = browser;
    for (const width of [1440, 390]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const theme of ["light", "dark"]) {
        await send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-color-scheme", value: theme },
            { name: "prefers-reduced-motion", value: "reduce" },
          ],
        });
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__capacity?capacity=${stage}&width=${width}&theme=${theme}#/p/p-1/execution`,
        });
        const deadline = Date.now() + 15000;
        while (
          !(await evaluate(
            'Boolean(document.querySelector(".execution-capacity input"))',
          ))
        ) {
          assert(Date.now() < deadline, "Capacity panel did not render");
          await delay(40);
        }
        await evaluate("document.fonts.ready.then(() => true)");
        assert.equal(
          await evaluate(
            'document.querySelector(".execution-capacity input").max',
          ),
          stage === "before" ? String(Number.MAX_SAFE_INTEGER) : "16",
        );
        assert.equal(
          await evaluate(
            'document.querySelector(".execution-capacity-count strong").textContent',
          ),
          "local · Agent",
        );
        const capture = async (suffix = "") => {
          assert(
            await evaluate(
              "document.documentElement.scrollWidth <= innerWidth",
            ),
            "Page overflows",
          );
          const { cssContentSize } = await send("Page.getLayoutMetrics");
          const { data } = await send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: {
              x: 0,
              y: 0,
              width,
              height: Math.ceil(cssContentSize.height),
              scale: 1,
            },
          });
          await writeFile(
            resolve(output, `capacity-${stage}-${width}-${theme}${suffix}.png`),
            Buffer.from(data, "base64"),
          );
        };
        assert.equal(
          await evaluate(
            'document.querySelector(".execution-capacity input").value',
          ),
          "6",
        );
        await capture();
        if (stage === "after") {
          await evaluate(`(() => {
            const input = document.querySelector('.execution-capacity input');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '17');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          })()`);
          assert(
            await evaluate(
              'document.querySelector(".execution-capacity").textContent.includes("并发上限不能超过 16。")',
            ),
          );
          assert(
            await evaluate(
              'document.querySelector(".execution-capacity button").disabled',
            ),
          );
          await capture("-over-limit");
        }
      }
    }
    assert.deepEqual(browser.errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}
console.log(`Execution capacity screenshots saved to ${output}`);
