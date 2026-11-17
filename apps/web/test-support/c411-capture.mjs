import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = "cbd0c094d69499a4e077c4aa1b80226862546baa";
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const measurements = [];
for (const stage of process.env.C411_STAGE
  ? [process.env.C411_STAGE]
  : ["before", "after"]) {
  const server = await createServer({
    root,
    server: { host: "localhost", port: 0 },
    plugins: [
      {
        name: "c411-evidence",
        enforce: "pre",
        load(id) {
          if (
            stage !== "before" ||
            !id.startsWith(`${resolve(root, "src")}/`) ||
            !/\.(tsx?|css)$/.test(id)
          )
            return;
          try {
            return execFileSync(
              "git",
              ["show", `${baseline}:apps/web/${id.slice(root.length)}`],
              { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
            );
          } catch {
            return;
          }
        },
        configureServer(s) {
          s.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/__c411")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await s.transformIndexHtml(
                "/__c411",
                '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c411-fixture.tsx"></script></body></html>',
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
    const until = async (expr) => {
      const end = Date.now() + 15000;
      while (!(await evaluate(expr))) {
        assert(Date.now() < end, `Timeout: ${expr}`);
        await delay(50);
      }
    };
    const shot = async (name) => {
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
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        const views = [
          "board",
          "list",
          ...(stage === "before"
            ? ["detail-904"]
            : Array.from({ length: 12 }, (_, i) => `detail-${901 + i}`)),
          "legend",
        ];
        for (const view of views) {
          const hash = view.startsWith("detail")
            ? `#/p/p-1/cards/C-${view.slice(7)}`
            : view === "legend"
              ? "#/p/p-1/help?doc=03-card-signals"
              : `#/p/p-1/cards?view=${view}&count=20`;
          await send("Page.navigate", {
            url: `${server.resolvedUrls.local[0]}__c411${hash}`,
          });
          const selector = view.startsWith("detail")
            ? ".card-page"
            : view === "legend"
              ? ".card-guide"
              : view === "board"
                ? ".board-card"
                : ".card-table";
          await until(`Boolean(document.querySelector('${selector}'))`);
          await evaluate("document.fonts.ready");
          await delay(80);
          const result = await evaluate(`(() => {
          const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
          const contrast = el => {
            const canvas=document.createElement('canvas'); canvas.width=canvas.height=1; const ctx=canvas.getContext('2d'); ctx.fillStyle='#fff';ctx.fillRect(0,0,1,1);
            const parents=[];for(let n=el;n;n=n.parentElement)parents.unshift(n);
            for(const n of parents){ctx.fillStyle=getComputedStyle(n).backgroundColor;ctx.fillRect(0,0,1,1);}
            const bg=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);ctx.fillStyle=getComputedStyle(el).color;ctx.fillRect(0,0,1,1);const fg=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);
            const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
            return (Math.max(lum(fg),lum(bg))+.05)/(Math.min(lum(fg),lum(bg))+.05);
          };
          return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,markers:[...document.querySelectorAll('.template-marker')].map(el=>({label:el.getAttribute('aria-label'),rect:rect(el),glyph:rect(el.querySelector('svg')),ink:rect(el.querySelector('.template-marker-ink')),contrast:contrast(el.querySelector('.template-marker-ink'))})),cardHeights:[...document.querySelectorAll('.board-card')].map(e=>rect(e).height)};
        })()`);
          assert.equal(
            result.width,
            result.scrollWidth,
            `${view} page overflow`,
          );
          if (stage === "after" && view !== "legend") {
            assert.equal(
              result.markers.length,
              view.startsWith("detail") ? 1 : 11,
              `${view} marker count`,
            );
            for (const m of result.markers) {
              assert(m.rect.width >= 44 && m.rect.height >= 44);
              if (view === "list")
                assert(
                  m.rect.x >= 0 && m.rect.x + m.rect.width <= width,
                  "List marker must be visible without horizontal scrolling",
                );
              if (view === "list" && width === 390)
                assert(
                  m.rect.x + m.rect.width >= width - 32,
                  "Narrow list marker must align with the row right edge",
                );
              assert.equal(m.glyph.width, 16);
              assert.equal(m.ink.width, 24);
              assert(m.contrast >= 3, `${m.label} contrast ${m.contrast}`);
            }
          }
          measurements.push({ stage, width, theme, view, ...result });
          const name = `${stage}-${theme}-${width}-${view}`;
          await shot(name);
          if (stage === "after" && view === "legend") {
            await evaluate(
              `document.querySelector('section[aria-label="模板标记"]').scrollIntoView({block:'start'})`,
            );
            await shot(`${name}-templates`);
          }

          if (stage === "after" && view !== "legend") {
            // Real keyboard focus, Enter and Escape; synthetic browser input, not a physical device.
            await evaluate(
              `document.querySelector('.template-marker').scrollIntoView({block:'center'})`,
            );
            await delay(60);
            const center = await evaluate(
              `(() => {const r=document.querySelector('.template-marker').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
            );
            await send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...center,
            });
            await until(
              `Boolean(document.querySelector('.template-marker-tip'))`,
            );
            await send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: 0,
              y: 0,
            });
            await until(
              `document.querySelector('.template-marker-tip') === null`,
            );
            await send("Emulation.setTouchEmulationEnabled", { enabled: true });
            await send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [center],
            });
            await send("Input.dispatchTouchEvent", {
              type: "touchEnd",
              touchPoints: [],
            });
            await until(
              `Boolean(document.querySelector('.template-marker-tip'))`,
            );
            await send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [{ x: 1, y: 1 }],
            });
            await send("Input.dispatchTouchEvent", {
              type: "touchEnd",
              touchPoints: [],
            });
            await until(
              `document.querySelector('.template-marker-tip') === null`,
            );
            await send("Emulation.setTouchEmulationEnabled", {
              enabled: false,
            });
            await evaluate(
              `document.querySelector('.template-marker').focus()`,
            );
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
            await send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "Tab",
              code: "Tab",
              windowsVirtualKeyCode: 9,
              modifiers: 8,
            });
            await send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Tab",
              code: "Tab",
              windowsVirtualKeyCode: 9,
              modifiers: 8,
            });
            await until(
              `document.activeElement?.classList.contains('template-marker') && Boolean(document.querySelector('.template-marker-tip'))`,
            );
            const focus = await evaluate(
              `(() => { const e=document.activeElement,t=document.querySelector('.template-marker-tip'),r=t.getBoundingClientRect();return {outline:getComputedStyle(e).outlineWidth,visible:e.matches(':focus-visible'),label:e.getAttribute('aria-label'),tip:t.textContent,hidden:t.getAttribute('aria-hidden'),description:e.getAttribute('aria-describedby'),left:r.left,right:r.right};})()`,
            );
            assert(focus.visible);
            assert.notEqual(focus.outline, "0px");
            assert.equal(focus.label, focus.tip);
            assert.equal(focus.hidden, "true");
            assert.equal(focus.description, null);
            assert(focus.left >= 0 && focus.right <= width);
            if (view === "list") {
              const ring = await evaluate(`(() => {
                const e=document.activeElement, r=e.getBoundingClientRect(), s=getComputedStyle(e), c=e.closest('.card-table-scroll').getBoundingClientRect();
                const extent=Math.max(0,parseFloat(s.outlineWidth)+parseFloat(s.outlineOffset));
                return {left:r.left-extent,right:r.right+extent,containerLeft:c.left,containerRight:c.right,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset};
              })()`);
              assert(
                ring.left >= ring.containerLeft &&
                  ring.right <= ring.containerRight,
                "List focus ring must fit inside the scroll container",
              );
              measurements.push({ stage, width, theme, view, ring });
            }

            measurements.push({ stage, width, theme, view, focus });
            await shot(`${name}-focus`);
            await send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "Escape",
              code: "Escape",
              windowsVirtualKeyCode: 27,
            });
            assert.equal(
              await evaluate(
                `document.querySelector('.template-marker-tip') === null && document.activeElement.classList.contains('template-marker')`,
              ),
              true,
            );
            await send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "Enter",
              text: "\r",
              code: "Enter",
              windowsVirtualKeyCode: 13,
            });
            await send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Enter",
              text: "\r",
              code: "Enter",
              windowsVirtualKeyCode: 13,
            });
            await until(
              `Boolean(document.querySelector('.template-marker-tip'))`,
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
      sha,
      baseline,
      seed: "c411-implementation-v1",
      cards: 12,
      synthetic: true,
      measurements,
    },
    null,
    2,
  ),
);
console.log(`Captured ${measurements.length} layout/focus records`);
