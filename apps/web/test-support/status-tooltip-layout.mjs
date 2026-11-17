import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// Focused component/layout regression, using in-memory data and no business API.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "build/status-tooltip-layout");
const axe = process.env.AXE_PATH
  ? await readFile(process.env.AXE_PATH, "utf8")
  : null;
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "status-tooltip-fixture",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__status-tooltip")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__status-tooltip",
              '<!doctype html><html lang="zh-CN"><head><title>状态提示验证</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/status-tooltip-fixture.tsx"></script></body></html>',
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
  async function key(key, code, modifiers = 0) {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: code,
        modifiers,
      });
  }
  const measure = `(() => {
    const tip = document.querySelector('[role=tooltip]');
    const area = tip.querySelector('.ui-tooltip-scrollarea');
    const p = tip.querySelector('.ui-tooltip-details > p:last-child');
    const end = document.createRange();
    end.selectNodeContents(p); end.setStart(p.firstChild, p.firstChild.length - 4);
    const r = tip.getBoundingClientRect(), a = area.getBoundingClientRect(), last = end.getBoundingClientRect();
    return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,
      scrollTop:area.scrollTop,scrollHeight:area.scrollHeight,clientHeight:area.clientHeight,
      lastText:end.toString(),lastTop:last.top,lastBottom:last.bottom,
      areaTop:a.top,areaBottom:a.bottom,pageTop:scrollY,
      paragraphs:[...tip.querySelectorAll('.ui-tooltip-details > p')].map(p => p.textContent),
      inset:parseFloat(getComputedStyle(tip).getPropertyValue('--ui-space-2')),
      focus:document.activeElement === window.testTrigger};
  })()`;
  for (const width of [390, 1440]) {
    const height = width === 1440 ? 900 : 844;
    for (const theme of ["light", "dark"]) {
      for (const view of ["isolated", "board", "list"]) {
        for (const repeat of [1, 24, 60]) {
          const name = `${view}-${theme}-${width}-${repeat}`;
          console.log(name);
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
            url: `${server.resolvedUrls.local[0]}__status-tooltip?repeat=${repeat}&view=${view}#/p/p-1/cards?view=${view === "list" ? "list" : "board"}`,
          });
          await until("!!document.querySelector('.card-hold-tag')");
          await evaluate("document.fonts.ready");
          await evaluate(
            "document.querySelectorAll('.board-held').forEach(e => { e.open = true; })",
          );
          const alignment =
            view === "list"
              ? await evaluate(`(() => {
            const hold = document.querySelector('.card-hold-tag');
            const status = hold.closest('td').querySelector('[data-card-status-tip]');
            const a = hold.getBoundingClientRect(), b = status.getBoundingClientRect();
            return {hold:a.y + a.height / 2,status:b.y + b.height / 2};
          })()`)
              : null;
          if (alignment)
            assert(
              Math.abs(alignment.hold - alignment.status) <= 1,
              `${name}: status tags are misaligned`,
            );
          for (const selector of [".card-hold-tag", "[data-card-status-tip]"]) {
            const hold = selector === ".card-hold-tag";
            await evaluate(`window.testTrigger = document.querySelector('${selector}');
              testTrigger.scrollIntoView({block:'center'}); testTrigger.focus();`);
            await until("!!document.querySelector('[role=tooltip]')");
            await delay(100);
            const start = await evaluate(measure);
            assert(
              start.top >= start.inset - 1 &&
                start.bottom <= height - start.inset + 1,
              `${name}: vertical bounds ${JSON.stringify(start)}`,
            );
            assert(
              start.left >= start.inset - 1 &&
                start.right <= width - start.inset + 1,
              `${name}: horizontal bounds`,
            );
            assert.equal(start.lastText, hold ? "恢复末尾" : "原因末尾");
            const reason = `${"等待完整验收记录。".repeat(repeat)}原因末尾`;
            const condition = `${"全部核对通过后恢复。".repeat(repeat)}恢复末尾`;
            assert.deepEqual(
              start.paragraphs,
              hold
                ? [`原因：${reason}`, `恢复条件：${condition}`]
                : [`已暂停：${reason}`],
              `${name}: truncated or duplicated summary`,
            );
            const overflowing = start.scrollHeight > start.clientHeight;
            if (overflowing) {
              await key("PageDown", 34);
              assert(
                (await evaluate(measure)).scrollTop > 0,
                `${name}: PageDown`,
              );
              await key("PageUp", 33);
              assert.equal((await evaluate(measure)).scrollTop, 0);
              await key("ArrowDown", 40);
              assert((await evaluate(measure)).scrollTop > 0);
              await key("ArrowUp", 38);
              assert.equal((await evaluate(measure)).scrollTop, 0);
            }
            await key("End", 35);
            const end = await evaluate(measure);
            assert(
              end.lastTop >= end.areaTop - 1 &&
                end.lastBottom <= end.areaBottom + 1,
              `${name}: last text remains inaccessible ${JSON.stringify(end)}`,
            );
            assert(end.focus, `${name}: keyboard scrolling moved focus`);
            if (overflowing) assert.equal(end.pageTop, start.pageTop);
            await key("Escape", 27);
            await until("!document.querySelector('[role=tooltip]')");
            assert(await evaluate("document.activeElement === testTrigger"));
            // A genuine Tab focus opens the tooltip again; it starts at the top.
            await evaluate(
              "testTrigger.blur(); document.body.tabIndex = -1; document.body.focus()",
            );
            for (let i = 0; i < 80; i++) {
              await key("Tab", 9);
              if (await evaluate("document.activeElement === testTrigger"))
                break;
            }
            assert(
              await evaluate("document.activeElement === testTrigger"),
              `${name}: unreachable via Tab`,
            );
            await until("!!document.querySelector('[role=tooltip]')");
            assert.equal((await evaluate(measure)).scrollTop, 0);
            const tipId = await evaluate(
              "document.querySelector('[role=tooltip]').id",
            );
            await key("Tab", 9);
            const contentFocused = await evaluate(
              "document.activeElement.matches('.ui-tooltip-scrollarea')",
            );
            if (overflowing) assert(contentFocused);
            if (contentFocused) {
              await key("End", 35);
              await until(
                `(() => { const m = ${measure}; return m.lastBottom <= m.areaBottom + 1; })()`,
              );
              await key("Escape", 27);
              await until("!document.querySelector('[role=tooltip]')");
              assert(await evaluate("document.activeElement === testTrigger"));
              if (overflowing) {
                await evaluate("testTrigger.blur(); testTrigger.focus()");
                await until("!!document.querySelector('[role=tooltip]')");
                await key("Tab", 9);
                await key("Tab", 9, 1);
                assert(
                  await evaluate("document.activeElement === testTrigger"),
                );
                await key("Tab", 9);
                await key("Tab", 9);
              }
            }
            await until(`!document.getElementById(${JSON.stringify(tipId)})`);
            // Hover and transit to the scroll area must keep it open for wheel input.
            await evaluate(
              "document.activeElement.blur(); testTrigger.scrollIntoView({block:'center'})",
            );
            const anchor = await evaluate(
              "(() => {const r = testTrigger.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()",
            );
            await send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...anchor,
            });
            await until("!!document.querySelector('[role=tooltip]')");
            const target = await evaluate(
              "(() => {const r = document.querySelector('.ui-tooltip-scrollarea').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()",
            );
            await send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...target,
            });
            await send("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              ...target,
              deltaY: 10000,
              deltaX: 0,
            });
            await until(
              `(() => { const m = ${measure}; return m.lastBottom <= m.areaBottom + 1; })()`,
            );
            const wheel = await evaluate(measure);
            assert(
              wheel.lastBottom <= wheel.areaBottom + 1 &&
                wheel.lastTop >= wheel.areaTop - 1,
              `${name}: wheel cannot reach last text`,
            );
            let violations = null;
            if (axe) {
              await evaluate(axe);
              violations = await evaluate(
                "axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}).then(r => r.violations.map(v => ({id:v.id,nodes:v.nodes.map(n => n.target)})))",
              );
              assert.deepEqual(violations, [], `${name}: axe`);
            }
            if (hold) {
              const { data } = await send("Page.captureScreenshot", {
                format: "png",
              });
              await writeFile(
                resolve(output, `${name}.png`),
                Buffer.from(data, "base64"),
              );
            }
            records.push({
              name,
              selector,
              start,
              end,
              wheel,
              violations,
              alignment,
              height,
            });
            await key("Escape", 27);
            await until("!document.querySelector('[role=tooltip]')");
            await send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: 0,
              y: 0,
            });
          }
        }
      }
    }
  }
  assert.deepEqual(browser.errors, []);
  await writeFile(
    resolve(output, "measurements.json"),
    JSON.stringify({ records, errors: browser.errors }, null, 2),
  );
  console.log(
    `${records.length} tooltip layouts passed; keyboard, hover, wheel, Escape${axe ? ", axe" : ""}.`,
  );
} finally {
  await browser?.close();
  await server.close();
}
