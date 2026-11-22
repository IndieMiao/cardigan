// C-567 evidence: 预检中 / 合并检查中 on the board and the card detail status
// line. Synthetic fixture only; prints where it wrote its files.
// Usage: CHROMIUM_PATH=... node test-support/c567-capture.mjs <output-dir>
//        CHROMIUM_PATH=... node test-support/c567-capture.mjs --compose \
//          <before-dir> <after-dir> <baseline-dir> <output-dir>
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
  (compose ? process.argv[6] : process.argv[2]) ?? "c567-evidence",
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
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        pairs.push([
          `pair-before-after-board-${width}-${theme}.png`,
          ["改前", resolve(before, `board-${width}-${theme}.png`)],
          ["改后", resolve(after, `board-${width}-${theme}.png`)],
          width,
        ]);
        for (const lane of ["C-2", "C-3", "C-4"])
          pairs.push([
            `pair-before-after-board-${width}-${theme}-lane-${lane}.png`,
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
          `pair-baseline-after-board-${width}-${theme}.png`,
          ["基准卡片页", resolve(baseline, `board-${width}-${theme}.png`)],
          ["改后", resolve(after, `board-${width}-${theme}.png`)],
          width,
        ]);
        pairs.push([
          `pair-before-after-detail-${width}-${theme}.png`,
          ["改前", resolve(before, `detail-C-2-${width}-${theme}.png`)],
          ["改后", resolve(after, `detail-C-2-${width}-${theme}.png`)],
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
      name: "c567-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c567")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c567",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c567-fixture.tsx"></script></body></html>`,
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
  const open = async (route, width, theme, ready) => {
    await viewport(width, 1000, theme);
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c567#/p/p-1/${route}`,
    });
    await until(ready);
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
      const badge = (label) => {
        const e = document.querySelector(`[aria-label="${label}"]`);
        if (!e?.getClientRects().length) return null;
        const style = getComputedStyle(e);
        const icon = e.querySelector("svg");
        const text = [...e.childNodes].find((n) => n.nodeType === 3);
        const range = document.createRange();
        if (text) range.selectNodeContents(text);
        const textBox = text ? range.getBoundingClientRect() : null;
        return {
          box: box(e),
          font: style.fontSize,
          line: style.lineHeight,
          color: style.color,
          icon: icon && { ...box(icon), color: getComputedStyle(icon).color },
          iconTextGap:
            icon && textBox
              ? +(textBox.left - icon.getBoundingClientRect().right).toFixed(2)
              : null,
          classes: e.className,
        };
      };
      const tiles = [...document.querySelectorAll(".board-card")].map((e) => ({
        id: e.querySelector(".card-id")?.textContent,
        box: box(e),
        blocked: e.classList.contains("card-tile-blocked"),
        borderLeft: getComputedStyle(e).borderLeftColor,
        badges: [...e.querySelectorAll(".board-card-badge")].map((b) =>
          b.getAttribute("aria-label"),
        ),
      }));
      const status = document.querySelector('[aria-label="卡片状态"]');
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        precheck: badge("预检中"),
        mergeCheck: badge("合并检查中"),
        blocked: badge("阻塞：W-2 阻塞"),
        tiles,
        statusLine: status && {
          text: status.textContent,
          font: getComputedStyle(status).fontSize,
          line: getComputedStyle(status).lineHeight,
          link: [...status.querySelectorAll("a")].map((a) => ({
            text: a.textContent,
            href: a.getAttribute("href"),
          })),
        },
        redParagraphs: [...document.querySelectorAll(".merge-exception")].map(
          (p) => p.textContent,
        ),
      };
    });
  const capture = async (name, route, width, theme, ready, before) => {
    await open(route, width, theme, ready);
    if (before) await evaluate(before);
    await delay(100);
    const metrics = await measure();
    assert(!metrics.overflow, `${name}: page overflows`);
    await shot(name);
    results.push({ name, width, theme, ...metrics });
    console.log(`Captured ${name}`);
  };
  const boardReady = "document.querySelectorAll('.board-card').length === 7";
  const detailReady = "!!document.querySelector('[aria-label=\"卡片状态\"]')";
  // The lanes scroll sideways; bring the C-2..C-4 lanes into view.
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
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await capture(
        `board-${width}-${theme}.png`,
        "cards?view=board",
        width,
        theme,
        boardReady,
      );
      for (const id of ["C-2", "C-3", "C-4"])
        await capture(
          `board-${width}-${theme}-lane-${id}.png`,
          "cards?view=board",
          width,
          theme,
          boardReady,
          `(${toLane.toString()})(${JSON.stringify(id)})`,
        );
      for (const id of ["C-2", "C-3", "C-4"])
        await capture(
          `detail-${id}-${width}-${theme}.png`,
          `cards/${id}`,
          width,
          theme,
          detailReady,
        );
    }
  // Tooltip and keyboard focus on the new marker.
  await open("cards?view=board", 1440, "light", boardReady);
  const target = await run(() => {
    const e = document.querySelector('[aria-label="预检中"]');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (target) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...target });
    await until("!!document.querySelector('[role=tooltip]')");
    await delay(200);
    const tip = await run(
      () => document.querySelector("[role=tooltip]")?.textContent,
    );
    await shot("board-1440-light-hover-precheck.png");
    results.push({ name: "board-1440-light-hover-precheck.png", tip });
    console.log("Captured board-1440-light-hover-precheck.png");
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
