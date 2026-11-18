import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = resolve(process.argv[2] ?? "build/execution-toolbar");
const stage = process.argv[3] ?? "after";
assert(["before", "after"].includes(stage));
const baseline = "73c3a1ba2b26d976eca1fd1652f1bbced110e254";
const source = "apps/web/src/views/ExecutionPage.tsx";
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "execution-toolbar-fixture",
      enforce: "pre",
      transform(_code, id) {
        if (stage === "before" && id.endsWith(source))
          return execFileSync("git", ["show", `${baseline}:${source}`], {
            encoding: "utf8",
          });
      },
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__toolbar")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__toolbar",
              '<!doctype html><html lang="zh-CN"><head><title>执行工具组合成验证</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/execution-migration-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
const records = [];
const interactions = [];
const switched = [];
const check = (m) => {
  assert(!m.overflow, "page must not overflow");
  assert(!m.wrapped, "toolbar controls remain on one line");
  assert.deepEqual(m.gaps, [8, 8, 0], "shared spacing matches cards page");
  for (const c of m.controls) {
    assert(c.hit, `${c.name}: center is not covered`);
    assert(c.x >= 0 && c.right <= m.actions.right, `${c.name}: inside toolbar`);
    assert(c.text.x >= c.x && c.text.right <= c.right, `${c.name}: text fits`);
    assert.equal(c.height, 28, `${c.name}: shared control height`);
  }
};
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium();
  const { send, evaluate } = browser;
  const until = async (expression) => {
    const deadline = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < deadline, expression);
      await delay(50);
    }
  };
  const measure = () =>
    evaluate(`(() => {
    const row = document.querySelector('.ui-filter-row > .ui-action-row');
    const refresh = row.querySelector('.ui-refresh-controls');
    const buttons = [...row.querySelectorAll('button')];
    const box = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const controls = buttons.map(e => {
      const r=box(e), range=document.createRange();
      range.selectNodeContents(e);
      const text=box(range);
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {name:e.getAttribute('aria-label')||e.textContent.trim(),...r,text,hit:!!hit && e.contains(hit)};
    });
    return {actions:box(row),refresh:box(refresh),controls,
      gaps:controls.slice(1).map((c,i)=>c.x-controls[i].right),
      wrapped:controls.some(c=>c.y!==controls[0].y),
      overflow:document.documentElement.scrollWidth>innerWidth,
      refreshStyle:{width:getComputedStyle(refresh).width,flexShrink:getComputedStyle(refresh).flexShrink},
      children:[...refresh.children].map(e=>({tag:e.tagName,position:getComputedStyle(e).position,width:getComputedStyle(e).width,...box(e)}))};
  })()`);
  const key = async (key, code) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: code,
      });
  };
  const choose = async (value) => {
    await evaluate("document.querySelector('[aria-label=自动刷新]').focus()");
    await key("ArrowDown", 40);
    await until(
      `!!document.querySelector('[role=option][data-value="${value}"]')`,
    );
    await evaluate(
      `document.querySelector('[role=option][data-value="${value}"]').focus()`,
    );
    await key("Enter", 13);
    await until("!document.querySelector('[role=listbox]')");
    await delay(50);
  };
  const click = async (name) => {
    const point = await evaluate(`(() => {
      const e=[...document.querySelectorAll('.ui-action-row button')].find(e=>(e.getAttribute('aria-label')||e.textContent.trim())===${JSON.stringify(name)});
      e.dataset.clicked='false';e.addEventListener('click',()=>e.dataset.clicked='true',{once:true});
      const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
    await until(
      `!![...document.querySelectorAll('.ui-action-row button')].find(e=>(e.getAttribute('aria-label')||e.textContent.trim())===${JSON.stringify(name)} && e.dataset.clicked==='true')`,
    );
  };
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  for (const width of [1440, 390]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width === 390,
    });
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__toolbar#/p/p-1/execution?view=all`,
      });
      await until("document.querySelectorAll('.execution-open').length===8");
      for (const mode of ["table", "groups", "cards", "reference"]) {
        await evaluate(
          `localStorage.setItem('cardigan.execution.display.p-1',JSON.stringify({mode:'${mode === "cards" ? "cards" : "table"}',grouped:${mode === "groups"}}));location.hash='#/p/p-1/${mode === "reference" ? "cards?view=list" : "execution?view=all"}'`,
        );
        await send("Page.reload");
        await delay(500);
        await until(
          mode === "reference"
            ? "!!document.querySelector('.card-table')"
            : "document.querySelectorAll('.execution-open').length===8",
        );
        await evaluate("document.fonts.ready.then(()=>true)");
        await choose(0);
        await delay(150);
        const metrics = await measure();
        if (stage === "after") check(metrics);
        records.push({ width, theme, mode, ...metrics });
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          resolve(output, `${stage}-${mode}-${theme}-${width}.png`),
          Buffer.from(data, "base64"),
        );
        for (const value of [10000, 30000, 60000, 300000, 0]) {
          await choose(value);
          const measurement = await measure();
          if (stage === "after") check(measurement);
          interactions.push({ width, theme, mode, value, ...measurement });
          if (value === 300000) {
            const { data } = await send("Page.captureScreenshot", {
              format: "png",
            });
            await writeFile(
              resolve(output, `${stage}-${mode}-${theme}-${width}-5min.png`),
              Buffer.from(data, "base64"),
            );
          }
        }
        await click("立即刷新");
        for (const name of mode === "reference"
          ? ["看板", "列表"]
          : ["卡片", "表格"]) {
          await click(name);
          await until(
            `document.querySelector('.ui-action-row [aria-label="${name}"]').getAttribute('aria-pressed')==='true'`,
          );
          const measurement = await measure();
          if (stage === "after") check(measurement);
          switched.push({ width, theme, mode, name, ...measurement });
        }
      }
    }
  }
  assert.deepEqual(browser.errors, []);
  if (stage === "after") {
    for (const r of [...records, ...interactions]) {
      const reference = (r.value === undefined ? records : interactions).find(
        (x) =>
          x.mode === "reference" &&
          x.width === r.width &&
          x.theme === r.theme &&
          x.value === r.value,
      );
      assert.deepEqual(r.gaps, reference.gaps, "measured card page spacing");
      assert.equal(
        r.actions.right,
        reference.actions.right,
        "aligned right edge",
      );
    }
  }
} finally {
  await browser?.close();
  await server.close();
  await writeFile(
    resolve(output, `${stage}-measurements.json`),
    `${JSON.stringify({ baseline, head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), stage, records, interactions, switched }, null, 2)}\n`,
  );
}
console.log(`${stage}: ${records.length} screenshots and measurements`);
