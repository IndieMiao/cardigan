import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = process.argv[2];
assert(output, "Pass a new output directory");
await mkdir(output, { recursive: false });
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "merge-batch-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__merge_batch")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__merge_batch",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/merge-batch-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const results = {
  fixture:
    "C-391 fixed App/fakeClient fixture; 5 synthetic cards, 1 resolved batch, 2 prefix probes; no production data",
  cases: [],
};
let browser;
try {
  await server.listen();
  browser = await chromium();
  const { send, evaluate } = browser;
  const until = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const point = async (selector) =>
    evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'});
    const r = e.getBoundingClientRect(); const x = r.x+r.width/2, y = r.y+r.height/2;
    return {width:r.width,height:r.height,x,y,hit:e.contains(document.elementFromPoint(x,y)),decoration:getComputedStyle(e).textDecorationLine,border:getComputedStyle(e).borderWidth};
  })()`);
  const click = async (selector) => {
    const p = await point(selector);
    assert(p.hit, `${selector}: hit intercepted`);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: p.x,
      y: p.y,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: p.x,
      y: p.y,
      button: "left",
      clickCount: 1,
    });
    return p;
  };
  const capture = async (name) => {
    await evaluate("document.fonts.ready.then(() => true)");
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
      { flag: "wx" },
    );
  };
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width === 390,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__merge_batch#/p/p-1/cards?view=board`,
      });
      await until("!!document.querySelector('.board-card a.merge-stage')");
      const target = ".board-card a.merge-stage";
      const badge = await point(target);
      assert(badge.width >= 44 && badge.height >= 44);
      assert.equal(badge.decoration, "none");
      assert.equal(badge.border, "0px");
      const waiting = await evaluate(
        `(() => {const e=document.querySelector('[data-batch-id] [data-card-signal="decision"]'); const c=getComputedStyle(e); return {actual:c.color,expected:c.getPropertyValue('--status-wait').trim()};})()`,
      );
      const borderUnchanged = await evaluate(
        `(() => {const e=document.querySelector('[data-batch-id]:has([data-card-signal="decision"])'),s=e.querySelector('[data-card-signal]'),before=getComputedStyle(s).color; e.removeAttribute('data-batch-id'); const after=getComputedStyle(s).color; e.dataset.batchId='MB-7'; return before===after;})()`,
      );
      assert(borderUnchanged);
      await capture(`${width}-${theme}-board`);
      await click(target);
      await until(
        "!!document.querySelector('[role=dialog] .merge-batch-members')",
      );
      assert(await evaluate("location.hash.endsWith('/merge-batches/MB-7')"));
      assert(
        await evaluate(
          "document.querySelector('[role=dialog]').textContent.includes('失败原因') && document.querySelector('[role=dialog]').textContent.includes('已合并前缀')",
        ),
      );
      const close = await point(".merge-batch-drawer button");
      const member = await point(".merge-batch-members a");
      assert(
        close.width >= 44 &&
          close.height >= 44 &&
          member.width >= 44 &&
          member.height >= 44,
      );
      assert.equal(member.decoration, "none");
      assert(
        await evaluate("document.documentElement.scrollWidth <= innerWidth"),
      );
      await capture(`${width}-${theme}-batch`);
      for (let i = 0; i < 5; i++) {
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        assert(
          await evaluate(
            "document.querySelector('[role=dialog]').contains(document.activeElement)",
          ),
        );
      }
      await click(".merge-batch-drawer button");
      await until("!document.querySelector('.merge-batch-drawer')");
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__merge_batch#/p/p-1/merge-batches/MB-7`,
      });
      await until("!!document.querySelector('.merge-batch-members a')");
      await click(".merge-batch-members a");
      await until("!!document.querySelector('[aria-label=批次合并]')");
      const toggle = await point(".merge-solo-toggle");
      assert(toggle.width >= 44 && toggle.height >= 44);
      await click(".merge-solo-toggle");
      await until(
        "document.querySelector('.merge-solo-toggle [role=checkbox]')?.getAttribute('aria-checked') === 'true'",
      );
      await evaluate(
        "document.querySelector('.merge-solo-toggle [role=checkbox]').focus()",
      );
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: " ",
        code: "Space",
        windowsVirtualKeyCode: 32,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: " ",
        code: "Space",
        windowsVirtualKeyCode: 32,
      });
      await until(
        "document.querySelector('.merge-solo-toggle [role=checkbox]')?.getAttribute('aria-checked') === 'false'",
      );
      await capture(`${width}-${theme}-card`);
      results.cases.push({
        width,
        theme,
        badge,
        close,
        member,
        toggle,
        waiting,
        borderUnchanged,
      });
    }
  assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
  await writeFile(
    resolve(output, "measurements.json"),
    JSON.stringify(results, null, 2),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      cases: results.cases.length,
      screenshots: results.cases.length * 3,
      output,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
