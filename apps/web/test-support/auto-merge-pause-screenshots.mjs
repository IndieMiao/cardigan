import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "/tmp/cardigan-auto-merge-pause");
await mkdir(output, { recursive: true });
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "auto-merge-pause-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__pause")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__pause",
              '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="/test-support/auto-merge-pause.tsx"></script></body></html>',
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
  const { send, evaluate } = browser;
  const until = async (expression) => {
    const end = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  for (const [width, height] of [
    [1280, 800],
    [1920, 1080],
  ])
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      for (const [page, scenario] of [
        ["settings", "on"],
        ["settings", "off"],
        ["settings", "denied"],
        ["settings", "failed"],
        ["settings", "loading"],
        ["needs-you", "zero"],
        ["needs-you", "waiting"],
        ["needs-you", "checks"],
        ["needs-you", "human"],
      ]) {
        const name = `${page}-${scenario}-${width}-${theme}`;
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__pause?scenario=${scenario}#/p/p-1/${page}`,
        });
        const selector =
          page === "settings"
            ? ".auto-merge-pause-setting input"
            : ".auto-merge-pause-banner a";
        await until(`!!document.querySelector('${selector}')`);
        await evaluate("document.fonts.ready");
        if (["denied", "failed", "loading"].includes(scenario)) {
          await evaluate(`document.querySelector('${selector}').click()`);
          await until(
            scenario === "loading"
              ? `document.querySelector('${selector}').disabled`
              : "!!document.querySelector('[role=alert]')",
          );
        }
        await evaluate(
          `document.querySelector('${selector}').scrollIntoView({ block: 'center' })`,
        );
        await evaluate(`document.querySelector('${selector}').focus()`);
        // Genuine keyboard navigation exposes focus-visible as well.
        for (const type of ["keyDown", "keyUp"])
          await send("Input.dispatchKeyEvent", {
            type,
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
          });
        if (scenario !== "loading") {
          for (const type of ["keyDown", "keyUp"])
            await send("Input.dispatchKeyEvent", {
              type,
              key: "Tab",
              code: "Tab",
              windowsVirtualKeyCode: 9,
              modifiers: 8,
            });
        }
        const metric = await evaluate(`(() => {
        const el = document.querySelector('${selector}');
        const box = (el.closest('label') ?? el).getBoundingClientRect();
        const active = document.activeElement;
        return { width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, targetWidth: box.width, targetHeight: box.height, checked: el.checked ?? null, disabled: el.disabled ?? false, banner: document.querySelector('.auto-merge-pause-banner')?.textContent ?? null, alert: document.querySelector('[role=alert]')?.textContent ?? null, targetFocused: active === el,
          keyboardFocus: active.tagName, focusOutline: getComputedStyle(active).outlineStyle };
      })()`);
        assert.equal(metric.width, metric.scrollWidth, `${name}: overflow`);
        assert(
          metric.targetWidth >= 44 && metric.targetHeight >= 44,
          `${name}: target size`,
        );
        if (page === "needs-you")
          assert(
            metric.banner.includes(`（${scenario === "zero" ? 0 : 3} 张等待）`),
          );
        if (scenario === "denied" || scenario === "failed")
          assert(metric.checked && metric.alert);
        if (scenario !== "loading") {
          assert(metric.targetFocused, `${name}: keyboard target`);
          assert.equal(metric.focusOutline, "solid", `${name}: visible focus`);
        }
        measurements.push({ name, ...metric });
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          resolve(output, `${name}.png`),
          Buffer.from(data, "base64"),
        );
      }
    }
  assert.equal(browser.errors.length, 0, "browser exceptions");
  await writeFile(
    resolve(output, "measurements.json"),
    JSON.stringify(
      {
        source:
          "synthetic fakeClient; 3 system-wait cards, 2 check waits, 1 human notice; no production IO",
        measurements,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      screenshots: measurements.length,
      minTargetHeight: Math.min(...measurements.map((m) => m.targetHeight)),
      overflow: false,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
