import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = resolve(process.argv[2] ?? "build/execution-migration");
const stage = process.argv[3] ?? "after";
const crowded = process.argv.includes("--crowded");
const modes = crowded
  ? [
      "table",
      "groups",
      "machine-groups",
      "cards",
      "machine-cards",
      "machine-filter",
      "reference",
    ]
  : ["table", "groups", "cards", "reference", "detail"];
const axe = process.env.AXE_PATH
  ? await readFile(process.env.AXE_PATH, "utf8")
  : null;
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  cacheDir: resolve(output, ".vite-cache"),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "execution-migration-fixture",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__execution_migration")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__execution_migration",
              '<!doctype html><html lang="zh-CN"><head><title>执行视图合成验证</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/execution-migration-fixture.tsx"></script></body></html>',
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
let browserVersion;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium({
    args: [
      "--run-all-compositor-stages-before-draw",
      "--disable-new-content-rendering-timeout",
      "--disable-threaded-animation",
      "--disable-threaded-scrolling",
      "--disable-partial-raster",
      "--disable-gpu",
      "--disable-skia-runtime-opts",
      "--force-color-profile=srgb",
      "--num-raster-threads=1",
    ],
  });
  const { send, evaluate } = browser;
  browserVersion = await send("Browser.getVersion");
  const until = async (expression) => {
    const deadline = Date.now() + 15000;
    while (!(await evaluate(expression).catch(() => false))) {
      assert(Date.now() < deadline, expression);
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
        text:
          type === "keyDown"
            ? key === "Enter"
              ? "\r"
              : key === " "
                ? " "
                : ""
            : "",
        modifiers,
      });
    await delay(60);
  };
  const button = (name) =>
    `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(name)} || b.textContent.trim() === ${JSON.stringify(name)})`;
  const activate = async (name) => {
    await evaluate(`${button(name)}.focus()`);
    await key("Enter", 13);
  };
  const menuItem = async (name) => {
    await activate("显示");
    await until("!!document.querySelector('[role=menu]')");
    await evaluate(
      `[...document.querySelectorAll('[role=menuitemcheckbox]')].find(e=>e.textContent.trim()===${JSON.stringify(name)}).focus()`,
    );
    await key(" ", 32);
    await key("Escape", 27);
    await until("!document.querySelector('[role=menu]')");
  };
  const actionBox = () =>
    evaluate(
      `(() => {const r=document.querySelector('.ui-filter-row > .ui-action-row').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right};})()`,
    );
  const screenshot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
    });
    await writeFile(
      resolve(output, `${stage}-${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: width === 390,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      for (const mode of modes) {
        await send("Page.navigate", { url: "about:blank" });
        await until("document.URL === 'about:blank'");
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__execution_migration${crowded ? "?crowded" : ""}#/p/p-1/execution${crowded ? "" : "?view=all"}`,
        });
        await until("!!document.querySelector('.execution-open')");
        await evaluate(
          `localStorage.setItem('cardigan.execution.display.p-1', JSON.stringify({mode:'${mode.includes("cards") ? "cards" : "table"}', grouped:${mode.includes("groups")}, groupBy:'${mode.startsWith("machine") ? "machine" : "employee"}'}))`,
        );
        await send("Page.reload");
        await delay(500);
        await until("!!document.querySelector('.execution-open')");
        if (mode === "reference" || mode === "detail") {
          await evaluate(
            `location.hash = '#/p/p-1/${mode === "detail" ? "cards/C-1" : "cards?view=list"}'`,
          );
          await until(
            mode === "detail"
              ? "!!document.querySelector('.card-page')"
              : "!!document.querySelector('.card-table')",
          );
        }
        if (mode === "machine-filter") {
          await evaluate("location.hash = '#/p/p-1/execution?machine=worker'");
          await until(
            "!!document.querySelector('[aria-label=\"机器：synthetic-machine\"]')",
          );
        }
        await evaluate("document.fonts.ready.then(() => true)");
        await delay(200);
        const metrics = await evaluate(`(() => {
        const box = s => { const e=document.querySelector(s); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,width:r.width,height:r.height}; };
        const capacityText = [...document.querySelectorAll('.capacity-wide,.capacity-compact')].find(e=>e.getClientRects().length);
        const textRects = capacityText ? (()=>{const range=document.createRange();range.selectNodeContents(capacityText);return [...range.getClientRects()].map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom}));})() : [];
        return { scrollWidth:document.documentElement.scrollWidth, innerWidth, capacityBox:box('.capacity-status'), capacityText:capacityText?.textContent, capacityTextRects:textRects, count:document.querySelector('.ui-page-count')?.textContent, overflow:document.documentElement.scrollWidth > innerWidth, header:box('.ui-page-header'), filter:box('.ui-filter-row'), actions:box('.ui-filter-row > .ui-action-row'), capacity:document.querySelector('.capacity-status')?.textContent,
          controls:[...document.querySelectorAll('.ui-filter-row button')].filter(e=>e.getClientRects().length).map(e=>({name:e.getAttribute('aria-label')||e.textContent,height:e.getBoundingClientRect().height})),
          ids:[...document.querySelectorAll('[data-ui="id-badge"]')].filter(e=>e.getClientRects().length).map(e=>e.getBoundingClientRect().height),
          title:document.querySelector('.ui-page-header h1') ? getComputedStyle(document.querySelector('.ui-page-header h1')).fontSize : null,
          typography:[...document.querySelectorAll('.ui-page-header h1,.ui-table-head,.ui-table-cell,.employee-avatar,.ui-filter-row svg')].slice(0,35).map(e=>{const s=getComputedStyle(e);return {selector:e.className?.baseVal ?? e.className,fontSize:s.fontSize,lineHeight:s.lineHeight,padding:s.padding,verticalAlign:s.verticalAlign,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height};}),
          toolbarOverlap:(() => {const boxes=[...document.querySelectorAll('.ui-filter-row button,.ui-filter-row input[type=search]')].filter(e=>e.getClientRects().length).map(e=>e.getBoundingClientRect()); return boxes.some((a,i)=>boxes.some((b,j)=>i<j && Math.min(a.right,b.right)>Math.max(a.left,b.left) && Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)));})(),
          taskTitles:[...document.querySelectorAll('.execution-task-title')].map(e=>{const r=e.getBoundingClientRect(),style=getComputedStyle(e),row=e.closest('tr');return {text:e.textContent,height:r.height,minHeight:style.minHeight,paddingTop:style.paddingTop,paddingBottom:style.paddingBottom,inTable:!!row,rowHeight:row?.getBoundingClientRect().height??null};}) };
      })()`);
        if (axe) {
          await evaluate(axe);
          metrics.axe = await evaluate(
            "axe.run(document, {runOnly:{type:'tag', values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}).then(r=>r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})))",
          );
        }
        records.push({ mode, width, theme, ...metrics });
        if (stage === "after") {
          assert(!metrics.toolbarOverlap, `${mode}: toolbar overlaps`);
          assert(!metrics.overflow, `${mode} ${width} ${theme}: overflow`);
          if (metrics.capacityBox)
            assert.equal(
              metrics.capacityBox.right,
              metrics.header.right,
              `${mode}: wrapped capacity stays right aligned`,
            );
          assert(
            metrics.capacityTextRects.every(
              (r) =>
                r.left >= metrics.capacityBox.x &&
                r.right <= metrics.capacityBox.right &&
                r.top >= metrics.capacityBox.y &&
                r.bottom <= metrics.capacityBox.y + metrics.capacityBox.height,
            ),
            `${mode}: capacity text must fit its button`,
          );
          if (crowded && mode !== "reference") {
            assert(
              metrics.capacityText.includes("synthetic-machine") &&
                metrics.capacityText.includes("cardigan-ci"),
              "all machines remain visible",
            );
            assert.equal(
              metrics.count,
              mode === "machine-filter" ? "136 / 701" : "409 / 701",
            );
          }
          assert(
            metrics.controls.every((c) => c.height === 28),
            `${mode}: toolbar control size`,
          );
          if (axe) assert.deepEqual(metrics.axe, [], `${mode}: axe`);
          for (const title of metrics.taskTitles) {
            assert.equal(
              title.minHeight,
              title.inTable ? "28px" : "0px",
              `${mode}: task title minimum height`,
            );
            assert.equal(
              title.paddingTop,
              title.inTable ? "4px" : "0px",
              `${mode}: task title top spacing`,
            );
            assert.equal(
              title.paddingBottom,
              title.inTable ? "4px" : "0px",
              `${mode}: task title bottom spacing`,
            );
            if (title.inTable)
              assert.equal(
                title.height,
                28,
                `${mode}: single-line fixture title height`,
              );
          }
        }
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          resolve(output, `${stage}-${mode}-${theme}-${width}.png`),
          Buffer.from(data, "base64"),
        );
      }
      if (stage === "after" && !crowded) {
        await evaluate(
          "localStorage.removeItem('cardigan.execution.display.p-1');location.hash='#/p/p-1/execution?view=all'",
        );
        await until(
          "document.querySelectorAll('.execution-open').length === 8",
        );
        await evaluate("scrollTo(0,0)");
        const before = await actionBox();
        await menuItem("分组字段：机器");
        const grouped = await actionBox();
        await until(
          "!!document.querySelector('button[aria-label=折叠local分组]')",
        );
        await activate("折叠local分组");
        await until(
          "!!document.querySelector('button[aria-label=展开local分组]')",
        );
        assert.equal(
          await evaluate(
            "[...document.querySelectorAll('.execution-open')].filter(e=>e.getClientRects().length).length",
          ),
          4,
        );
        await activate("展开local分组");
        await screenshot(`machine-groups-${theme}-${width}`);
        await activate("卡片");
        await until("!!document.querySelector('[aria-label=机器泳道]')");
        const cards = await actionBox();
        assert.deepEqual(grouped, before, "grouping must not move actions");
        assert.deepEqual(cards, before, "mode switch must not move actions");
        assert(
          await evaluate(
            "[...document.querySelectorAll('.execution-card')].every(e=>e.querySelector('.employee-identity'))",
          ),
          "machine lanes preserve each employee identity",
        );
        await screenshot(`machine-cards-${theme}-${width}`);
        await evaluate(
          "document.querySelector('button[aria-label=\"机器：全部\"]').focus()",
        );
        await key("ArrowDown", 40);
        await until(
          "!!document.querySelector('[role=option][data-value=worker]')",
        );
        await screenshot(`machine-filter-${theme}-${width}`);
        await evaluate(
          "document.querySelector('[role=option][data-value=worker]').focus()",
        );
        await key("Enter", 13);
        await until(
          "document.querySelectorAll('.execution-open').length === 4",
        );
        assert.equal(
          await evaluate("!!document.querySelector('[aria-label=local泳道]')"),
          false,
        );
        await activate("移除机器筛选");
        await until(
          "document.querySelectorAll('.execution-open').length === 8",
        );
        await activate("表格");
        await until("!document.querySelector('[aria-label=机器泳道]')");
        const status =
          "document.querySelector('button[aria-label=\"A-2 状态详情\"]')";
        const point = await evaluate(
          `(() => {const e=${status};e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
        );
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
        });
        await until(
          "[...document.querySelectorAll('[role=tooltip]')].some(e=>e.textContent.includes('等待机器并发名额'))",
        );
        const hover = await evaluate(
          "document.querySelector('[role=tooltip]').textContent",
        );
        assert(hover.includes("超过 30 分钟"));
        await screenshot(`status-hover-${theme}-${width}`);
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 1,
          y: 1,
        });
        await key("Escape", 27);
        await evaluate(
          `(() => {const target=${status};const nodes=[...document.querySelectorAll('a[href],button,[tabindex="0"]')].filter(e=>e.getClientRects().length);nodes[nodes.indexOf(target)-1].focus();})()`,
        );
        await key("Tab", 9);
        await until(
          "document.activeElement?.getAttribute('aria-label') === 'A-2 状态详情' && !!document.querySelector('[role=tooltip]')",
        );
        const focused = await evaluate(
          "document.querySelector('[role=tooltip]').textContent",
        );
        assert.equal(
          focused,
          hover,
          "keyboard and mouse expose the same details",
        );
        await key("Escape", 27);
        assert.equal(
          await evaluate("document.activeElement.getAttribute('aria-label')"),
          "A-2 状态详情",
        );
        await evaluate("document.querySelector('.capacity-status').focus()");
        await until("!!document.querySelector('.capacity-tooltip')");
        const capacity = await evaluate(
          "document.querySelector('.capacity-tooltip').textContent",
        );
        await screenshot(`capacity-${theme}-${width}`);
        assert(
          capacity.includes("local · Agent") &&
            capacity.includes("cardigan-ci · Agent") &&
            capacity.includes("非常驻 3 / 上限 6"),
        );
        await key("Escape", 27);
        await activate("查看 A-2 详情");
        await until(
          "!!document.querySelector('[role=dialog] [aria-label=\"机器：cardigan-ci\"]')",
        );
        const drawer = await evaluate(
          `(() => { const dl=document.querySelector('.execution-basics'); const value=label=>[...dl.querySelectorAll('dt')].find(e=>e.textContent===label).nextElementSibling; const machine=value('机器'),terminal=value('终端'); const range=document.createRange();range.selectNodeContents(machine.firstElementChild);return {machine:machine.textContent.trim(),terminal:terminal.textContent.trim(),valueX:machine.getBoundingClientRect().x,textX:range.getBoundingClientRect().x}; })()`,
        );
        assert.equal(drawer.machine, "cardigan-ci");
        assert.equal(drawer.terminal, "t-1");
        assert.equal(
          drawer.textX,
          drawer.valueX,
          "drawer machine text aligns with its value column",
        );
        await screenshot(`drawer-${theme}-${width}`);
        let violations = null;
        if (axe) {
          await evaluate(axe);
          violations = await evaluate(
            "axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}).then(r=>r.violations.map(v=>v.id))",
          );
          assert.deepEqual(violations, []);
        }
        await key("Escape", 27);
        await until("!document.querySelector('[role=dialog]')");
        assert.equal(
          await evaluate("document.activeElement.getAttribute('aria-label')"),
          "查看 A-2 详情",
        );
        interactions.push({
          width,
          theme,
          before,
          grouped,
          cards,
          filterCount: 4,
          identity: true,
          hover,
          focused,
          capacity,
          drawerFocusReturned: true,
          drawer,
          axe: violations,
        });
      }
    }
  if (stage === "after") {
    for (const r of records.filter((r) =>
      ["table", "groups", "cards"].includes(r.mode),
    )) {
      const reference = records.find(
        (x) =>
          x.mode === "reference" && x.width === r.width && x.theme === r.theme,
      );
      assert.equal(
        r.actions.right,
        reference.actions.right,
        "right edge agrees with cards page",
      );
      if (axe) assert.deepEqual(r.axe, [], "no accessibility violations");
    }
  }
  // Compare equal viewports without resizing either page: execution left, cards right.
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      for (const mode of ["table", "groups", "cards"]) {
        const sources = await Promise.all(
          [mode, "reference"].map(
            async (view) =>
              `data:image/png;base64,${(await readFile(resolve(output, `${stage}-${view}-${theme}-${width}.png`))).toString("base64")}`,
          ),
        );
        const joined = await evaluate(`(async () => {
        const images = await Promise.all(${JSON.stringify(sources)}.map(src => new Promise(resolve => { const image=new Image(); image.onload=()=>resolve(image); image.src=src; })));
        const canvas=document.createElement('canvas'); canvas.width=images[0].width*2; canvas.height=images[0].height;
        const context=canvas.getContext('2d'); images.forEach((image,index)=>context.drawImage(image,index*image.width,0));
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
        await writeFile(
          resolve(output, `${stage}-compare-${mode}-${theme}-${width}.png`),
          Buffer.from(joined, "base64"),
        );
      }
    }
  assert.deepEqual(browser.errors, []);
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
await writeFile(
  resolve(output, `${stage}-measurements.json`),
  `${JSON.stringify(records, null, 2)}\n`,
);
await writeFile(
  resolve(output, `${stage}-environment.json`),
  `${JSON.stringify({ browser: browserVersion, fixture: crowded ? "701 synthetic assignments (409 working) cloned from executionDisplayFixture, 4 runs, 4 cards, 3 machines; focused layout regression, not production data" : "8 assignments, 4 runs, 4 cards, 2 machines; synthetic, not production scale", clock: "2026-11-15T07:47:30Z", dpr: 1, fonts: ["Inter Variable", "Noto Sans SC Variable", "JetBrains Mono Variable"], capture: "viewport only" }, null, 2)}\n`,
);
console.log(`${stage}: ${records.length} screenshots and measurements`);

await writeFile(
  resolve(output, `${stage}-interactions.json`),
  `${JSON.stringify(interactions, null, 2)}\n`,
);
