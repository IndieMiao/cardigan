import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "build/filter-chips-layout");
const query = "非常长的搜索文本".repeat(12);
const statuses =
  "backlog,todo,in_progress,review,awaiting_merge,done,cancelled";
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "filter-chips-fixture",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith("/test-support/c411-fixture.tsx"))
          return code.replace(
            '"../src/styles.css"',
            '"../src/components/ui/theme.css"',
          );
      },
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__filter-chips")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__filter-chips",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c411-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
const records = [];
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium();
  const { send, evaluate } = browser;
  async function until(expression) {
    const deadline = Date.now() + 10000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < deadline, expression);
      await delay(50);
    }
  }
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"]) {
      for (const view of ["board", "list"]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        const params = new URLSearchParams({
          view,
          q: query,
          status: statuses,
        });
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__filter-chips#/p/p-1/cards?${params}`,
        });
        await until(
          "document.querySelectorAll('.filter-chips button').length === 2",
        );
        await evaluate("document.fonts.ready");
        const measurement = await evaluate(`(() => {
          const chips = [...document.querySelectorAll('.filter-chips button')].map(e => {
            const r = e.getBoundingClientRect(), label = e.firstElementChild, close = e.lastElementChild.getBoundingClientRect();
            return {title: e.title, height: r.height, right: r.right, parentRight: e.parentElement.getBoundingClientRect().right,
              labelWidth: label.clientWidth, labelScroll: label.scrollWidth, ellipsis: getComputedStyle(label).textOverflow,
              removeVisible: close.width > 0 && close.right <= r.right && close.left >= r.left};
          });
          const overflow = [...document.querySelectorAll('.ui-filter-bar, .ui-filter-bar *')].filter(e => e.getBoundingClientRect().right > innerWidth).map(e => ({tag: e.tagName, className: e.className, right: e.getBoundingClientRect().right}));
          return {width: innerWidth, scrollWidth: document.documentElement.scrollWidth, chips, overflow};
        })()`);
        assert.equal(
          measurement.scrollWidth,
          width,
          `long chips overflow the page: ${JSON.stringify(measurement)}`,
        );
        assert(
          measurement.chips.some((c) => c.title === `搜索标题或编号：${query}`),
        );
        for (const chip of measurement.chips) {
          assert(
            chip.right <= chip.parentRight + 1,
            "chip exceeds its container",
          );
          assert.equal(chip.height, 28);
          assert.equal(chip.ellipsis, "ellipsis");
          assert(chip.removeVisible, "remove affordance must remain visible");
        }
        const search = measurement.chips.find((c) =>
          c.title.startsWith("搜索标题或编号："),
        );
        assert(
          search.labelScroll > search.labelWidth,
          "long label should truncate",
        );
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          resolve(output, `${view}-${theme}-${width}.png`),
          Buffer.from(data, "base64"),
        );
        await evaluate(
          "document.querySelector('[aria-label=\"移除搜索标题或编号筛选\"]').focus()",
        );
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          text: "\r",
          windowsVirtualKeyCode: 13,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await until(
          "!document.querySelector('[aria-label=\"移除搜索标题或编号筛选\"]')",
        );
        const remaining = await evaluate(
          "Object.fromEntries(new URLSearchParams(location.hash.split('?')[1]))",
        );
        assert.equal(remaining.q, undefined);
        assert.equal(remaining.status, statuses);
        records.push({
          theme,
          view,
          ...measurement,
          keyboardRemoval: "passed",
        });
      }
    }
  }
  assert.equal(browser.errors.length, 0);
  await writeFile(
    resolve(output, "measurements.json"),
    JSON.stringify(
      {
        sha,
        fixture:
          "c411-implementation-v1; 12 synthetic cards; fixed clock; no business service",
        records,
      },
      null,
      2,
    ),
  );
  console.log(`Filter chip layout: ${records.length} scenarios passed.`);
} finally {
  await browser?.close();
  await server.close();
}
