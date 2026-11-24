// C-660 evidence: board card waiting/blocked signals before and after the
// corner tag. Synthetic fixture only; prints where it wrote its files.
// Usage: CHROMIUM_PATH=... node test-support/c660-capture.mjs <output-dir>
//        CHROMIUM_PATH=... node test-support/c660-capture.mjs --compose \
//          <before-dir> <after-dir> <baseline-dir> <output-dir>
// <baseline-dir> holds the page-skeleton board-<width>-<theme>.png images.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const compose = process.argv[2] === "--compose";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(
  (compose ? process.argv[6] : process.argv[2]) ?? "c660-evidence",
);
const flags = [
  "--run-all-compositor-stages-before-draw",
  "--disable-new-content-rendering-timeout",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--disable-partial-raster",
  "--disable-gpu",
  "--disable-skia-runtime-opts",
  "--force-color-profile=srgb",
  "--num-raster-threads=1",
];
const widths = [1440, 390];
const themes = ["light", "dark"];
// One card per lane brings that lane into view.
const lanes = ["C-1", "C-4", "C-7", "C-8", "C-10"];

async function browserTools(browser) {
  const { send, evaluate } = browser;
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const viewport = async (width, height, theme) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
  };
  return { send, evaluate, run, until, viewport, shot };
}

