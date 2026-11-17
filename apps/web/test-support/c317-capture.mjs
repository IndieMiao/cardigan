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
const server = await createServer({
  root,
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "c317-evidence",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c317")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c317",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c317-fixture.tsx"></script></body></html>',
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
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
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
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__c317?case=${width}-${theme}#/p/p-1/execution?view=all`,
      });
      await until(
        'document.querySelector(".execution-diagnostics summary")?.textContent.includes("7")',
      );
      await evaluate("document.fonts.ready.then(() => true)");
      await evaluate(
        'document.querySelector(".execution-diagnostics summary").focus()',
      );
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: "\r",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await until('document.querySelector(".execution-diagnostics").open');
      const metrics = await evaluate(`(() => {
      const area=document.querySelector('.execution-diagnostics');
      const rect=e=>{const r=e.getBoundingClientRect();return {width:r.width,height:r.height};};
      const controls=[...area.querySelectorAll('summary,button')].map(e=>({text:e.textContent,...rect(e)}));
      const contrast=[...area.querySelectorAll('p,strong,summary,button')].map(el=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,1,1);
        const parents=[];for(let n=el;n;n=n.parentElement)parents.unshift(n);for(const n of parents){c.fillStyle=getComputedStyle(n).backgroundColor;c.fillRect(0,0,1,1);}
        const bg=[...c.getImageData(0,0,1,1).data].slice(0,3);c.fillStyle=getComputedStyle(el).color;c.fillRect(0,0,1,1);const fg=[...c.getImageData(0,0,1,1).data].slice(0,3);
        const lum=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
        return (Math.max(lum(bg),lum(fg))+.05)/(Math.min(lum(bg),lum(fg))+.05);
      });
      return {overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth, controls, minimumContrast:Math.min(...contrast), focus:getComputedStyle(document.activeElement).outlineStyle};
    })()`);
      assert.equal(metrics.overflow, false);
      assert(metrics.controls.every((c) => c.width >= 44 && c.height >= 44));
      assert(metrics.minimumContrast >= 4.5);
      assert.notEqual(metrics.focus, "none");
      measurements.push({ width, theme, ...metrics });
      await evaluate(
        'document.querySelector(".execution-diagnostics").scrollIntoView()',
      );
      const layout = await send("Page.getLayoutMetrics");
      const shot = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width,
          height: Math.ceil(layout.cssContentSize.height),
          scale: 1,
        },
      });
      await writeFile(
        resolve(output, `${width}-${theme}.png`),
        Buffer.from(shot.data, "base64"),
        { flag: "wx" },
      );
      await evaluate(
        'document.querySelector(".execution-diagnostics li button").focus()',
      );
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: "\r",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await until('Boolean(document.querySelector("[role=dialog]"))');
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
      await until('!document.querySelector("[role=dialog]")');
      assert(
        await evaluate(
          'document.activeElement.textContent.includes("查看 A-1")',
        ),
      );
    }
  await send("Page.navigate", {
    url: `${server.resolvedUrls.local[0]}__c317?empty=1#/p/p-1/execution`,
  });
  await until('document.body.textContent.includes("没有告警")');
  assert.equal(browser.errors.length, 0);
  await writeFile(
    resolve(output, "measurements.json"),
    JSON.stringify(
      {
        sha: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        seed: "C-317-v1",
        source:
          "synthetic; 8 assignments, 4 runtime states, 3 configuration warnings; no production inputs",
        measurements,
        keyboard:
          "Enter expands, opens current Assignment drawer; Escape returns focus",
        empty: "没有告警",
        unverified: [
          "production terminal screens",
          "other Codex versions/languages",
          "real upstream connectivity",
        ],
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
} finally {
  await browser?.close();
  await server.close();
}
