// C-691 evidence: every tip kind opened by its real trigger, screenshotted and
// measured (background, text, border, radius, shadow). Same browser, fonts and
// raster flags as the page skeleton baseline; synthetic fixtures only.
//
// CHROMIUM_PATH=<chrome-headless-shell 157.0.8103.15> \
// FONTCONFIG_FILE=apps/web/test-support/page-skeleton-fonts.conf \
//   node apps/web/test-support/c691-capture.mjs <output-dir>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "build/c691");
const widths = process.argv.includes("--narrow") ? [1440, 390] : [1440];
const page = (name, entry) => ({
  name: "c691-fixture",
  enforce: "pre",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith("/__c691/thumb.svg")) {
        res.setHeader("Content-Type", "image/svg+xml");
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#8aa"/><circle cx="50" cy="50" r="28" fill="#dd8"/></svg>',
        );
        return;
      }
      if (!req.url?.startsWith(name)) return next();
      res.setHeader("Content-Type", "text/html");
      res.end(
        await server.transformIndexHtml(
          name,
          `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/${entry}"></script></body></html>`,
        ),
      );
    });
  },
});
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    page("/__skeleton", "page-skeleton-fixture.tsx"),
    page("/__c691", "c691-fixture.tsx"),
  ],
});

// Each tip: where it lives, how it opens and which element is the tip.
const tips = [
  {
    name: "board-title",
    route: "board",
    trigger: ".board-card .card-tile-link",
    open: "hover",
    tip: "[data-ui=tooltip]",
  },
  {
    name: "avatar",
    route: "board",
    trigger: ".board-card .employee-trigger",
    open: "hover",
    tip: "[data-ui=popover]",
  },
  {
    name: "status",
    route: "board",
    trigger: ".board-card .ui-status-tip",
    open: "hover",
    tip: "[data-ui=tooltip]",
  },
  {
    name: "template",
    route: "board",
    trigger: ".board-card .template-marker",
    open: "hover",
    tip: ".template-marker-tip",
  },
  {
    name: "capacity",
    route: "board",
    trigger: ".capacity-status",
    open: "focus",
    tip: ".capacity-tooltip",
  },
  {
    name: "id",
    route: "gallery",
    trigger:
      "[data-c691=id] [data-ui=id-badge], [data-c691=id] a, [data-c691=id] span[tabindex]",
    open: "hover",
    tip: "[data-ui=tooltip]",
  },
  {
    name: "settings-help",
    route: "gallery",
    trigger: "[data-c691=help] button",
    open: "hover",
    tip: "[data-ui=tooltip]",
  },
  {
    name: "card-peek",
    route: "gallery",
    trigger: "[data-c691=peek] button",
    open: "click",
    tip: "[data-ui=popover]",
  },
  {
    name: "attachment-peek",
    route: "gallery",
    trigger: "a.ui-attachment-ref",
    open: "hover",
    tip: ".ui-attachment-ref-peek",
  },
];

const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const results = [];
let browser;
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
  const version = (await send("Browser.getVersion")).product;
  assert.equal(version, "HeadlessChrome/157.0.8103.15", "Wrong browser");
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression, ms = 10000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const frames = () =>
    run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r(true))),
        ),
    );
  const mouse = (x, y, type = "mouseMoved") =>
    send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      clickCount: type === "mouseMoved" ? 0 : 1,
      pointerType: "mouse",
    });
  for (const width of widths)
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
      for (const tip of tips) {
        await send("Page.navigate", { url: "about:blank" });
        await until("location.href === 'about:blank'");
        await send("Page.navigate", {
          url:
            tip.route === "board"
              ? `${server.resolvedUrls.local[0]}__skeleton#/p/p-1/cards?view=board`
              : `${server.resolvedUrls.local[0]}__c691`,
        });
        await until(
          tip.route === "board"
            ? "!!document.querySelector('.capacity-wide') && !!document.querySelector('.board-card')"
            : "!!document.querySelector('[data-c691-gallery]')",
        );
        await evaluate("document.fonts.ready.then(() => true)");
        await frames();
        const box = await run((selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          element.scrollIntoView({ block: "center", inline: "center" });
          const r = element.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, tip.trigger);
        assert(box, `${tip.name}: trigger ${tip.trigger} missing`);
        await mouse(1, 1);
        if (tip.open === "focus")
          await run(
            (selector) => document.querySelector(selector).focus(),
            tip.trigger,
          );
        else await mouse(box.x, box.y);
        if (tip.open === "click") {
          await mouse(box.x, box.y, "mousePressed");
          await mouse(box.x, box.y, "mouseReleased");
        }
        await until(
          `(() => { const e = document.querySelector(${JSON.stringify(tip.tip)}); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; })()`,
        );
        // Let open animations settle (reduced motion, two frames, then a beat).
        await delay(250);
        await frames();
        const measured = await run(
          (tipSelector, triggerSelector) => {
            const e = document.querySelector(tipSelector);
            const s = getComputedStyle(e);
            const r = e.getBoundingClientRect();
            const t = document
              .querySelector(triggerSelector)
              .getBoundingClientRect();
            const arrow = e.querySelector("svg.tooltip-arrow, .tooltip-arrow");
            return {
              box: {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
              },
              trigger: { x: t.x, y: t.y, width: t.width, height: t.height },
              background: s.backgroundColor,
              color: s.color,
              border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
              radius: s.borderTopLeftRadius,
              shadow: s.boxShadow,
              padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
              font: `${s.fontSize}/${s.lineHeight}`,
              arrow: arrow
                ? getComputedStyle(arrow).fill || getComputedStyle(arrow).color
                : null,
              text: e.textContent.trim().slice(0, 80),
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
            };
          },
          tip.tip,
          tip.trigger,
        );
        const pad = 24;
        const left = Math.max(
          0,
          Math.min(measured.box.x, measured.trigger.x) - pad,
        );
        const top = Math.max(
          0,
          Math.min(measured.box.y, measured.trigger.y) - pad,
        );
        const right = Math.min(
          width,
          Math.max(
            measured.box.x + measured.box.width,
            measured.trigger.x + measured.trigger.width,
          ) + pad,
        );
        const bottom = Math.min(
          1000,
          Math.max(
            measured.box.y + measured.box.height,
            measured.trigger.y + measured.trigger.height,
          ) + pad,
        );
        const file = `${tip.name}-${width}-${theme}.png`;
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
          clip: {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
            scale: 1,
          },
        });
        await writeFile(resolve(output, file), Buffer.from(data, "base64"));
        results.push({ file, tip: tip.name, width, theme, ...measured });
        console.log(`Captured ${file}`);
      }
    }
  const dirty = git("status", "--porcelain", "--", "src").length > 0;
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(
      {
        commit: git("rev-parse", "HEAD"),
        tree: git("rev-parse", "HEAD^{tree}"),
        src_dirty: dirty,
        browser: version,
        dpr: 1,
        viewport_height: 1000,
        fonts: "Inter Variable, Noto Sans SC Variable, JetBrains Mono Variable",
        data: "page-skeleton-fixture (7 synthetic cards, 1 synthetic employee) + c691-fixture gallery; no backend, no production data",
        results,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
