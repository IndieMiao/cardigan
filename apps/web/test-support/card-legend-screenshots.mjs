import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-410: real HelpPage + BoardCard, local synthetic fixture; no backend or credentials.
const output = process.argv[2];
assert(output, "Pass a new screenshot output directory");
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "card-guide-screenshot-entry",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__card-guide")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/__card-guide",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/responsive-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
let browser;
const measurements = [];
try {
  await server.listen();
  browser = await chromium();
  const origin = server.resolvedUrls.local[0];
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"]) {
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: width === 390 ? 844 : 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await browser.send("Page.navigate", {
        url: `${origin}__card-guide?theme=${theme}#/p/p-1/help?doc=03-card-signals`,
      });
      await browser.evaluate(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 10000;
        function check() {
          if (document.querySelector('.card-guide .board-card')) return resolve(true);
          if (performance.now() > deadline) return reject(new Error('Card guide did not load'));
          setTimeout(check, 50);
        }
        check();
      })`);
      await browser.evaluate("document.fonts.ready");
      const measurement = await browser.evaluate(`(() => {
        const guide = document.querySelector('.card-guide');
        const preview = guide.querySelector('.card-guide-preview');
        const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const targets = [preview, ...guide.querySelectorAll('td')];
        const directory = document.querySelector('.help-directory a[aria-current="page"]');
        directory.focus();
        const focusOutline = getComputedStyle(directory).outlineWidth;
        directory.blur();
        const rgb = value => value.match(/[\\d.]+/g).slice(0, 3).map(Number);
        const luminance = value => rgb(value).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const background = luminance(getComputedStyle(document.body).backgroundColor);
        const contrast = element => { const foreground = luminance(getComputedStyle(element).color); return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05); };
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          preview: rect(preview), inert: preview.inert,
          tables: guide.querySelectorAll('table').length,
          rows: guide.querySelectorAll('[data-legend-signal]').length,
          overflow: targets.filter(e => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > innerWidth + 1).map(e => e.textContent),
          directory: rect(directory), focusOutline,
          bodyContrast: contrast(guide.querySelector('td[data-label]')),
          mutedContrast: contrast(guide.querySelector('th')),
          border: getComputedStyle(preview.querySelector('.board-card')).borderLeftColor,
          status: getComputedStyle(preview.querySelector('.status-icon')).color,
        };
      })()`);
      assert.equal(
        measurement.width,
        measurement.scrollWidth,
        "Page horizontal overflow",
      );
      assert.deepEqual(
        measurement.overflow,
        [],
        "Guide cell or preview overflow",
      );
      assert.equal(measurement.inert, true, "Synthetic records must be inert");
      assert.equal(measurement.tables, 7);
      assert(
        measurement.directory.height >= 44 && measurement.directory.width >= 44,
      );
      assert(
        parseFloat(measurement.focusOutline) > 0,
        "Visible keyboard focus",
      );
      assert(
        measurement.bodyContrast >= 4.5 && measurement.mutedContrast >= 4.5,
        "Text contrast",
      );
      assert.equal(measurement.rows, 34);
      measurements.push({ theme, ...measurement });
      const save = async (suffix, full = false) => {
        const { cssContentSize } = await browser.send("Page.getLayoutMetrics");
        const { data } = await browser.send("Page.captureScreenshot", {
          format: "png",
          ...(full
            ? {
                captureBeyondViewport: true,
                clip: {
                  x: 0,
                  y: 0,
                  width,
                  height: cssContentSize.height,
                  scale: 1,
                },
              }
            : {}),
        });
        await writeFile(
          resolve(output, `${width}-${theme}-${suffix}.png`),
          Buffer.from(data, "base64"),
          { flag: "wx" },
        );
      };
      await save("top");
      await save("full", true);
      for (const title of ["状态图标", "等待、暂停与取代"]) {
        await browser.evaluate(
          `document.querySelector('.card-guide section[aria-label=${JSON.stringify(title)}]').scrollIntoView({block:'start'})`,
        );
        await save(title === "状态图标" ? "states" : "waiting");
      }
      console.log(`PASS card legend ${width} ${theme}`);
    }
  }
  assert.deepEqual(browser.errors, [], "Browser runtime errors");
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(measurements, null, 2)}\n`,
    { flag: "wx" },
  );
} finally {
  await browser?.close();
  await server.close();
}