if (compose) {
  // Side-by-side sheets at the same width and theme, two images per sheet.
  const [before, after, baseline] = process.argv
    .slice(3, 6)
    .map((p) => resolve(p));
  await mkdir(output, { recursive: true });
  const browser = await chromium({ args: flags });
  try {
    const { send, run, until, viewport, shot } = await browserTools(browser);
    const pairs = [];
    for (const width of widths)
      for (const theme of themes) {
        for (const lane of lanes)
          pairs.push([
            `pair-before-after-${width}-${theme}-lane-${lane}.png`,
            [
              "改前",
              resolve(before, `board-${width}-${theme}-lane-${lane}.png`),
            ],
            [
              "改后",
              resolve(after, `board-${width}-${theme}-lane-${lane}.png`),
            ],
            width,
          ]);
        pairs.push([
          `pair-baseline-after-${width}-${theme}.png`,
          ["基准卡片页", resolve(baseline, `board-${width}-${theme}.png`)],
          ["改后", resolve(after, `board-${width}-${theme}-lane-C-1.png`)],
          width,
        ]);
      }
    for (const [name, left, right, width] of pairs) {
      const images = await Promise.all(
        [left, right].map(async ([label, file]) => [
          label,
          `data:image/png;base64,${(await readFile(file)).toString("base64")}`,
        ]),
      );
      await viewport(width * 2 + 24, 1040, "light");
      await send("Page.navigate", { url: "about:blank" });
      await until("document.readyState === 'complete'");
      await run((images) => {
        document.body.style.cssText =
          "margin:0;display:flex;gap:24px;background:#888;font:14px sans-serif";
        for (const [label, src] of images) {
          const figure = document.createElement("figure");
          figure.style.cssText = "margin:0";
          const caption = document.createElement("figcaption");
          caption.textContent = label;
          caption.style.cssText = "height:40px;line-height:40px;color:#fff";
          const img = document.createElement("img");
          img.src = src;
          img.style.cssText = "display:block";
          figure.append(caption, img);
          document.body.append(figure);
        }
      }, images);
      await until("[...document.images].every((i) => i.complete)");
      await shot(name);
      console.log(`Composed ${name}`);
    }
  } finally {
    await browser.close();
  }
  process.exit(0);
}

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c660-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c660")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c660",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c660-fixture.tsx"></script></body></html>`,
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
  browser = await chromium({ args: flags });
  const { send, evaluate, run, until, viewport, shot } =
    await browserTools(browser);
  const version = await send("Browser.getVersion");
  const settle = () =>
    run(async () => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
  const open = async (width, theme) => {
    await viewport(width, 1000, theme);
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c660#/p/p-1/cards?view=board`,
    });
    await until("document.querySelectorAll('.board-card').length === 11");
    await evaluate("document.fonts.ready.then(() => true)");
    await settle();
    await delay(250);
  };
  const measure = () =>
    run(() => {
      const box = (e) => {
        const r = e.getBoundingClientRect();
        return {
          x: +r.x.toFixed(2),
          y: +r.y.toFixed(2),
          w: +r.width.toFixed(2),
          h: +r.height.toFixed(2),
        };
      };
      const overlaps = (a, b) =>
        a.left < b.right - 0.5 &&
        b.left < a.right - 0.5 &&
        a.top < b.bottom - 0.5 &&
        b.top < a.bottom - 0.5;
      const tiles = [...document.querySelectorAll(".board-card")].map((e) => {
        const style = getComputedStyle(e);
        const signal = e.querySelector("[data-card-signal]");
        const meta = e.querySelector(".board-card-meta");
        const metaItems = meta
          ? [...meta.children].filter((c) => c !== signal)
          : [];
        const signalStyle = signal && getComputedStyle(signal);
        const cardBox = e.getBoundingClientRect();
        const signalBox = signal?.getBoundingClientRect();
        return {
          id: e.querySelector(".card-id")?.textContent,
          box: box(e),
          borderLeft: `${style.borderLeftWidth} ${style.borderLeftColor}`,
          borderRight: `${style.borderRightWidth} ${style.borderRightColor}`,
          classes: e.className,
          signal: signal && {
            kind: signal.getAttribute("data-card-signal"),
            text: signal.textContent,
            label: signal.getAttribute("aria-label"),
            box: box(signal),
            font: `${signalStyle.fontSize}/${signalStyle.lineHeight}`,
            weight: signalStyle.fontWeight,
            color: signalStyle.color,
            background: signalStyle.backgroundColor,
            radius: signalStyle.borderRadius,
            insetRight: +(cardBox.right - signalBox.right).toFixed(2),
            insetBottom: +(cardBox.bottom - signalBox.bottom).toFixed(2),
            overlapsMeta: metaItems
              .filter((item) =>
                overlaps(item.getBoundingClientRect(), signalBox),
              )
              .map((item) => item.getAttribute("aria-label") ?? item.className),
          },
          meta: meta && box(meta),
          metaLines: meta
            ? new Set(
                metaItems.map((item) =>
                  Math.round(item.getBoundingClientRect().top),
                ),
              ).size
            : 0,
          metaFont: (() => {
            const badge = e.querySelector(".board-card-badge");
            if (!badge) return null;
            const s = getComputedStyle(badge);
            return `${s.fontSize}/${s.lineHeight}`;
          })(),
          badges: [...e.querySelectorAll(".board-card-badge")].map((b) =>
            b.getAttribute("aria-label"),
          ),
        };
      });
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        tiles,
      };
    });
  // The lanes scroll sideways; bring one lane into view.
  const toLane = (id) => {
    const card = [...document.querySelectorAll(".board-card")].find(
      (e) => e.querySelector(".card-id")?.textContent === id,
    );
    let scroller = card.parentElement;
    while (scroller && scroller.scrollWidth <= scroller.clientWidth)
      scroller = scroller.parentElement;
    scroller.scrollLeft +=
      card.getBoundingClientRect().left -
      scroller.getBoundingClientRect().left -
      12;
  };
  for (const width of widths)
    for (const theme of themes)
      for (const lane of lanes) {
        const name = `board-${width}-${theme}-lane-${lane}.png`;
        await open(width, theme);
        await evaluate(`(${toLane.toString()})(${JSON.stringify(lane)})`);
        await delay(100);
        const metrics = await measure();
        assert(!metrics.overflow, `${name}: page overflows`);
        await shot(name);
        results.push({ name, width, theme, ...metrics });
        console.log(`Captured ${name}`);
      }
  // Help page legend ("看懂卡片") with the annotated example card.
  for (const width of widths)
    for (const theme of themes) {
      const name = `help-${width}-${theme}.png`;
      await viewport(width, 1000, theme);
      await send("Page.navigate", { url: "about:blank" });
      await until("location.href === 'about:blank'");
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__c660#/p/p-1/help?doc=03-card-signals`,
      });
      await until(
        "!!document.querySelector('.card-guide-preview .board-card')",
      );
      await evaluate("document.fonts.ready.then(() => true)");
      await settle();
      await run(() =>
        document.querySelector(".card-guide-example")?.scrollIntoView(),
      );
      await delay(250);
      const help = await run(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        annotations: [
          ...document.querySelectorAll(".card-guide-example li"),
        ].map((li) => li.textContent),
        signal: (() => {
          const e = document.querySelector(
            ".card-guide-preview [data-card-signal]",
          );
          return (
            e && {
              text: e.textContent,
              marker: getComputedStyle(e, "::before").content,
            }
          );
        })(),
      }));
      assert(!help.overflow, `${name}: page overflows`);
      await shot(name);
      results.push({ name, width, theme, ...help });
      console.log(`Captured ${name}`);
    }
  // Hover and keyboard focus on the multi-reason card's signal.
  for (const theme of themes) {
    await open(1440, theme);
    await evaluate(`(${toLane.toString()})("C-4")`);
    const target = await run(() => {
      const card = [...document.querySelectorAll(".board-card")].find(
        (e) => e.querySelector(".card-id")?.textContent === "C-6",
      );
      const e = card?.querySelector("[data-card-signal]");
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!target) continue;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...target });
    await until("!!document.querySelector('[role=tooltip]')");
    await delay(200);
    const tip = await run(
      () => document.querySelector("[role=tooltip]")?.innerText,
    );
    await shot(`board-1440-${theme}-hover-C-6.png`);
    results.push({ name: `board-1440-${theme}-hover-C-6.png`, tip });
    console.log(`Captured board-1440-${theme}-hover-C-6.png`);
  }
  assert.deepEqual(browser.errors, []);
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify({ browser: version, cases: results }, null, 2)}\n`,
  );
  console.log(`Wrote ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
