// C-694: Button variant="emphasis" and the fixed-footer dialog on the style
// reference page (style-reference-fixture, no service data).
//
// 1440 and 390 × light/dark, same browser flags as the page-skeleton check:
// - emphasis-*: the reference page with 悬停 / 聚焦 forced (as in the visual
//   check), plus computed colours and sizes of each emphasis sample and of the
//   default / primary buttons (unchanged);
// - dialog-top-* / dialog-bottom-*: the tall dialog before and after its body
//   is scrolled to the end; the footer must keep its place in the viewport.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c694-capture.mjs <new dir>
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
      name: "c694-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__skeleton")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__skeleton",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/style-reference-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
let browser;
const report = [];
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
  const version = await send("Browser.getVersion");
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
  const open = async (hash) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__skeleton#/p/p-1/cards?view=board${hash}`,
    });
    await until("!!document.querySelector('[data-style-reference]')");
    await evaluate("document.fonts.ready.then(() => true)");
  };
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
      await open("");
      await send("DOM.enable");
      await send("CSS.enable");
      const { root: doc } = await send("DOM.getDocument", { depth: 0 });
      for (const state of ["hover", "focus-visible"]) {
        const { nodeId } = await send("DOM.querySelector", {
          nodeId: doc.nodeId,
          selector: `[data-reference-state="${state}"]`,
        });
        await send("CSS.forcePseudoState", {
          nodeId,
          forcedPseudoClasses:
            state === "hover" ? ["hover"] : ["focus", "focus-visible"],
        });
      }
      await settle();
      const buttons = await run(() => {
        const read = (e) => {
          const r = e.getBoundingClientRect(),
            s = getComputedStyle(e);
          return {
            text: e.textContent,
            variant: [...e.classList].find((c) => c.startsWith("ui-button-")),
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            font: `${s.fontSize}/${s.lineHeight}`,
            padding: `${s.paddingTop} ${s.paddingRight}`,
            radius: s.borderRadius,
            background: s.backgroundColor,
            color: s.color,
            border: `${s.borderTopWidth} ${s.borderTopColor}`,
            opacity: s.opacity,
            outline: `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor} offset ${s.outlineOffset}`,
          };
        };
        const all = [...document.querySelectorAll("[data-ui=button]")];
        return {
          emphasis: all
            .filter((e) => e.classList.contains("ui-button-emphasis"))
            .map(read),
          others: all
            .filter((e) => ["默认", "不可用"].includes(e.textContent))
            .filter((e) => !e.classList.contains("ui-button-emphasis"))
            .map(read),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.equal(buttons.emphasis.length, 4);
      assert(!buttons.overflow);
      await shot(`emphasis-${width}-${theme}.png`);

      await open("&dialog=tall");
      await until("!!document.querySelector('.ui-dialog-footer')");
      await settle();
      const geometry = () =>
        run(() => {
          const rect = (e) => {
            const r = e.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          };
          const panel = document.querySelector("[data-ui=dialog]");
          const body = panel.querySelector(".ui-dialog-body");
          const footer = panel.querySelector(".ui-dialog-footer");
          const header = panel.querySelector(".ui-dialog-header");
          const buttons = [...footer.querySelectorAll("button")];
          return {
            viewport: { width: innerWidth, height: innerHeight },
            panel: rect(panel),
            header: rect(header),
            body: {
              ...rect(body),
              scrollTop: body.scrollTop,
              scrollHeight: body.scrollHeight,
              clientHeight: body.clientHeight,
            },
            panelScrolls: panel.scrollHeight > panel.clientHeight,
            footer: {
              ...rect(footer),
              padding: getComputedStyle(footer).padding,
              borderTop: getComputedStyle(footer).borderTop,
              gap: getComputedStyle(footer).columnGap,
            },
            buttons: buttons.map((b) => ({
              text: b.textContent,
              ...rect(b),
              background: getComputedStyle(b).backgroundColor,
              color: getComputedStyle(b).color,
            })),
            pageOverflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
      const top = await geometry();
      await shot(`dialog-top-${width}-${theme}.png`);
      await run(() => {
        const body = document.querySelector(".ui-dialog-body");
        body.scrollTop = body.scrollHeight;
      });
      await settle();
      const bottom = await geometry();
      await shot(`dialog-bottom-${width}-${theme}.png`);
      assert(top.body.scrollHeight > top.body.clientHeight);
      assert(!top.panelScrolls && bottom.body.scrollTop > 0);
      assert.deepEqual(bottom.footer, top.footer);
      for (const g of [top, bottom]) {
        assert(!g.pageOverflow);
        for (const b of g.buttons) assert(b.y + b.height <= g.viewport.height);
      }
      report.push({ width, theme, buttons, dialog: { top, bottom } });
    }
  assert.deepEqual(browser.errors, []);
  await writeFile(
    resolve(output, "c694-measurements.json"),
    `${JSON.stringify({ browser: version.product, dpr: 1, height: 1000, cases: report }, null, 2)}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
