// C-695: card detail first screen (status row and the “下一步” panel) for the
// five states of the C-687 design, page and drawer, 1440×1000 and 390×844,
// light and dark, plus the card list page (the baseline page) at the same
// viewport and theme for side-by-side comparison. Synthetic data from
// c695-fixture.tsx only; same browser flags as the page-skeleton check.
//
// Each shot records: status row lines and font, the panel box and title font,
// every panel button (text, variant, box, in first screen or not), and
// horizontal overflow of the page and of the drawer body.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c695-capture.mjs <new dir>
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outArg = process.argv[2];
assert(outArg, "Pass a new output directory");
const output = resolve(outArg);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c695-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c695")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c695",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c695-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const cards = ["C-701", "C-702", "C-48", "C-704", "C-705"];
let browser;
const report = { shots: [] };
try {
  await mkdir(output);
  await server.listen();
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
  report.browser = (await send("Browser.getVersion")).product;
  const run = (fn, ...a) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(a)})`);
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const settle = () =>
    run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  const shot = async (name) => {
    await delay(250);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    console.log(`Captured ${name}`);
  };
  const open = async (hash, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c695#/p/p-1/${hash}`,
    });
    await until(ready);
    await evaluate("document.fonts.ready.then(() => true)");
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  const measure = () =>
    run(() => {
      const rect = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      };
      const font = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e);
        return `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`;
      };
      const article = document.querySelector("article.card-page");
      const status = article?.querySelector("[aria-label='卡片状态']");
      // Lines: distinct tops of the row's direct visual items.
      // Lines: distinct tops of the row's items (facts and the action group).
      const items = status
        ? [...status.querySelectorAll(":scope > * > *")].filter(
            (e) => e.getClientRects().length,
          )
        : [];
      const tops = items
        .map((e) => Math.round(e.getBoundingClientRect().top))
        .sort((a, b) => a - b);
      let lines = 0;
      let last = Number.NEGATIVE_INFINITY;
      for (const top of tops) {
        if (top - last >= 12) lines++;
        last = top;
      }
      const panel = article?.querySelector("section[aria-label='下一步']");
      const title = panel?.querySelector("h2");
      const line = title?.nextElementSibling;
      const buttons = panel
        ? [...panel.querySelectorAll("[data-ui=button], a[data-ui=button]")]
            .filter((e) => e.getClientRects().length)
            .map((e) => {
              const r = e.getBoundingClientRect();
              return {
                text: e.textContent.trim(),
                variant: [...e.classList].find((c) =>
                  c.startsWith("ui-button-"),
                ),
                ...rect(e),
                font: font(e),
                firstScreen: r.top >= 0 && r.bottom <= innerHeight,
              };
            })
        : [];
      const body = document.querySelector(".drawer-body");
      const tabs = article?.querySelector("[role=tablist]");
      return {
        viewport: { width: innerWidth, height: innerHeight },
        statusRow: status && {
          ...rect(status),
          font: font(status),
          lines,
          items: items.length,
          text: status.textContent,
        },
        panel: panel && {
          ...rect(panel),
          borderColor: getComputedStyle(panel).borderTopColor,
          shadow: getComputedStyle(panel).boxShadow,
          padding: getComputedStyle(panel).padding,
          title: title?.textContent,
          titleFont: font(title),
          lineFont: font(line),
        },
        buttons,
        tabs: rect(tabs),
        overflow: {
          page: document.documentElement.scrollWidth > innerWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
          drawer: body ? body.scrollWidth > body.clientWidth : null,
          drawerScrollWidth: body?.scrollWidth ?? null,
          drawerClientWidth: body?.clientWidth ?? null,
        },
      };
    });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const height = width === 390 ? 844 : 1000;
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
      await open(
        "cards?view=list",
        "!!document.querySelector('.card-table, .card-records')",
        theme,
      );
      await shot(`list-${width}-${theme}.png`);
      for (const id of cards) {
        for (const mode of ["page", "drawer"]) {
          await open(
            mode === "page" ? `cards/${id}` : `cards?view=list&card=${id}`,
            mode === "page"
              ? "!!document.querySelector('article.card-page .card-main')"
              : "!!document.querySelector('.drawer-body article.card-page .card-main')",
            theme,
          );
          const name = `${mode}-${id}-${width}-${theme}.png`;
          report.shots.push({ name, ...(await measure()) });
          await shot(name);
        }
      }
    }
} finally {
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  ).catch(() => {});
  await browser?.close();
  await server.close();
}
