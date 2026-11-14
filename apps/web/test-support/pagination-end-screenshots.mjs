import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2];
assert(output, "Pass a screenshot output directory");
await mkdir(output, { recursive: true });
const baselineRef =
  process.env.PAGINATION_BASELINE_REF ??
  "7495a4d7fe274d69f314c43b5d820852456cac00";
const baseline = new Map(
  [
    "src/views/ActivityPage.tsx",
    "src/views/DecisionHistoryPage.tsx",
    "src/styles.css",
  ].map((file) => [
    resolve(root, file),
    execFileSync("git", ["show", `${baselineRef}:apps/web/${file}`], {
      cwd: root,
      encoding: "utf8",
    }),
  ]),
);
const measurements = [];
for (const stage of ["before", "after"]) {
  const server = await createServer({
    root,
    server: { host: "localhost", port: 0 },
    plugins: [
      {
        name: "pagination-end-entry",
        enforce: "pre",
        load(id) {
          if (stage === "before") return baseline.get(id.split("?")[0]);
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (!request.url?.startsWith("/__pagination")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                "/__pagination",
                `<!doctype html>
            <html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
            <body><div id="root"></div><script type="module" src="/test-support/pagination-end-fixture.tsx"></script></body></html>`,
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
    for (const width of [1440, 390]) {
      for (const theme of ["light", "dark"]) {
        await browser.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await browser.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        for (const page of ["activity", "decision-history"]) {
          for (const state of ["last", "empty"]) {
            const name = `${stage}-${page}-${state}-${width}-${theme}`;
            const route = page === "activity" ? "activity?before=older" : page;
            await browser.send("Page.navigate", {
              url: `${server.resolvedUrls.local[0]}__pagination?${state === "empty" ? "empty" : "last"}#/p/p-1/${route}`,
            });
            const selector =
              state === "empty"
                ? ".empty"
                : page === "activity"
                  ? ".activity-list"
                  : ".decision-records";
            const deadline = Date.now() + 15000;
            while (
              !(await browser.evaluate(
                `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
              ))
            ) {
              assert(Date.now() < deadline, `${name}: content did not load`);
              await delay(50);
            }
            await browser.evaluate("document.fonts.ready.then(() => true)");
            const result = await browser.evaluate(`(() => {
              const button = (text) => [...document.querySelectorAll('button')].some(el => el.textContent.trim() === text);
              return {
                overflow: document.documentElement.scrollWidth > innerWidth,
                end: document.querySelector('.pagination-end')?.textContent.trim() ?? null,
                empty: Boolean(document.querySelector('.empty')),
                more: button('更早的事件') || button('加载更多'),
                returnToLatest: button('返回最新'),
              };
            })()`);
            assert(!result.overflow, `${name}: horizontal overflow`);
            assert.equal(result.empty, state === "empty", name);
            assert.equal(
              result.end,
              stage === "after" && state === "last"
                ? page === "activity"
                  ? "已经到底了"
                  : "已显示全部 2 条"
                : null,
              name,
            );
            if (stage === "after") assert(!result.more, name);
            if (page === "activity") assert(result.returnToLatest, name);
            measurements.push({ name, ...result });
            const { cssContentSize } = await browser.send(
              "Page.getLayoutMetrics",
            );
            const { data } = await browser.send("Page.captureScreenshot", {
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
              resolve(output, `${name}.png`),
              Buffer.from(data, "base64"),
            );
          }
        }
        console.log(`PASS ${stage} ${width} ${theme}`);
      }
    }
    assert.deepEqual(browser.errors, [], "Browser runtime errors");
  } finally {
    await browser?.close();
    await server.close();
  }
}
await writeFile(
  resolve(output, "measurements.json"),
  `${JSON.stringify({ baselineRef, measurements }, null, 2)}\n`,
);
