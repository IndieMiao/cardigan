import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const reference = process.argv.includes("--reference");
const output = resolve(root, "test-support/page-skeleton-snapshots");
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "page-skeleton-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__skeleton")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__skeleton",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/${reference ? "style-reference" : "page-skeleton"}-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const results = [];
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  // Use one software raster path for exact RGBA comparisons across captures.
  browser = await chromium({
    args: [
      "--run-all-compositor-stages-before-draw",
      "--disable-new-content-rendering-timeout",
      "--disable-threaded-animation",
      "--disable-threaded-scrolling",
      "--disable-partial-raster",
      "--disable-gpu",
      "--disable-skia-runtime-opts",
      "--force-color-profile=srgb",
      "--num-raster-threads=1",
    ],
  });
  const { send, evaluate } = browser;
  const browserVersion = await send("Browser.getVersion");
  assert.equal(
    browserVersion.product,
    "HeadlessChrome/157.0.8103.15",
    "Wrong visual baseline browser",
  );
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const press = async (key, code, windowsVirtualKeyCode) => {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode,
    });
  };
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      for (const mode of reference
        ? [
            "reference",
            "reference-filter",
            "reference-refresh",
            "reference-focus",
          ]
        : [
            "board",
            "list",
            "grouped",
            "minimal",
            "detail",
            "filter",
            "capacity",
          ]) {
        await send("Page.navigate", { url: "about:blank" });
        await until("location.href === 'about:blank'");
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__skeleton#/p/p-1/${mode === "detail" ? "cards/C-2" : `cards?view=${mode === "board" ? "board" : "list"}`}`,
        });
        await until(
          reference
            ? "!!document.querySelector('[data-style-reference]')"
            : mode === "detail"
              ? "!!document.querySelector('.card-main')"
              : "!!document.querySelector('.capacity-wide') && !!document.querySelector('.board-card, .card-table')",
        );
        await evaluate("document.fonts.ready.then(() => true)");
        await run((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        if (mode === "grouped" || mode === "minimal") {
          await run(() =>
            document.querySelector(".card-display-trigger").focus(),
          );
          await press("Enter", "Enter", 13);
          await until("!!document.querySelector('[role=menuitemcheckbox]')");
          if (mode === "grouped")
            await run(() =>
              [...document.querySelectorAll("[role=menuitemcheckbox]")]
                .find((e) => e.textContent.includes("分组字段"))
                .click(),
            );
          else
            await run(() =>
              [
                ...document.querySelectorAll(
                  "[role=menuitemcheckbox][aria-checked=true]",
                ),
              ]
                .filter((e) => !e.textContent.includes("分组字段"))
                .forEach((e) => {
                  e.click();
                }),
            );
          await send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
          });
          await send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
          });
          await until(
            "!document.querySelector('[role=menu]') && document.activeElement.matches('.card-display-trigger')",
          );
        }
        if (mode === "reference-focus") {
          await press("Tab", "Tab", 9);
          assert(await evaluate("document.activeElement !== document.body"));
        }
        if (
          mode === "filter" ||
          mode === "reference-filter" ||
          mode === "reference-refresh"
        ) {
          await run(
            (selector) => document.querySelector(selector).focus(),
            mode === "reference-refresh"
              ? '[aria-label="自动刷新"]'
              : mode === "reference-filter"
                ? '[aria-label^="状态："]'
                : '[aria-label^="下一步："]',
          );
          await press("Enter", "Enter", 13);
          await until("!!document.querySelector('[role=listbox]')");
        }
        if (mode === "capacity")
          await run(() => document.querySelector(".capacity-status").focus());
        await run(
          async (preserveFocus) => {
            if (!preserveFocus) document.activeElement?.blur();
            window.scrollTo(0, 0);
            await new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            );
          },
          mode === "reference-focus" ||
            mode.includes("filter") ||
            mode === "reference-refresh" ||
            mode === "capacity",
        );
        await delay(250);
        const metrics = await run(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          controls: [
            ...document.querySelectorAll(
              ".ui-filter-row button, .ui-filter-row input",
            ),
          ]
            .filter((e) => e.getClientRects().length)
            .map((e) => {
              const r = e.getBoundingClientRect(),
                s = getComputedStyle(e);
              return {
                label: e.getAttribute("aria-label") || e.textContent,
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                font: s.fontSize,
                line: s.lineHeight,
              };
            }),
        }));
        assert(!metrics.overflow, `${mode}/${width}: page overflows`);
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        const name = `${mode}-${width}-${theme}.png`;
        await writeFile(resolve(output, name), Buffer.from(data, "base64"));
        if (mode.includes("filter") || mode === "reference-refresh") {
          await press("Escape", "Escape", 27);
          await until("!document.querySelector('[role=listbox]')");
          await until(
            "document.activeElement.getAttribute('role') === 'combobox'",
          );
        }
        results.push({ name, ...metrics });
        console.log(`Captured ${name}`);
        await evaluate("localStorage.clear()");
      }
    }
  assert.deepEqual(browser.errors, []);
  await writeFile(
    resolve(
      output,
      reference ? "reference-measurements.json" : "measurements.json",
    ),
    `${JSON.stringify({ browser: browserVersion, cases: results }, null, 2)}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
