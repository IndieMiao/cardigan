import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const server = await createServer({
  root: resolve("apps/web"),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "pm-takeover-fixture",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__takeover")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              "/__takeover",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/pm-merge-takeover.tsx"></script></body></html>',
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
  await send("Page.bringToFront");
  const until = async (expression) => {
    const end = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      if (Date.now() >= end)
        assert.fail(
          `${expression}: ${JSON.stringify(await evaluate("({focus:document.activeElement?.outerHTML,dialog:document.querySelector('[role=dialog]')?.outerHTML})"))}`,
        );
      await delay(50);
    }
  };
  const key = async (key, code, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: code,
        modifiers,
        ...(key === "Enter" && type === "keyDown" ? { text: "\r" } : {}),
      });
  };
  const button = (text) =>
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)} && b.getBoundingClientRect().width)`;
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
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
      for (const waiting of [false, true]) {
        const name = `${width}-${theme}-${waiting ? "waiting" : "ready"}`;
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__takeover${waiting ? "?waiting" : ""}#/p/p-1/needs-you`,
        });
        await until(`!!${button("接手处理")}`);
        assert.equal(await evaluate(`!!${button("确认合并")}`), false);
        assert.equal(await evaluate(`!!${button("退回修改")}`), false);
        const entry = await evaluate(
          `(() => { const r=${button("接手处理")}.getBoundingClientRect(); return {width:r.width,height:r.height,pageWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}; })()`,
        );
        assert(entry.width >= 44 && entry.height >= 44);
        assert.equal(entry.pageWidth, entry.scrollWidth);
        await evaluate("document.fonts.ready");
        await evaluate(`${button("接手处理")}.focus()`);
        await key("Enter", 13);
        await until(
          "!!document.querySelector('[role=dialog]') && document.activeElement.textContent==='取消'",
        );
        const metrics = await evaluate(`(() => {
        const d = document.querySelector('[role=dialog]');
        const box = e => e.getBoundingClientRect().toJSON();
        const style = getComputedStyle(d);
        const lum = color => { const c = color.match(/[\\d.]+/g).slice(0,3).map(Number).map(v => {v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return c[0]*.2126+c[1]*.7152+c[2]*.0722; };
        const bg = lum(style.backgroundColor);
        const contrast = e => {const fg=lum(getComputedStyle(e).color);return (Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05)};
        return {pageWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,dialog:box(d),dialogWidth:d.clientWidth,dialogScrollWidth:d.scrollWidth,buttons:[...d.querySelectorAll('button')].map(e=>({text:e.textContent,box:box(e)})),contrasts:[...d.querySelectorAll('p')].map(e=>({text:e.textContent,ratio:contrast(e)})),waiting:!!d.querySelector('[role=status]')};
      })()`);
        assert.equal(metrics.pageWidth, metrics.scrollWidth, name);
        assert.equal(metrics.dialogWidth, metrics.dialogScrollWidth, name);
        assert.equal(metrics.waiting, waiting, name);
        assert(
          metrics.dialog.x >= 0 &&
            metrics.dialog.y >= 0 &&
            metrics.dialog.right <= width &&
            metrics.dialog.bottom <= height,
          name,
        );
        for (const b of metrics.buttons)
          assert(b.box.width >= 44 && b.box.height >= 44, name);
        for (const p of metrics.contrasts) assert(p.ratio >= 4.5, name);
        measurements.push({ name, entry, ...metrics });
        await shot(`${name}-dialog`);
        // Tab and Shift+Tab wrap inside the modal; Escape restores the entry.
        await evaluate(`${button("确认接手")}.focus()`);
        await key("Tab", 9);
        assert.equal(
          await evaluate("document.activeElement.getAttribute('aria-label')"),
          "关闭接手确认",
        );
        await key("Tab", 9, 8);
        assert.equal(
          await evaluate("document.activeElement.textContent"),
          "确认接手",
        );
        await key("Escape", 27);
        await until("document.activeElement.textContent==='接手处理'");
        assert.equal(await evaluate("takeoverFixture.calls.length"), 0);
        // A real touch input opens and accepts the confirmation on the narrow view.
        const activate = async (text) => {
          if (width !== 390) return evaluate(`${button(text)}.click()`);
          const point = await evaluate(
            `(() => {const e=${button(text)};e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
          );
          await send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [point],
          });
          await send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
        };
        await activate("接手处理");
        await until("!!document.querySelector('[role=dialog]')");
        await activate("确认接手");
        await until("!document.querySelector('[role=dialog]')");
        assert.equal(await evaluate(`${button("确认合并")}.disabled`), waiting);
        assert.equal(await evaluate("takeoverFixture.calls.length"), 0);
        if (!waiting) {
          await activate("确认合并");
          await evaluate(`${button("确认合并")}.click()`);
          assert.equal(await evaluate("takeoverFixture.calls.length"), 1);
          assert.equal(await evaluate(`${button("确认合并")}.disabled`), true);
          await evaluate("takeoverFixture.finish(false)");
          await until("!!document.querySelector('[role=alert]')");
          await shot(`${name}-failure`);
        }
      }
    }
  assert.deepEqual(browser.errors, []);
  await writeFile(
    resolve(output, "measurements.json"),
    JSON.stringify(
      {
        sha: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        dirty: !!execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
        }).trim(),
        source: "Existing fakeClient plus pm-merge-takeover.tsx",
        seed: "c312-takeover-v1",
        cards: 1,
        decisions: 1,
        events: 0,
        scale: "non-production",
        measurements,
      },
      null,
      2,
    ),
  );
  console.log(
    `Passed ${measurements.length} layouts and keyboard/touch/feedback checks; evidence: ${output}`,
  );
} finally {
  await browser?.close();
  await server.close();
}
