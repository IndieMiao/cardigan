import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-409: existing deterministic, in-memory App fixture; no business server.
const output = process.argv[2];
assert(output, "Pass a screenshot output directory");
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "build-version-screenshot-entry",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__build-version")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/__build-version",
              `<!doctype html>
          <html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
          <body><div id="root"></div><script type="module" src="/test-support/responsive-fixture.tsx"></script></body></html>`,
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
  const origin = server.resolvedUrls.local[0];
  browser = await chromium();
  await browser.send("Emulation.setTimezoneOverride", {
    timezoneId: "Asia/Shanghai",
  });
  await browser.send("Browser.grantPermissions", {
    origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  const waitFor = (expression) =>
    browser.evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 10000;
    function check() {
      if (${expression}) return resolve(true);
      if (performance.now() > deadline) return reject(new Error('Fixture did not become ready'));
      setTimeout(check, 50);
    }
    check();
  })`);
  const save = async (name) => {
    const { data } = await browser.send("Page.captureScreenshot", {
      format: "png",
    });
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
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
        url: `${origin}__build-version?buildVersion&width=${width}&theme=${theme}#/p/p-1/cards`,
      });
      await waitFor(
        "document.querySelector('.board-card') && document.querySelector('.build-version')",
      );
      await browser.evaluate("document.fonts.ready");
      if (width === 390) {
        assert(
          await browser.evaluate(
            "document.querySelector('.sidebar').getBoundingClientRect().width === 0",
          ),
        );
        await save(`${width}-${theme}-collapsed`);
        await browser.evaluate(
          "document.querySelector('.mobile-header button').click()",
        );
        await waitFor("document.querySelector('.nav-drawer .build-version')");
      }
      const selector =
        width === 390
          ? ".nav-drawer .build-version"
          : ".sidebar .build-version";
      const measurement = await browser.evaluate(`(() => {
        const button = document.querySelector('${selector}');
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        const hitTop = document.elementFromPoint(box.x + box.width / 2, box.top - 11) === button;
        const hitBottom = document.elementFromPoint(box.x + box.width / 2, box.bottom + 11) === button;
        return { text: button.textContent, x: box.x, y: box.y, width: box.width, height: box.height,
          font: style.fontSize, color: style.color, hitTop, hitBottom,
          scrollWidth: document.documentElement.scrollWidth };
      })()`);
      assert.equal(measurement.text, "60eb954 · 11-17 06:56");
      assert.equal(measurement.scrollWidth, width);
      assert(
        measurement.hitTop && measurement.hitBottom,
        "44px touch area must be reachable",
      );
      measurements.push({ viewportWidth: width, theme, ...measurement });
      await save(`${width}-${theme}-expanded`);
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: measurement.x + 10,
        y: measurement.y + 10,
      });
      await waitFor("document.querySelector('[role=tooltip]')");
      const tooltip = await browser.evaluate(
        "document.querySelector('[role=tooltip]').textContent",
      );
      assert(tooltip.includes("60eb95489d5361cca6040ab9517a05289eb7ab03"));
      assert(tooltip.includes("构建于"));
      await save(`${width}-${theme}-tooltip`);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await browser.send("Input.dispatchMouseEvent", {
          type,
          x: measurement.x + 10,
          y: measurement.y + 10,
          button: "left",
          clickCount: 1,
        });
      }
      await waitFor("document.querySelector('[data-feedback]')");
      assert.equal(
        await browser.evaluate("navigator.clipboard.readText()"),
        "60eb95489d5361cca6040ab9517a05289eb7ab03",
      );
    }
  }
  assert.deepEqual(browser.errors, []);
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
  console.log(
    `Captured 10 screenshots; ${measurements.length} layout, tooltip, touch-target and clipboard checks passed.`,
  );
} finally {
  await browser?.close();
  await server.close();
}
