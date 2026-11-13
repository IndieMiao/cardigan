import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-207: the real execution view with deterministic demo data, before and after.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2] ?? process.env.EXECUTION_SCREENSHOTS;
assert(output, "Pass an output directory");
await mkdir(output, { recursive: true });
const baselineRef =
  process.env.EXECUTION_BASELINE_REF ??
  "077f5ccf13787b6c117f3d7215a77c5890135ab1";
const swapped = [
  "src/views/ExecutionPage.tsx",
  "src/views/ExecutionCapacityPanel.tsx",
  "src/components/Foundation.tsx",
  "src/styles.css",
];
const baseline = new Map(
  swapped.map((file) => [
    resolve(root, file),
    execFileSync("git", ["show", `${baselineRef}:apps/web/${file}`], {
      cwd: root,
      encoding: "utf8",
    }),
  ]),
);
const measurements = {};
for (const stage of ["before", "after"]) {
  const server = await createServer({
    root,
    server: { host: "localhost", port: 0 },
    plugins: [
      {
        name: "execution-layout-entry",
        enforce: "pre",
        load(id) {
          if (stage === "before") return baseline.get(id.split("?")[0]);
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (!request.url?.startsWith("/__execution")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                "/__execution",
                `<!doctype html>
            <html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
            <body><div id="root"></div><script type="module" src="/test-support/execution-layout-fixture.tsx"></script></body></html>`,
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
    const until = async (expression) => {
      const deadline = Date.now() + 15000;
      while (!(await evaluate(expression))) {
        assert(Date.now() < deadline, `Timed out: ${expression}`);
        await delay(40);
      }
    };
    const capture = async (name, width, height, full) => {
      const { cssContentSize } = await send("Page.getLayoutMetrics");
      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: full,
        clip: {
          x: 0,
          y: 0,
          width,
          height: full ? Math.ceil(cssContentSize.height) : height,
          scale: 1,
        },
      });
      await writeFile(
        resolve(output, `${name}.png`),
        Buffer.from(data, "base64"),
      );
    };
    for (const [width, height, theme] of [
      [1440, 900, "light"],
      [1440, 900, "dark"],
      [390, 844, "light"],
      [390, 844, "dark"],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__execution?${stage}-${width}-${theme}#/p/p-1/execution`,
      });
      await until(
        "Boolean(document.querySelector('.execution-row, .execution-card') && document.querySelector('.execution-capacity input'))",
      );
      await evaluate("document.fonts.ready.then(() => true)");
      await delay(300);
      const label = `${stage}-${width}-${theme}`;
      const metrics = await evaluate(`(() => {
        const rows = [...document.querySelectorAll('.execution-row, .execution-card')];
        const list = document.querySelector('.execution-table, .execution-cards');
        const capacity = document.querySelector('.execution-capacity');
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          listTop: Math.round(list.getBoundingClientRect().top),
          capacityTop: Math.round(capacity.getBoundingClientRect().top),
          rowHeights: rows.map((row) => Math.round(row.getBoundingClientRect().height * 10) / 10),
          fullyVisible: rows.filter((row) => row.getBoundingClientRect().bottom <= innerHeight).length,
          tableShown: Boolean(document.querySelector('.execution-table')),
          cardsShown: Boolean(document.querySelector('.execution-cards')),
        };
      })()`);
      measurements[label] = metrics;
      assert(!metrics.overflow, `${label}: page overflows sideways`);
      if (stage === "after") {
        if (width === 1440) {
          assert(metrics.tableShown && !metrics.cardsShown, label);
          assert(
            metrics.rowHeights.every((h) => h <= 72),
            `${label}: a row is taller than 72px: ${metrics.rowHeights}`,
          );
          assert(
            metrics.fullyVisible >= 7,
            `${label}: only ${metrics.fullyVisible} rows fit`,
          );
        } else {
          assert(metrics.cardsShown && !metrics.tableShown, label);
        }
        assert(metrics.capacityTop > metrics.listTop, label);
      }
      await capture(`${label}`, width, height, false);
      await capture(`${label}-full`, width, height, true);
      if (stage === "after" && theme === "light") {
        // Expand capacity via the title jump, then show over-limit validation.
        await evaluate(
          "document.querySelector('.execution-capacity-jump').click()",
        );
        await until(
          "document.querySelector('.execution-capacity details').open",
        );
        await evaluate(`(() => {
          const input = document.querySelector('.execution-capacity input');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '13');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await until(
          "document.querySelector('.execution-capacity').textContent.includes('并发上限不能超过 12。')",
        );
        await delay(100);
        await capture(`${label}-capacity`, width, height, true);
        await evaluate(`(() => {
          [...document.querySelectorAll('.execution-capacity button')].find((b) => b.textContent === '取消').click();
          scrollTo(0, 0);
          document.querySelector('.execution-open').click();
        })()`);
        await until("Boolean(document.querySelector('[role=dialog]'))");
        await delay(200);
        await capture(`${label}-drawer`, width, height, false);
      }
    }
    assert.deepEqual(browser.errors, []);
  } finally {
    // A late profile write can make the cleanup fail; never hide the real error.
    await browser?.close().catch(() => {});
    await server.close();
  }
}
await writeFile(
  resolve(output, "measurements.json"),
  `${JSON.stringify(measurements, null, 2)}\n`,
);
console.log(JSON.stringify(measurements, null, 2));
console.log(`Execution layout screenshots saved to ${output}`);
