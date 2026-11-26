// C-765 evidence: board card avatars put running people in the first three
// slots. Synthetic fixture only; prints where it wrote its files.
// Usage: CHROMIUM_PATH=... node test-support/c765-capture.mjs <output-dir> [before-dir]
// With a before-dir (the same script run on the baseline) it also writes
// before|after side-by-side images and per-image pixel differences.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "c765-evidence");
const before = process.argv[3] ? resolve(process.argv[3]) : undefined;
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c765-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c765")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c765",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c765-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const results = [];
const shots = {};
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
  const version = await send("Browser.getVersion");
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  // Pin every running orbit to the same moment so captures are repeatable.
  const seek = (ms) =>
    run((ms) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = ms;
      }
    }, ms);
  const open = async (width, theme) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c765#/p/p-1/cards?view=board`,
    });
    await until("document.querySelectorAll('.board-card').length === 7");
    await evaluate("document.fonts.ready.then(() => true)");
    await run(async () => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
    // Narrow board: scroll the lanes (not the page) to the scenario cards.
    await run(() => {
      const card = document.querySelector('[data-card-id="C-1"]');
      let scroller = card.parentElement;
      while (scroller && scroller.scrollWidth <= scroller.clientWidth)
        scroller = scroller.parentElement;
      if (!scroller || scroller === document.documentElement) return;
      scroller.scrollLeft +=
        card.getBoundingClientRect().left -
        scroller.getBoundingClientRect().left -
        12;
    });
    await delay(250);
    await seek(600);
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
      const name = (e) => {
        const label = e.getAttribute("aria-labelledby");
        return label
          ? document.getElementById(label)?.textContent
          : e.getAttribute("aria-label");
      };
      const cards = ["C-1", "C-2", "C-3"]
        .map((id) => document.querySelector(`[data-card-id="${id}"]`))
        .map((card) => {
          const group = card.querySelector(".employee-owners");
          const more = group?.querySelector(".employee-overflow");
          return {
            card: box(card),
            group: group && box(group),
            slots: group ? [...group.children].map(box) : [],
            names: group ? [...group.querySelectorAll("button")].map(name) : [],
            rings: group
              ? [...group.querySelectorAll("[data-run]")].map(
                  (e) => e.dataset.run,
                )
              : [],
            overflow: more && {
              text: more.textContent,
              font: getComputedStyle(more).fontSize,
              line: getComputedStyle(more).lineHeight,
              size: box(more),
            },
          };
        });
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        cards,
      };
    });
  const shot = async (name, clip) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      ...(clip ? { clip } : {}),
    });
    shots[name] = data;
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
  };
  const cardsClip = () =>
    run(() => {
      const rects = ["C-1", "C-2", "C-3"]
        .map((id) => document.querySelector(`[data-card-id="${id}"]`))
        .map((c) => c.getBoundingClientRect());
      const x = Math.max(0, Math.min(...rects.map((r) => r.x)) - 8);
      const y = Math.max(0, Math.min(...rects.map((r) => r.y)) - 8);
      return {
        x,
        y,
        width:
          Math.min(innerWidth, Math.max(...rects.map((r) => r.right)) + 8) - x,
        height: Math.max(...rects.map((r) => r.bottom)) + 8 - y,
        scale: 2,
      };
    });

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await open(width, theme);
      const name = `board-${width}-${theme}.png`;
      const metrics = await measure();
      assert(!metrics.overflow, `${name}: page overflows`);
      await shot(name);
      await shot(`cards-${width}-${theme}.png`, await cardsClip());
      results.push({ name, ...metrics });
      // +N list of the four-runner card, opened by hovering it.
      const target = await run(() => {
        const r = document
          .querySelector('[data-card-id="C-2"]')
          .querySelector(".employee-overflow")
          .getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...target });
      await until("!!document.querySelector('[role=tooltip]')");
      await delay(200);
      const tooltip = await run(
        () => document.querySelector("[role=tooltip]")?.textContent,
      );
      assert(tooltip, "tooltip did not stay open");
      const clip = await run(() => {
        const card = document
          .querySelector('[data-card-id="C-2"]')
          .getBoundingClientRect();
        const tip = document
          .querySelector("[data-radix-popper-content-wrapper]")
          .getBoundingClientRect();
        const x = Math.max(0, Math.min(card.x, tip.x) - 8);
        const y = Math.max(0, Math.min(card.y, tip.y) - 8);
        return {
          x,
          y,
          width: Math.min(innerWidth, Math.max(card.right, tip.right) + 8) - x,
          height: Math.max(card.bottom, tip.bottom) + 8 - y,
          scale: 2,
        };
      });
      const tipName = `overflow-${width}-${theme}.png`;
      await shot(tipName, clip);
      results.push({ name: tipName, tooltip });
      console.log(`Captured ${name}`);
    }
  assert.deepEqual(browser.errors, []);

  const diffs = {};
  if (before) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    const images = (fn, ...args) =>
      run(
        async (fn, ...args) => {
          const load = (src) =>
            new Promise((r) => {
              const img = new Image();
              img.onload = () => r(img);
              img.src = `data:image/png;base64,${src}`;
            });
          const imgs = await Promise.all(args.map(load));
          return new Function("imgs", fn)(imgs);
        },
        fn,
        ...args,
      );
    for (const name of Object.keys(shots)) {
      const old = (await readFile(resolve(before, name))).toString("base64");
      diffs[name] = await images(
        `const [a, b] = imgs; if (a.width !== b.width || a.height !== b.height) return "size";
         const px = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
           const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
         const [p, q] = [px(a), px(b)]; let n = 0;
         for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i+1] !== q[i+1] || p[i+2] !== q[i+2] || p[i+3] !== q[i+3]) n++;
         return n;`,
        old,
        shots[name],
      );
      const png = await images(
        `const [l, r] = imgs; const c = document.createElement("canvas");
         c.width = l.width + r.width + 16; c.height = Math.max(l.height, r.height);
         const x = c.getContext("2d"); x.fillStyle = "#888"; x.fillRect(0, 0, c.width, c.height);
         x.drawImage(l, 0, 0); x.drawImage(r, l.width + 16, 0);
         return c.toDataURL("image/png").split(",")[1];`,
        old,
        shots[name],
      );
      await writeFile(
        resolve(output, `side-by-side-${name}`),
        Buffer.from(png, "base64"),
      );
    }
  }
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify({ browser: version, cases: results, diffs }, null, 2)}\n`,
  );
  console.log(`Wrote ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
