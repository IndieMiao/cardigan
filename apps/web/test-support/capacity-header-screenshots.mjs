import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.CAPACITY_SCREENSHOTS;
assert(output, "Set CAPACITY_SCREENSHOTS");
const baseline =
  process.env.CAPACITY_BASELINE_REF ??
  "4cf31e79e3708b9794e7b673324b799567170079";
await mkdir(output, { recursive: true });
const measurements = [];
const contrasts = [];
// Run inside Chromium: composite transparent ancestors and measure rendered text.
const contrastScript = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1, 1);
  const ancestors = [];
  for (let n = el; n; n = n.parentElement) ancestors.unshift(n);
  for (const n of ancestors) {
    ctx.fillStyle = getComputedStyle(n).backgroundColor; ctx.fillRect(0, 0, 1, 1);
  }
  const bg = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
  ctx.fillStyle = getComputedStyle(el).color; ctx.fillRect(0, 0, 1, 1);
  const fg = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
  const lum = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  return { fg, bg, ratio: (Math.max(lum(fg), lum(bg)) + .05) / (Math.min(lum(fg), lum(bg)) + .05) };
})()`;
for (const stage of ["before", "after"]) {
  const server = await createServer({
    root,
    server: { host: "localhost", port: 0 },
    plugins: [
      {
        name: "capacity-header-fixture",
        enforce: "pre",
        resolveId(source) {
          if (
            stage === "before" &&
            /\/ExecutionCapacityPanel\.(js|tsx)$/.test(source)
          )
            return resolve(root, "src/views/ExecutionCapacityPanel.tsx");
        },
        load(id) {
          if (stage !== "before" || !id.startsWith(`${resolve(root, "src")}/`))
            return;
          try {
            return execFileSync(
              "git",
              ["show", `${baseline}:apps/web/${id.slice(root.length)}`],
              {
                cwd: root,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              },
            );
          } catch {
            return;
          }
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/__capacity")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                "/__capacity",
                '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/capacity-header-fixture.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium();
    const { send, evaluate } = browser;
    const until = async (expression) => {
      const deadline = Date.now() + 15000;
      while (!(await evaluate(expression))) {
        assert(Date.now() < deadline, expression);
        await delay(40);
      }
    };
    const capture = async (name) => {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(
        resolve(output, `${name}.png`),
        Buffer.from(data, "base64"),
      );
    };
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: width === 390 ? 844 : 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-color-scheme", value: theme },
            { name: "prefers-reduced-motion", value: "reduce" },
          ],
        });
        for (const [name, route, tab] of [
          ["board", "cards?view=board"],
          ["execution", "execution"],
          ["needs-you", "needs-you"],
          ["card", "cards/C-1"],
          ["team", "settings", "员工"],
          ["settings", "settings", stage === "after" ? "并发与容量" : "偏好"],
        ]) {
          await send("Page.navigate", {
            url: `${server.resolvedUrls.local[0]}__capacity?case=${stage}-${width}-${theme}-${name}#${`/p/p-1/${route}`}`,
          });
          await until('Boolean(document.querySelector(".page-title h1"))');
          if (stage === "after")
            await until(
              'document.querySelector(".capacity-status")?.textContent.includes("4/10")',
            );
          if (tab)
            await evaluate(
              `Array.from(document.querySelectorAll('.settings-layout nav button')).find(b => b.textContent === ${JSON.stringify(tab)}).click()`,
            );
          await evaluate("document.fonts.ready.then(() => true)");
          await delay(100);
          const measure = await evaluate(
            `(() => { const rect = s => { const n = document.querySelector(s); return n ? { x: n.getBoundingClientRect().x, y: n.getBoundingClientRect().y, width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height, scrollWidth: n.scrollWidth, clientWidth: n.clientWidth } : null; }; return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, title: rect('.page-title h1'), status: rect('.capacity-status') }; })()`,
          );
          measurements.push({ stage, width, theme, page: name, ...measure });
          assert.equal(
            measure.scrollWidth,
            measure.clientWidth,
            `${stage} ${width} ${name} page overflow`,
          );
          if (measure.status) {
            assert(
              measure.status.x >= measure.title.x + measure.title.width,
              "title/status overlap",
            );
            assert(
              measure.status.height <= (stage === "before" ? 40 : 44),
              "status wrapped",
            );
            if (stage === "after")
              assert(measure.status.height >= 44, "capacity target too small");
            const contrast = await evaluate(contrastScript(".capacity-status"));
            contrasts.push({ width, theme, element: "status", ...contrast });
            assert(contrast.ratio >= 4.5, "status text contrast");
          }
          const filename = `${stage}-${width}-${theme}-${name}`;
          await capture(filename);
          if (stage === "after" && name === "execution") {
            await evaluate(
              'document.querySelector(".capacity-status").focus()',
            );
            await until('Boolean(document.querySelector(".capacity-tooltip"))');
            await delay(100);
            assert(
              await evaluate(
                'document.querySelector(".capacity-tooltip").getBoundingClientRect().right <= innerWidth',
              ),
              "tooltip overflows",
            );
            await capture(`${filename}-tooltip`);
            const contrast = await evaluate(
              contrastScript(".capacity-tooltip"),
            );
            contrasts.push({ width, theme, element: "tooltip", ...contrast });
            assert(contrast.ratio >= 4.5, "tooltip text contrast");
            await send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "Escape",
              code: "Escape",
            });
            await send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Escape",
              code: "Escape",
            });
            await until('!document.querySelector(".capacity-tooltip")');
            await evaluate(
              'window.dispatchEvent(new Event("synthetic-capacity"))',
            );
            await until(
              'document.querySelector(".capacity-status")?.textContent.includes("5/10")',
            );
          }
        }
      }
    assert.deepEqual(browser.errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}
await writeFile(
  resolve(output, "measurements.json"),
  JSON.stringify(
    {
      baseline,
      subject: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      data: "synthetic: 2 Agent machines, 2 CI targets, 1 card",
      measurements,
      contrasts,
    },
    null,
    2,
  ),
);
console.log(
  `Captured ${measurements.length} page states and 4 tooltips; no page overflow.`,
);
