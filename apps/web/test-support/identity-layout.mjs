import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// Focused component geometry check; no server, credentials or production data.
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root,
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "identity-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__identity")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__identity",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>#root{padding:16px}#root>section{margin-bottom:24px}</style></head><body><div id="root"></div><script type="module" src="/test-support/identity-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const output = process.env.LAYOUT_SCREENSHOTS;
if (output) await mkdir(output, { recursive: true });
let browser;
try {
  await server.listen();
  browser = await chromium();
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await browser.send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__identity#/p/p-1/execution?view=all`,
      });
      const deadline = Date.now() + 15000;
      while (
        !(await browser.evaluate(
          "Boolean(document.querySelector('.needs-delivery-head') && document.querySelector('.execution-row'))",
        ))
      ) {
        assert(Date.now() < deadline, "fixture did not load");
        await delay(50);
      }
      await browser.evaluate("document.fonts.ready");
      const geometry = await browser.evaluate(`(() => {
      const rect = (e) => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,cy:r.y+r.height/2};};
      return {
        width:document.documentElement.scrollWidth,
        rows:[...document.querySelectorAll('#identity-example,.needs-delivery-head,.record-row,.timeline-identity')].map(row=>({
          name:row.className,align:getComputedStyle(row).alignItems,wrap:getComputedStyle(row).flexWrap,
          children:[...row.children].filter(e=>e.getBoundingClientRect().width).map(rect)
        })),
        people:[...document.querySelectorAll('.employee-inline')].map(e=>({avatar:rect(e.querySelector('.employee-avatar')),name:rect(e.querySelector('.employee-label'))})),
        badges:[...document.querySelectorAll('.id-badge')].map(e=>({text:e.textContent,nowrap:getComputedStyle(e).whiteSpace,height:e.getBoundingClientRect().height})),
        title:rect(document.querySelector('#identity-long .id-description')),
        links:[...document.querySelectorAll('#identity-example a')].map(rect)
      };
    })()`);
      assert(
        geometry.width <= width + 1,
        `${width}/${theme} horizontal overflow: ${geometry.width}`,
      );
      for (const row of geometry.rows) {
        assert.equal(row.align, "center");
        assert.equal(row.wrap, "wrap");
        for (let i = 1; i < row.children.length; i++) {
          const a = row.children[i - 1],
            b = row.children[i];
          if (Math.max(a.y, b.y) < Math.min(a.y + a.h, b.y + b.h))
            assert(Math.abs(a.cy - b.cy) < 1, `${row.name}: different centers`);
        }
      }
      for (const { avatar, name } of geometry.people) {
        assert.equal(avatar.w, 24);
        assert.equal(avatar.h, 24);
        assert(
          Math.abs(avatar.cy - name.cy) < 1,
          "name and avatar are misaligned",
        );
      }
      for (const badge of geometry.badges) {
        assert.equal(badge.nowrap, "nowrap");
        assert.equal(badge.height, 24);
      }
      assert(
        geometry.links.every((r) => r.h >= 32),
        "link hit area too small",
      );
      if (width === 390)
        assert(geometry.title.h > 20, "long title should wrap");
      if (output) {
        const { cssContentSize: size } = await browser.send(
          "Page.getLayoutMetrics",
        );
        const { data } = await browser.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height: size.height, scale: 1 },
        });
        await writeFile(
          resolve(output, `identity-${width}-${theme}.png`),
          Buffer.from(data, "base64"),
        );
      }
      console.log(
        `${width}/${theme}: centers, wrapping, full IDs, click areas and overflow passed`,
      );
    }
  assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
} finally {
  await browser?.close();
  await server.close();
}
