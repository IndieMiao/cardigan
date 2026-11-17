import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const baseline = "60eb95489d5361cca6040ab9517a05289eb7ab03";
const measurements = [];
const contrasts = [];
const contrastScript = `(() => {
  const selectors=['.card-metadata','.card-purpose','.card-background-summary','.card-full-page','.author-prechecks','.drawer-title','.card-section-nav [aria-selected=true]','.card-header .id-badge'];
  return selectors.flatMap(selector=>{
    const el=document.querySelector(selector); if(!el || !el.getClientRects().length) return [];
    const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,1,1);
    const parents=[]; for(let n=el;n;n=n.parentElement) parents.unshift(n);
    for(const n of parents){ctx.fillStyle=getComputedStyle(n).backgroundColor;ctx.fillRect(0,0,1,1);}
    const pseudo=getComputedStyle(el,'::before'); if(pseudo.content!=='none'){ctx.fillStyle=pseudo.backgroundColor;ctx.fillRect(0,0,1,1);}
    const bg=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);
    ctx.fillStyle=getComputedStyle(el).color;ctx.fillRect(0,0,1,1);
    const fg=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);
    const lum=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    return [{selector,fg,bg,ratio:(Math.max(lum(fg),lum(bg))+.05)/(Math.min(lum(fg),lum(bg))+.05)}];
  });
})()`;
for (const stage of process.env.C408_STAGE
  ? [process.env.C408_STAGE]
  : ["before", "after"]) {
  const server = await createServer({
    root,
    server: { host: "localhost", port: 0 },
    plugins: [
      {
        name: "c408-evidence",
        enforce: "pre",
        load(id) {
          if (stage !== "before" || !id.startsWith(`${resolve(root, "src")}/`))
            return;
          try {
            return execFileSync(
              "git",
              ["show", `${baseline}:apps/web/${id.slice(root.length)}`],
              {
                cwd: root,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              },
            );
          } catch {
            return;
          }
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/__c408")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                "/__c408",
                '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c408-fixture.tsx"></script></body></html>',
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
    const until = async (expression) => {
      const limit = Date.now() + 20000;
      while (!(await evaluate(expression))) {
        assert(Date.now() < limit, expression);
        await delay(40);
      }
    };
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"])
        for (const id of ["C-283", "C-501", "C-502"])
          for (const mode of ["page", "drawer"]) {
            await send("Emulation.setDeviceMetricsOverride", {
              width,
              height: width === 390 ? 844 : 900,
              deviceScaleFactor: 1,
              mobile: false,
            });
            await send("Emulation.setEmulatedMedia", {
              features: [
                { name: "prefers-color-scheme", value: theme },
                { name: "prefers-reduced-motion", value: "reduce" },
              ],
            });
            const route =
              mode === "page" ? `cards/${id}` : `cards?view=board&card=${id}`;
            await send("Page.navigate", {
              url: `${server.resolvedUrls.local[0]}__c408?case=${stage}-${width}-${theme}-${id}-${mode}#/p/p-1/${route}`,
            });
            await until(
              'Boolean(document.querySelector(".card-header .card-actions"))',
            );
            await evaluate("document.fonts.ready.then(() => true)");
            await delay(80);
            const row = await evaluate(`(() => {
        const page = document.querySelector('.card-page'), rect = e => {const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};};
        const header=page.querySelector('.card-header'), meta=page.querySelector('.card-metadata'), buttons=[...header.querySelectorAll('button')].filter(e=>e.getClientRects().length);
        const parts=meta?[...meta.children].map(rect):[];
        return {scrollWidth:document.documentElement.scrollWidth, clientWidth:document.documentElement.clientWidth, body:rect(document.querySelector('.drawer-body')??page), header:rect(header), titleCount:page.querySelectorAll('h1').length+document.querySelectorAll('.drawer-title').length,
          metadataRows:new Set(parts.map(r=>Math.round(r.y + r.height / 2))).size, actionRows:new Set(buttons.map(e=>Math.round(e.getBoundingClientRect().y))).size,
          controls:buttons.map(e=>({label:e.textContent,...rect(e),visualHeight:e.getBoundingClientRect().height-12,fontSize:getComputedStyle(e).fontSize,paddingInline:getComputedStyle(e).paddingInline,radius:getComputedStyle(e).borderRadius})), precheckRows:page.querySelectorAll('.author-prechecks li').length,
          metadata:meta?{...rect(meta),scrollWidth:meta.scrollWidth,fade:meta.hasAttribute('data-more')}:null,
          precheckHeight:page.querySelector('.author-prechecks li')?.getBoundingClientRect().height,
          nav:rect(page.querySelector('.card-section-nav')),
          panel:page.querySelector('[role=tabpanel]:not([hidden])')?.id};
      })()`);
            measurements.push({ stage, width, theme, id, mode, ...row });
            if (stage === "after") {
              assert.equal(
                row.scrollWidth,
                row.clientWidth,
                `${id} ${mode} ${width} page overflow`,
              );
              const contrast = await evaluate(contrastScript);
              contrasts.push({ width, theme, id, mode, values: contrast });
              for (const value of contrast)
                assert(
                  value.ratio >= 4.5,
                  `${value.selector} text contrast ${value.ratio}`,
                );
              assert.equal(row.titleCount, 1, "one title");
              assert.equal(row.actionRows, 1, "one action row");
              assert.equal(row.metadataRows, 1, "one metadata row");
              assert.equal(row.precheckRows, id === "C-502" ? 1 : 0);
              if (row.precheckRows)
                assert.equal(row.precheckHeight, 44, "one precheck row");
              for (const control of row.controls) {
                assert(
                  control.height >= 44 && control.width >= 44,
                  `small target: ${control.label}`,
                );
                assert(
                  control.x >= 0 && control.right <= width,
                  `control offscreen: ${control.label}`,
                );
              }
            }
            const name = `${stage}-${id}-${mode}-${width}-${theme}`;
            const { data } = await send("Page.captureScreenshot", {
              format: "png",
            });
            await writeFile(
              resolve(output, `${name}.png`),
              Buffer.from(data, "base64"),
            );
            if (stage === "after" && id === "C-502") {
              await evaluate(
                "document.querySelector('.card-actions [aria-haspopup=menu]').focus()",
              );
              await send("Input.dispatchKeyEvent", {
                type: "keyDown",
                key: "ArrowDown",
                code: "ArrowDown",
              });
              await send("Input.dispatchKeyEvent", {
                type: "keyUp",
                key: "ArrowDown",
                code: "ArrowDown",
              });
              await until('Boolean(document.querySelector("[role=menu]"))');
              assert(
                await evaluate(
                  "[...document.querySelectorAll('[role=menuitem]')].every(e=>e.getBoundingClientRect().height>=44)",
                ),
                "menu target size",
              );
              await evaluate(
                "[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='取消卡片').click()",
              );
              await until(
                'Boolean(document.querySelector("form[aria-label=确认取消卡片]"))',
              );
              await until("document.activeElement?.tagName === 'TEXTAREA'");
              const confirm = await send("Page.captureScreenshot", {
                format: "png",
              });
              await writeFile(
                resolve(output, `${name}-confirm.png`),
                Buffer.from(confirm.data, "base64"),
              );
              await evaluate(
                "[...document.querySelectorAll('button')].find(e=>e.textContent==='暂不取消').click()",
              );
              await until(
                "document.activeElement?.getAttribute('aria-haspopup') === 'menu'",
              );
              const metadata = await evaluate(
                "(() => { const el=document.querySelector('.card-metadata'); el.focus(); return el.scrollWidth>el.clientWidth; })()",
              );
              await send("Input.dispatchKeyEvent", {
                type: "keyDown",
                key: "End",
                code: "End",
              });
              await send("Input.dispatchKeyEvent", {
                type: "keyUp",
                key: "End",
                code: "End",
              });
              if (metadata)
                assert(
                  await evaluate(
                    "document.querySelector('.card-metadata').scrollLeft > 0",
                  ),
                  "metadata keyboard scroll",
                );
              await until(
                "!document.querySelector('.card-metadata').hasAttribute('data-more')",
              );
              if (metadata)
                assert(
                  await evaluate(
                    "document.querySelector('.card-metadata').hasAttribute('data-previous')",
                  ),
                  "left fade at end",
                );
              await evaluate(
                "[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.startsWith('时间线')).click()",
              );
              await evaluate(
                "[...document.querySelectorAll('button')].find(e=>e.textContent==='写评论').click()",
              );
              await until(
                "document.activeElement?.getAttribute('aria-label') === '评论正文' || document.activeElement?.id === document.querySelector('.comment-box textarea')?.id",
              );
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
      baseline,
      subject: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      source:
        "fixed synthetic fixture, seed label 408, 3 cards, not production scale",
      clock: "2026-11-17T00:00:00.000Z",
      measurements,
      contrasts,
    },
    null,
    2,
  ),
);
console.log(
  `Captured ${measurements.length} states plus cancellation confirmations.`,
);
