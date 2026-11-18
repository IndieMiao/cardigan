import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-458: activity and snapshot pages beside the cards-page list baseline.
// Usage: node observe-pages-screenshots.mjs <output> <before|after>
const output = resolve(process.argv[2] ?? "build/observe-pages");
const stage = process.argv[3] ?? "after";
const scenes = {
  activity: "#/p/p-1/activity",
  "activity-open": "#/p/p-1/activity",
  "activity-filtered": "#/p/p-1/activity?actor=system",
  snapshot: "#/p/p-1/snapshot",
  "snapshot-empty": "#/p/p-1/snapshot",
  cards: "#/p/p-1/cards?view=list",
};
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  cacheDir: resolve(output, ".vite-cache"),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "observe-pages-fixture",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__observe_pages")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__observe_pages",
              '<!doctype html><html lang="zh-CN"><head><title>观察页合成验证</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/observe-pages-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
const records = [];
try {
  await mkdir(output, { recursive: true });
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
  const version = await send("Browser.getVersion");
  const until = async (expression) => {
    const deadline = Date.now() + 15000;
    while (!(await evaluate(expression).catch(() => false))) {
      assert(Date.now() < deadline, expression);
      await delay(50);
    }
  };
  const capture = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const path = resolve(output, `${stage}-${name}.png`);
    await writeFile(path, Buffer.from(data, "base64"));
    return path;
  };
  await send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: width === 390,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      for (const [scene, hash] of Object.entries(scenes)) {
        await send("Page.navigate", { url: "about:blank" });
        await until("document.URL === 'about:blank'");
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__observe_pages${scene.endsWith("empty") ? "?empty" : ""}${hash}`,
        });
        await until("!!document.querySelector('main h1')");
        await evaluate("localStorage.clear()");
        await send("Page.reload");
        await until("!!document.querySelector('main h1')");
        await until(
          scene.startsWith("cards")
            ? "!!document.querySelector('.card-table tbody tr')"
            : scene.startsWith("activity")
              ? "!!document.querySelector('main time, main .empty')"
              : "!!document.querySelector('main table, main .empty')",
        );
        if (scene === "activity-open") {
          await evaluate(`(() => {
            const details = document.querySelector('main details');
            if (details) { details.open = true; return; }
            [...document.querySelectorAll('main tbody button[aria-controls]')].find(b => b.textContent.trim() === '详情').click();
          })()`);
          await until(
            "[...document.querySelectorAll('main pre')].some(e => e.getClientRects().length)",
          );
        }
        await evaluate("document.fonts.ready.then(() => true)");
        await delay(300);
        const metrics = await evaluate(`(() => {
          const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x*100)/100, y: Math.round(r.y*100)/100, right: Math.round(r.right*100)/100, width: Math.round(r.width*100)/100, height: Math.round(r.height*100)/100 }; };
          const font = e => { if (!e) return null; const s = getComputedStyle(e); return { size: s.fontSize, lineHeight: s.lineHeight, weight: s.fontWeight, padding: s.padding, color: s.color }; };
          const main = document.querySelector('main');
          const workspace = main.querySelector('section');
          const visible = s => [...main.querySelectorAll(s)].filter(e => e.getClientRects().length);
          return {
            innerWidth, scrollWidth: document.documentElement.scrollWidth,
            overflow: document.documentElement.scrollWidth > innerWidth,
            workspace: box(workspace), workspaceClass: workspace?.className,
            title: { box: box(main.querySelector('h1')), font: font(main.querySelector('h1')) },
            count: main.querySelector('.ui-page-count')?.textContent ?? null,
            header: box(main.querySelector('header')),
            summary: visible('nav[aria-label="项目概览"] a').map(e => ({ text: e.textContent.trim(), box: box(e), font: font(e) })),
            toolbar: box(main.querySelector('.ui-filter-row, .filter-controls')),
            actions: box(main.querySelector('.ui-filter-row > .ui-action-row')),
            controls: visible('.ui-filter-row button, .ui-filter-row input, .filter-controls button, .filter-controls input').map(e => ({ name: (e.getAttribute('aria-label') || e.textContent || e.placeholder).trim(), height: e.getBoundingClientRect().height, width: e.getBoundingClientRect().width })),
            // Each table's own scroll region, not just the document (C-458 review).
            tableOverflow: visible('.card-table-scroll').map(e => e.scrollWidth - e.clientWidth),
            tables: visible('table').map(t => ({ box: box(t), head: font(t.querySelector('th')), headBox: box(t.querySelector('th')), cell: font(t.querySelector('tbody tr:not(:first-child) td, tbody td')), })),
            sectionHeadings: visible('h2').map(e => ({ text: e.textContent.trim(), font: font(e), box: box(e) })),
            ids: visible('[data-ui="id-badge"]').slice(0, 3).map(e => ({ text: e.textContent, height: e.getBoundingClientRect().height, decoration: getComputedStyle(e.closest('a') ?? e).textDecorationLine, border: getComputedStyle(e).borderTopWidth })),
            times: visible('time').slice(0, 4).map(e => e.textContent),
            empty: visible('.empty').map(e => e.textContent),
            body: font(document.body),
          };
        })()`);
        const shot = await capture(`${scene}-${theme}-${width}`);
        records.push({ stage, scene, theme, width, shot, metrics });
        if (scene === "activity" || scene === "snapshot") {
          assert.equal(metrics.overflow, false, `${scene} ${width} overflow`);
          // Stacked records must fit; wide desktop tables may scroll.
          if (width === 390)
            for (const extra of metrics.tableOverflow)
              assert(extra <= 0, `${scene} ${width} table overflow ${extra}`);
        }
      }
      // Same width and theme, page beside the cards-page list baseline.
      for (const scene of ["activity", "snapshot"]) {
        const left = await readFile(
          resolve(output, `${stage}-${scene}-${theme}-${width}.png`),
        );
        const right = await readFile(
          resolve(output, `${stage}-cards-${theme}-${width}.png`),
        );
        await send("Emulation.setDeviceMetricsOverride", {
          width: width * 2 + 16,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Page.navigate", { url: "about:blank" });
        await until("document.URL === 'about:blank'");
        await evaluate(`new Promise(done => {
          document.body.style.cssText = 'margin:0;display:flex;gap:16px;background:#888';
          let n = 0;
          for (const src of ['data:image/png;base64,${left.toString("base64")}', 'data:image/png;base64,${right.toString("base64")}']) {
            const img = new Image(); img.src = src; img.style.display = 'block';
            img.onload = () => { if (++n === 2) requestAnimationFrame(() => requestAnimationFrame(done)); };
            document.body.append(img);
          }
        })`);
        await capture(`${scene}-vs-cards-${theme}-${width}`);
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: width === 390,
        });
      }
    }
  await writeFile(
    resolve(output, `${stage}-metrics.json`),
    `${JSON.stringify(
      {
        browser: version.product,
        userAgent: version.userAgent,
        fonts: [
          "Inter Variable",
          "Noto Sans SC Variable",
          "JetBrains Mono Variable",
        ],
        dpr: 1,
        timezone: "UTC",
        clock: "2026-01-01T00:00:00Z",
        data: "7 synthetic cards, 11 activity events (2 days), 2 blocked items, 3 deliveries (one with a 39-character work item title)",
        errors: browser.errors.length,
        records,
      },
      null,
      2,
    )}\n`,
  );
  assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
} finally {
  await browser?.close();
  await server.close();
}
