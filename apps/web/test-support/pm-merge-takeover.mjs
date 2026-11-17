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
  const shot = async (name, full = false) => {
    const { cssContentSize } = await send("Page.getLayoutMetrics");
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      ...(full
        ? {
            captureBeyondViewport: true,
            clip: {
              x: 0,
              y: 0,
              width: cssContentSize.width,
              height: Math.ceil(cssContentSize.height),
              scale: 1,
            },
          }
        : {}),
    });
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
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__takeover?tabs#/p/p-1/needs-you`,
      });
      await until(
        "document.querySelector('[role=tab][aria-selected=true]')?.textContent.startsWith('待拍板') && takeoverFixture.reads.includes('decisions')",
      );
      assert.deepEqual(await evaluate("takeoverFixture.reads"), [
        "counts",
        "decisions",
      ]);
      const tabButton = (label) =>
        `[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.startsWith(${JSON.stringify(label)}))`;
      for (const [section, label] of [
        ["decisions", "待拍板"],
        ["merges", "合并确认"],
        ["actions", "待你执行"],
        ["later", "稍后"],
        ["notices", "知会"],
      ]) {
        const target = tabButton(label);
        if (width === 390) {
          const point = await evaluate(
            `(() => {const e=${target};e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
          );
          await send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [point],
          });
          await send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
        } else await evaluate(`${target}.click()`);
        await until(
          `takeoverFixture.reads.includes(${JSON.stringify(section)}) && ${target}.getAttribute('aria-selected')==='true'`,
        );
        await evaluate(
          "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
        );
        const metric = await evaluate(`(() => {
          const panel=document.querySelector('[role=tabpanel]:not([hidden])');
          const lum=c=>{const v=c.match(/[\\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return v[0]*.2126+v[1]*.7152+v[2]*.0722};
          const background=e=>{for(let p=e;p;p=p.parentElement){const c=getComputedStyle(p).backgroundColor;if(c!=='rgba(0, 0, 0, 0)' && c!=='transparent')return c;}return 'rgb(255,255,255)'};
          return {kind:'tab',section:${JSON.stringify(section)},pageWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,
            buttons:[...document.querySelectorAll('[role=tab]'),...panel.querySelectorAll('button,summary,.id-tag,.needs-notices footer a,.needs-later a,.needs-option')].filter(e=>e.getBoundingClientRect().width).map(e=>({text:e.textContent,box:e.getBoundingClientRect().toJSON()})),
            contrasts:[...panel.querySelectorAll('p')].filter(e=>e.getBoundingClientRect().width).map(e=>{const a=lum(getComputedStyle(e).color),b=lum(background(e));return {text:e.textContent,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}})};
        })()`);
        const name = `${width}-${theme}-tab-${section}`;
        assert.equal(metric.pageWidth, metric.scrollWidth, name);
        const tabLayout = await evaluate(`(() => {
          const tabs=[...document.querySelectorAll('[role=tab]')];
          return tabs.map(e=>({top:e.getBoundingClientRect().top,
            direction:getComputedStyle(e).flexDirection}));
        })()`);
        assert.equal(
          new Set(tabLayout.map((t) => t.top)).size,
          1,
          `${name}: single row`,
        );
        if (width === 390)
          assert(
            tabLayout.every((t) => t.direction === "column"),
            `${name}: stacked counts`,
          );
        assert.notEqual(
          await evaluate(`getComputedStyle(${target}).boxShadow`),
          "none",
          `${name}: selected tab`,
        );
        assert(
          await evaluate(
            "[...document.querySelectorAll('[role=tab][aria-selected=false]')].every(b=>getComputedStyle(b).boxShadow==='none')",
          ),
        );
        for (const b of metric.buttons)
          assert(b.box.width >= 44 && b.box.height >= 44, `${name}: ${b.text}`);
        for (const p of metric.contrasts)
          assert(p.ratio >= 4.5, `${name}: contrast`);
        measurements.push({ name, ...metric });
        await evaluate("window.scrollTo(0,0)");
        await shot(name, true);
      }
      assert.deepEqual(await evaluate("takeoverFixture.reads"), [
        "counts",
        "decisions",
        "merges",
        "actions",
        "later",
        "notices",
      ]);
      for (const label of ["自动合并（auto_merge）", "超时自动合并", "系统"])
        assert(
          await evaluate(
            `document.querySelector('[role=tabpanel]:not([hidden])').textContent.includes(${JSON.stringify(label)})`,
          ),
        );
      await evaluate(`${tabButton("知会")}.focus()`);
      await key("Home", 36);
      assert(
        await evaluate(
          `${tabButton("待拍板")}.getAttribute('aria-selected')==='true'`,
        ),
      );
      await evaluate(`${tabButton("待你执行")}.click()`);
      await until("!!document.querySelector('[aria-label=\"H-1 执行结果\"]')");
      await evaluate(
        "document.querySelector('[aria-label=\"H-1 执行结果\"]').focus()",
      );
      await send("Input.insertText", { text: "合成验证已完成" });
      await evaluate(`${button("确认已完成")}.click()`);
      await until(
        `${tabButton("待你执行")}.querySelector('.needs-tab-count').textContent==='0' && document.querySelector('[role=tabpanel]:not([hidden])').textContent.includes('没有需要你处理的事')`,
      );
      await evaluate("window.scrollTo(0,0)");
      await shot(`${width}-${theme}-tab-empty`, true);
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
        seed: "c312-takeover-v1 / c312-tabs-v1",
        cards: 1,
        decisions: 1,
        events: 0,
        tab_fixture: {
          cards: 1,
          decisions: 2,
          human_actions: 1,
          later: 1,
          notice_projections: 5,
          persisted_events: 0,
        },
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
