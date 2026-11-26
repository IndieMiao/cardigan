// C-768: Needs You merge confirmation with an optional verifier still open.
// `optional-before` is the same card as the previous rule reported it (the
// verifier listed as waiting, “确认合并” disabled, only “仍要合并” left);
// `optional-pending` is the current rule (merge enabled, the verifier listed
// apart under “可选、不挡合并”). 1440×900 and 390×844, light and dark, on the
// synthetic compact-merge fixture. Records the button states and both lists.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c768-capture.mjs <new dir>
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
await mkdir(output);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c768-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c768")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c768",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/compact-merge.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const shots = [];
let browser;
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
  for (const scenario of ["optional-before", "optional-pending"])
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        const height = width === 390 ? 844 : 900;
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__c768?scenario=${scenario}#/p/p-1/needs-you`,
        });
        await until(
          "!!document.querySelector('[aria-label=\"合并前置条件\"]')",
        );
        await evaluate("document.fonts.ready");
        await evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        const metric = await evaluate(`(() => {
          const buttons = [...document.querySelectorAll('button')];
          const find = text => buttons.find(b => b.textContent.trim() === text);
          const confirm = find('确认合并');
          const status = document.querySelector('[aria-label="合并前置条件"]');
          const optional = status.querySelector('[aria-label="可选、不挡合并"]');
          return {
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            confirmDisabled: confirm.disabled,
            override: !!find('仍要合并'),
            statusText: [...status.querySelectorAll('p')].map(e => e.textContent),
            waiting: optional
              ? [...status.querySelectorAll('ul:not([aria-label]) li')].map(e => e.textContent)
              : [...status.querySelectorAll('li')].map(e => e.textContent),
            optional: optional ? [...optional.querySelectorAll('li')].map(e => e.textContent) : [],
          };
        })()`);
        const name = `${scenario}-${width}-${theme}`;
        assert.equal(
          metric.scrollWidth,
          metric.clientWidth,
          `${name}: overflow`,
        );
        if (scenario === "optional-pending") {
          assert.equal(metric.confirmDisabled, false, name);
          assert.equal(metric.override, false, name);
          assert.deepEqual(metric.waiting, [], name);
          assert.deepEqual(metric.optional, ["Google 补录（W-420）"], name);
        } else {
          assert.equal(metric.confirmDisabled, true, name);
          assert.equal(metric.override, true, name);
        }
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          resolve(output, `${name}.png`),
          Buffer.from(data, "base64"),
        );
        shots.push({ name, width, height, theme, ...metric });
      }
  assert.deepEqual(browser.errors, []);
} finally {
  await browser?.close();
  await server.close();
}
await writeFile(
  resolve(output, "measurements.json"),
  JSON.stringify(
    { data: "合成数据；仅本地 Web，无业务服务或生产库", shots },
    null,
    2,
  ),
);
console.log(`PASS ${shots.length} shots; ${output}`);
