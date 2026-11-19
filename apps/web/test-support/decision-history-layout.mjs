import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-457: decision history before/after screenshots, measurements and the
// same-width/same-theme comparison with the cards page (synthetic data only).
const output = resolve(process.argv[2] ?? "build/decision-history");
const stage = process.argv[3] ?? "after";
const after = stage === "after";
const modes = [
  "list",
  "detail",
  ...(after ? ["filter"] : []),
  "empty",
  "reference",
  "reference-detail",
];
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  cacheDir: resolve(output, ".vite-cache"),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "decision-history-fixture",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__decision_history")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__decision_history",
              '<!doctype html><html lang="zh-CN"><head><title>拍板记录合成验证</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/decision-history-fixture.tsx"></script></body></html>',
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
  const key = async (key, code) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: code,
        text: type === "keyDown" && key === "Enter" ? "\r" : "",
      });
    await delay(80);
  };
  const settle = async () => {
    await evaluate("document.fonts.ready.then(() => true)");
    await evaluate(
      "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))",
    );
    await delay(200);
  };
  const screenshot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      resolve(output, `${stage}-${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
  const base = `${server.resolvedUrls.local[0]}__decision_history`;
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
        const reference = mode.startsWith("reference");
        await send("Page.navigate", { url: "about:blank" });
        await until("document.URL === 'about:blank'");
        await send("Page.navigate", {
          url: `${base}${mode === "empty" ? "?empty" : ""}#/p/p-1/${reference ? `cards?view=list${mode === "reference-detail" ? "&card=C-2" : ""}` : "decision-history"}`,
        });
        await evaluate("localStorage.clear(), true");
        await until(
          reference
            ? mode === "reference-detail"
              ? "!!document.querySelector('[role=dialog] .card-page')"
              : "!!document.querySelector('.card-table')"
            : mode === "empty"
              ? "!!document.querySelector('.empty')"
              : "document.body.textContent.includes('Q-40')",
        );
        const interaction = { mode, width, theme };
        if (mode === "detail") {
          if (after) {
            await evaluate(
              "document.querySelector('.card-table-title').focus(), true",
            );
            await key("Enter", 13);
            await until("!!document.querySelector('[role=dialog] h2')");
          } else {
            await evaluate(
              "document.querySelector('.decision-record-summary').click(), true",
            );
          }
        }
        if (mode === "filter") {
          await evaluate(
            "document.querySelector('[aria-label=\"决定人：全部\"]').focus(), true",
          );
          await key("Enter", 13);
          await until("!!document.querySelector('[role=listbox]')");
          await key("ArrowDown", 40);
        }
        await settle();
        const metrics = await evaluate(`(() => {
          const box = s => { const e=document.querySelector(s); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,width:r.width,height:r.height}; };
          const font = s => { const e=document.querySelector(s); if(!e) return null; const c=getComputedStyle(e); return {fontSize:c.fontSize,lineHeight:c.lineHeight,fontWeight:c.fontWeight}; };
          const visible = s => [...document.querySelectorAll(s)].filter(e=>e.getClientRects().length);
          const controls = visible('.ui-filter-row button,.ui-filter-row input:not([type=date]),.ui-filter-row label:has(> input[type=date]),.filter-bar input:not([type=date]),.filter-bar button').map(e=>{const r=e.getBoundingClientRect();return {name:e.getAttribute('aria-label')||e.querySelector('input')?.getAttribute('aria-label')||e.textContent.trim(),height:r.height,x:r.x,y:r.y,right:r.right,bottom:r.bottom};});
          return {
            scrollWidth:document.documentElement.scrollWidth, innerWidth, overflow:document.documentElement.scrollWidth > innerWidth,
            content:box('main'), header:box('.ui-page-header,.page-title'), title:font('main h1'), count:document.querySelector('.ui-page-count')?.textContent ?? null,
            toolbar:box('.ui-filter-row,.filter-bar'), actions:box('.ui-filter-row > .ui-action-row'), table:box('.card-table'),
            tableHead:font('.ui-table-head'), tableCell:font('.ui-table-cell'), tableHeadHeight:box('.ui-table-head')?.height ?? null,
            idBadges:visible('[data-ui="id-badge"]').slice(0,3).map(e=>e.getBoundingClientRect().height),
            icons:visible('.ui-filter-row svg').slice(0,3).map(e=>e.getBoundingClientRect().width),
            controls,
            toolbarOverlap:controls.flatMap((a,i)=>controls.filter((b,j)=>i<j && Math.min(a.right,b.right)>Math.max(a.x,b.x) && Math.min(a.bottom,b.bottom)>Math.max(a.y,b.y)).map(b=>a.name+" × "+b.name)),
            drawer:box('[role=dialog]'), drawerTitle:font('[role=dialog] .drawer-title'), drawerSection:font('[role=dialog] article h2'), drawerBody:font('[role=dialog] article'),
            dialogText:document.querySelector('[role=dialog]')?.textContent ?? null,
            listbox:!!document.querySelector('[role=listbox]'),
            refresh:document.querySelector('[aria-label="自动刷新"]')?.textContent ?? null,
            cardLinkGaps:(()=>{const cell=document.querySelector('.card-table tbody tr [data-label="卡片"]'); if(!cell) return null; const r=[...cell.querySelectorAll('a.id-tag')].map(e=>e.getBoundingClientRect()); return r.slice(1).map((b,i)=>Math.abs(b.top-r[i].top)<1?Math.round((b.left-r[i].right)*100)/100:'wrapped');})(),
            loadMore:!!visible('button').find(b=>b.textContent.trim()==='加载更多'),
          };
        })()`);
        await screenshot(`${mode}-${theme}-${width}`);
        if (after && mode === "detail") {
          await key("Escape", 27);
          await until("!document.querySelector('[role=dialog]')");
          interaction.focusReturned = await evaluate(
            "document.activeElement?.classList.contains('card-table-title')",
          );
          assert(interaction.focusReturned, "drawer returns focus to its row");
        }
        if (mode === "filter") {
          await key("Escape", 27);
          await until("!document.querySelector('[role=listbox]')");
          interaction.focusReturned = await evaluate(
            "document.activeElement?.getAttribute('aria-label')",
          );
          assert.equal(interaction.focusReturned, "决定人：全部");
        }
        records.push({ mode, width, theme, ...metrics });
        if (Object.keys(interaction).length > 3) interactions.push(interaction);
        if (after) {
          assert(!metrics.overflow, `${mode} ${width} ${theme}: overflow`);
          if (mode === "list")
            assert(
              metrics.cardLinkGaps.every(
                (gap) => gap === "wrapped" || gap >= 8,
              ),
              `${width} ${theme}: card links touch (${metrics.cardLinkGaps})`,
            );
          assert.deepEqual(
            metrics.toolbarOverlap,
            [],
            `${mode}: toolbar overlaps`,
          );
        }
      }
    }
  if (after)
    for (const r of records.filter((r) =>
      ["list", "filter"].includes(r.mode),
    )) {
      const ref = records.find(
        (x) =>
          x.mode === "reference" && x.width === r.width && x.theme === r.theme,
      );
      assert.equal(r.actions.right, ref.actions.right, "right edge agrees");
      assert.deepEqual(r.title, ref.title, "page title typography");
      assert.deepEqual(r.tableHead, ref.tableHead, "table head typography");
    }
  // Same viewport, side by side: decision history left, cards page right.
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"])
      for (const [mode, ref] of [
        ["list", "reference"],
        ["detail", "reference-detail"],
      ]) {
        const sources = await Promise.all(
          [mode, ref].map(
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
  resolve(output, `${stage}-interactions.json`),
  `${JSON.stringify(interactions, null, 2)}\n`,
);
await writeFile(
  resolve(output, `${stage}-environment.json`),
  `${JSON.stringify({ browser: browserVersion, fixture: "13 synthetic decisions (10 + 3 behind load more), 7 cards, 1 synthetic owner/PM, 1 Agent and 1 CI capacity record; not production data or scale", clock: "2026-01-01T00:00:00Z", dpr: 1, viewports: ["1440x1000", "390x1000"], themes: ["light", "dark"], fonts: ["Inter Variable", "Noto Sans SC Variable", "JetBrains Mono Variable"], capture: "viewport only" }, null, 2)}\n`,
);
console.log(`${stage}: ${records.length} screenshots and measurements`);
