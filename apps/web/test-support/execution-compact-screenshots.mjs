import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = process.argv[2];
assert(output, "Pass a new screenshot output directory");
await mkdir(output, { recursive: true });
const baseline = process.env.EXECUTION_BASELINE_REF;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const files = new Map(
  baseline
    ? ["apps/web/src/styles.css", "apps/web/src/views/ExecutionPage.tsx"].map(
        (path) => [
          resolve(root, path),
          execFileSync("git", ["show", `${baseline}:${path}`], {
            cwd: root,
            encoding: "utf8",
          }),
        ],
      )
    : [],
);
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "execution-compact-evidence",
      enforce: "pre",
      load(id) {
        return files.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__compact")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/__compact",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/execution-compact-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const report = {
  fixture:
    "Fixed C-314/C-406 synthetic 8 Assignments / 4 Runs, no production data or random seed",
  baseline: baseline ?? null,
  cases: {},
};
let browser;
try {
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
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width === 390,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__compact?case=${width}-${theme}#/p/p-1/execution?view=all`,
      });
      await until("Boolean(document.querySelector('.execution-lanes'))");
      await evaluate("document.fonts.ready.then(() => true)");
      await delay(150);
      const metrics = await evaluate(`(() => {
        const card = document.querySelector('[aria-label="赵云 A-1"]');
        const box = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
        const lane = card.closest('.execution-lane');
        const strip = lane.parentElement;
        const ids = [...card.querySelectorAll('.id-badge')].map(e => {const s=getComputedStyle(e);return {text:e.textContent, border:s.borderWidth, underline:s.textDecorationLine, ...box(e)};});
        const targets = [...card.querySelectorAll('button,a,summary')].filter(e => e.getClientRects().length).map(e => ({name:e.getAttribute('aria-label')||e.textContent.trim(),...box(e)}));
        return {card:box(card),lane:box(lane),strip:box(strip),scrollWidth:strip.scrollWidth,clientWidth:strip.clientWidth,
          pageOverflow:document.documentElement.scrollWidth>innerWidth,ids,targets,
          priority:box(card.querySelector('.priority-glyph')),heading:box(lane.firstElementChild),
          context:card.querySelector('.execution-card-context .execution-context')?.textContent,
          repeatedEmployee:!!card.querySelector('.employee-identity')};
      })()`);
      assert(!metrics.pageOverflow, "page must not overflow");
      assert.equal(
        metrics.lane.width,
        width === 1440 ? 326 : 366,
        "unchanged lane width",
      );
      if (!baseline) {
        assert(
          metrics.ids.every(
            (i) => i.border === "0px" && i.underline === "none",
          ),
          "plain IDs",
        );
        const cardId = metrics.ids.find((i) => i.text === "C-1");
        assert(
          Math.abs(
            cardId.y +
              cardId.height / 2 -
              metrics.priority.y -
              metrics.priority.height / 2,
          ) < 1,
          "priority and ID centers align",
        );
        assert(
          metrics.targets.every((t) => t.width >= 44 && t.height >= 44),
          "card targets remain 44px",
        );
        assert(!metrics.repeatedEmployee);
        assert.equal(metrics.context.trim(), "上下文 13.54%");
        assert.equal(metrics.heading.height, 44);
      }
      const name = `${width}-${theme}-${baseline ? "before" : "after"}`;
      report.cases[name] = metrics;
      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      await writeFile(
        resolve(output, `${name}.png`),
        Buffer.from(data, "base64"),
      );
      if (!baseline && width === 1440) {
        // Real mouse input on blank space; card body remains clickable but never pans.
        const p = await evaluate(
          `(() => { const s=document.querySelector('.execution-lanes');const cards=[...document.querySelectorAll('.execution-lane')].slice(0,3).flatMap(e=>[...e.querySelectorAll('.execution-card')]);const r=s.getBoundingClientRect();return {x:r.x+250,y:Math.max(...cards.map(c=>c.getBoundingClientRect().bottom))+10};})()`,
        );
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...p,
          button: "left",
          clickCount: 1,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: p.x - 150,
          y: p.y,
          button: "left",
          buttons: 1,
        });
        const during = await evaluate(
          `({scroll:document.querySelector('.execution-lanes').scrollLeft,selection:getSelection().toString(),select:getComputedStyle(document.querySelector('.execution-lanes')).userSelect})`,
        );
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: p.x - 150,
          y: p.y,
          button: "left",
          clickCount: 1,
        });
        assert(
          during.scroll > 0 &&
            during.selection === "" &&
            during.select === "none",
          "blank pan scrolls without selection",
        );
        assert(
          !(await evaluate("Boolean(document.querySelector('[role=dialog]'))")),
          "pan does not open a card",
        );
        await evaluate(
          "document.querySelector('.execution-lanes').scrollLeft=0",
        );
        const c = metrics.card;
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: c.x + 180,
          y: c.y + 65,
          button: "left",
          clickCount: 1,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: c.x + 100,
          y: c.y + 65,
          button: "left",
          buttons: 1,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: c.x + 100,
          y: c.y + 65,
          button: "left",
          clickCount: 1,
        });
        assert.equal(
          await evaluate(
            "document.querySelector('.execution-lanes').scrollLeft",
          ),
          0,
          "card itself does not pan",
        );
        report.cases[name].mouse = {
          blankPan: true,
          noSelection: true,
          noAccidentalOpen: true,
          cardDoesNotPan: true,
        };
      }
      if (!baseline) {
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await evaluate(
          "document.querySelector('.execution-card-more').focus()",
        );
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          text: "\r",
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await until(
          "document.querySelector('.execution-card-more').getAttribute('aria-expanded')==='true'",
        );
        await evaluate(
          "document.querySelector('.execution-card-more').click()",
        );
        report.cases[name].keyboardDetails = true;
        if (width === 390) {
          const p = await evaluate(
            "(() => {const r=document.querySelector('.execution-card-more').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()",
          );
          await send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [p],
          });
          await send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
          await until(
            "document.querySelector('.execution-card-more').getAttribute('aria-expanded')==='true'",
          );
          report.cases[name].touchDetails = true;
        } else {
          await send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: metrics.card.x + 150,
            y: metrics.card.y + 80,
            deltaX: 120,
            deltaY: 0,
          });
          await until(
            "document.querySelector('.execution-lanes').scrollLeft>0",
          );
          report.cases[name].horizontalWheel = true;
        }
      }
      if (width === 1440) {
        await evaluate(
          "[...document.querySelectorAll('button')].find(b=>b.textContent==='表格').click()",
        );
        await until("Boolean(document.querySelector('.execution-table'))");
        await evaluate("scrollTo(0,0)");
        const table = await evaluate(`(() => {
          const selectors = ['.employee-label strong', '.execution-task .id-badge, .execution-standing', '.execution-state .status, .execution-external', '.execution-context-value, .execution-context', '.execution-config-text', 'td[data-column=activity] time, td[data-column=activity] .hint'];
          const rows = [...document.querySelectorAll('.execution-table tbody tr')].map(row => {
            const baselines = selectors.map(selector => {
              const element=selector.startsWith(".execution-context-value") ? row.querySelector(".execution-context-value") ?? row.querySelector(".execution-context") : row.querySelector(selector);
              const node=[...element.childNodes].find(n=>n.nodeType===Node.TEXT_NODE && n.textContent.trim());
              const span=document.createElement('span');span.textContent=node.textContent;node.replaceWith(span);
              const marker=document.createElement('i');marker.style.cssText='display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline';span.append(marker);
              const y=marker.getBoundingClientRect().y;
              return {selector,y};
            });
            const glyphs = ['.employee-avatar','.priority-glyph','.status-icon'].map(selector=>{
              const r=row.querySelector(selector)?.getBoundingClientRect();return {selector,center:r?r.y+r.height/2:null};
            });
            const r=row.getBoundingClientRect();
            return {assignment:row.querySelector('.execution-open').textContent,baselines,glyphs,height:r.height,left:r.x,right:r.right,spread:Math.max(...baselines.map(b=>b.y))-Math.min(...baselines.map(b=>b.y))};
          });
          const table=document.querySelector('.execution-table');
          return {rows,width:table.getBoundingClientRect().width,pageOverflow:document.documentElement.scrollWidth>innerWidth};
        })()`);
        report.cases[`${name}-table`] = table;
        if (!baseline)
          assert(
            table.rows.every((r) => r.spread <= 2),
            `table baseline mismatch: ${JSON.stringify(table.rows)}`,
          );
        await evaluate(
          `(${JSON.stringify(table.rows)}).forEach(row=>{if(row.baselines[0].y>innerHeight-15)return;const line=document.createElement('div');line.style.cssText='position:fixed;pointer-events:none;z-index:9999;border-top:1px dashed #d946ef;font:10px monospace;color:#d946ef;left:'+row.left+'px;top:'+row.baselines[0].y+'px;width:'+(row.right-row.left)+'px';line.textContent=row.assignment+' baseline '+row.baselines[0].y.toFixed(1)+' / max delta '+row.spread.toFixed(1)+'px';document.body.append(line);})`,
        );
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
          clip: { x: 0, y: 0, width, height, scale: 1 },
        });
        await writeFile(
          resolve(output, `${name}-table-baselines.png`),
          Buffer.from(data, "base64"),
        );
      }
    }
  }
  assert.deepEqual(browser.errors, []);
} finally {
  await browser?.close();
  await server.close();
}
await writeFile(
  resolve(output, "measurements.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));
