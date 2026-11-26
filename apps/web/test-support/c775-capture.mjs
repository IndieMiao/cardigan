// C-775 evidence: the card detail while the server answers 503 read_timeout.
// Synthetic fixture only; prints where it wrote its files.
// Usage: CHROMIUM_PATH=... node test-support/c775-capture.mjs <output-dir> [before-dir]
// With a before-dir (the same script run on the baseline) it also writes
// before|after side-by-side images and per-image pixel differences. Every run
// writes the failed detail beside the card list (the reference page) at the
// same width and theme.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "c775-evidence");
const before = process.argv[3] ? resolve(process.argv[3]) : undefined;
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c775-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c775")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c775",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c775-fixture.tsx"></script></body></html>`,
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
  const until = async (expression, ms = 20000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const settle = () =>
    run(async () => {
      await document.fonts.ready;
      document.activeElement?.blur();
      window.scrollTo(0, 0);
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
  const open = async (width, theme, hash, phase = "failed") => {
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
      url: `${server.resolvedUrls.local[0]}__c775?phase=${phase}${hash}`,
    });
    await until("!!window.c775");
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
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
          right: +r.right.toFixed(2),
        };
      };
      const style = (e) => {
        const s = getComputedStyle(e);
        return {
          font: s.fontSize,
          line: s.lineHeight,
          color: s.color,
          border: `${s.borderTopWidth} ${s.borderTopColor}`,
          padding: s.padding,
          gap: s.gap,
        };
      };
      const feedback = [
        ...document.querySelectorAll("body > .request-feedback-region > *"),
      ].filter((e) => e.textContent);
      const content = document.querySelector(
        ".ui-workspace, .card-detail, main",
      );
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        reads: window.c775.reads.count,
        loadingText: document.body.innerText.includes("正在加载"),
        content: content && box(content),
        feedback: feedback.map((e) => {
          const button = e.querySelector("button");
          const text = e.querySelector("span");
          return {
            role: e.getAttribute("role"),
            text: e.textContent,
            box: box(e),
            style: style(e),
            textStyle: text && style(text),
            button: button && {
              text: button.textContent,
              box: box(button),
              font: getComputedStyle(button).fontSize,
              line: getComputedStyle(button).lineHeight,
            },
          };
        }),
      };
    });
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    shots[name] = data;
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
  };
  const record = async (name) => {
    await settle();
    await delay(200);
    const metrics = await measure();
    assert(!metrics.overflow, `${name}: page overflows`);
    await shot(name);
    results.push({ name, ...metrics });
    console.log(`Captured ${name}`);
    return metrics;
  };

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const suffix = `${width}-${theme}.png`;
      // The reference page at the same width and theme.
      await open(width, theme, "#/p/p-1/cards?view=list");
      await until("!!document.querySelector('.card-table')");
      await record(`list-${suffix}`);
      // While the client waits between retries.
      await open(width, theme, "#/p/p-1/cards/C-2", "retrying");
      await until("window.c775.reads.count >= 1");
      // Past RequestFeedback's 1 s slow threshold.
      await delay(1300);
      await record(`detail-retrying-${suffix}`);
      // After the last retry.
      await open(width, theme, "#/p/p-1/cards/C-2", "failed");
      await until("!!document.querySelector('[role=alert]')");
      const failed = await record(`detail-failed-${suffix}`);
      // Activity on the project must not start reading again on its own.
      await delay(500);
      results.push({
        name: `detail-failed-${suffix} reads after 500 ms`,
        reads: await evaluate("window.c775.reads.count"),
        before: failed.reads,
      });
      // “重试” reads again and shows the card.
      await run(() => {
        window.c775.recover();
        document.querySelector("[role=alert] button").click();
      });
      await until("!document.querySelector('[role=alert]')");
      await until("!!document.querySelector('.card-main')");
      await record(`detail-recovered-${suffix}`);
    }
  assert.deepEqual(browser.errors, []);

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
  const pair = (left, right) =>
    images(
      `const [l, r] = imgs; const c = document.createElement("canvas");
       c.width = l.width + r.width + 16; c.height = Math.max(l.height, r.height);
       const x = c.getContext("2d"); x.fillStyle = "#888"; x.fillRect(0, 0, c.width, c.height);
       x.drawImage(l, 0, 0); x.drawImage(r, l.width + 16, 0);
       return c.toDataURL("image/png").split(",")[1];`,
      left,
      right,
    );
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const suffix = `${width}-${theme}.png`;
      await writeFile(
        resolve(output, `reference-${suffix}`),
        Buffer.from(
          await pair(shots[`list-${suffix}`], shots[`detail-failed-${suffix}`]),
          "base64",
        ),
      );
    }
  const diffs = {};
  if (before) {
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
      await writeFile(
        resolve(output, `side-by-side-${name}`),
        Buffer.from(await pair(old, shots[name]), "base64"),
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
