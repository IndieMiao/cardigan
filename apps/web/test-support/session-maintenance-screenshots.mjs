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
await mkdir(output, { recursive: false });
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "session-maintenance-fixture",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__session_maintenance")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/__session_maintenance",
              `<!doctype html>
        <html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body><div id="root"></div><script type="module" src="/test-support/session-maintenance-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const measurements = {
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  fixture:
    "C-402 fixed synthetic data: 14 internal Assignments, 1 running Run, long names/titles; no randomness or production data; busy/unknown/unsupported/publishing/conflict/recovered/timeout/pending plus attach lock/recent activity/idle candidate/exited/stale/unavailable and empty",
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
  const key = async (key, code, keyCode) => {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: key === "Enter" ? "\r" : "",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });
  };
  const capture = async (name, width, height) => {
    await evaluate("document.fonts.ready.then(() => true)");
    await delay(100);
    const metrics = await evaluate(`(() => {
      const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const root = document.querySelector('[role=dialog]') ?? document.querySelector('.execution-page,.help-page');
      const targets = [...root.querySelectorAll('a,button,summary,input,select')].filter(visible).map(e => {
        const r=e.getBoundingClientRect(); return {name:e.getAttribute('aria-label') || e.textContent.trim(),width:r.width,height:r.height}; });
      const reasons = [...root.querySelectorAll('.execution-maintenance')].filter(visible).map(e => ({
        text:e.textContent,client:e.clientWidth,scroll:e.scrollWidth, color:getComputedStyle(e).color }));
      const s=getComputedStyle(document.documentElement);
      const rgb = color => { const c=document.createElement('canvas'),x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data].slice(0,3); };
      const lum = color => rgb(color).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
      const a=lum(s.getPropertyValue('--text')),b=lum(s.getPropertyValue('--surface'));
      const reasonContrasts = [...root.querySelectorAll('.execution-maintenance, .execution-maintenance a')].filter(visible).map(e => { const t=lum(getComputedStyle(e).color); return (Math.max(t,b)+.05)/(Math.min(t,b)+.05); });
      return { viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,targets,reasons,reasonContrasts,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05) };
    })()`);
    assert(metrics.scrollWidth <= width, `${name}: overflow`);
    assert(
      metrics.reasons.every((r) => r.scroll <= r.client),
      `${name}: reason truncated`,
    );
    assert(
      metrics.reasonContrasts.every((c) => c >= 4.5),
      `${name}: reason/link contrast`,
    );
    assert(metrics.contrast >= 4.5, `${name}: contrast`);
    assert(
      metrics.targets.every((t) => t.width >= 44 && t.height >= 44),
      `${name}: small targets ${JSON.stringify(metrics.targets.filter((t) => t.width < 44 || t.height < 44))}`,
    );
    measurements.cases[name] = { width, height, ...metrics };
    const screenshot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(screenshot.data, "base64"),
      { flag: "wx" },
    );
  };
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ])
    for (const theme of ["light", "dark"]) {
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
        url: `${server.resolvedUrls.local[0]}__session_maintenance#/p/p-1/execution?view=all`,
      });
      await until(
        "document.querySelectorAll('.execution-maintenance').length === 11",
      );
      await capture(`${width}-${theme}-list`, width, height);
      for (const id of [
        "A-1",
        "A-3",
        "A-5",
        "A-6",
        "A-7",
        "A-8",
        "A-9",
        "A-10",
        "A-11",
        "A-12",
        "A-13",
        "A-14",
      ]) {
        await evaluate(
          `document.querySelector('button[aria-label="查看 ${id} 详情"]').scrollIntoView({block:'center'})`,
        );
        await capture(`${width}-${theme}-${id}`, width, height);
      }
      // Capture the lower rows too.
      await evaluate(
        "document.querySelector('main.content')?.scrollTo(0,100000); scrollTo(0,100000)",
      );
      await capture(`${width}-${theme}-lower`, width, height);
      await evaluate(
        "document.querySelector('button[aria-label=\"查看 A-1 详情\"]').focus()",
      );
      await key("Enter", "Enter", 13);
      await until("Boolean(document.querySelector('[role=dialog]'))");
      await capture(`${width}-${theme}-drawer`, width, height);
      await key("Escape", "Escape", 27);
      await until("!document.querySelector('[role=dialog]')");
      assert.equal(
        await evaluate("document.activeElement.getAttribute('aria-label')"),
        "查看 A-1 详情",
      );
      measurements.cases[`${width}-${theme}-drawer`].focusReturned = true;
      await evaluate(
        "document.querySelector('button[aria-label=\"查看 A-11 详情\"]').focus()",
      );
      await key("Enter", "Enter", 13);
      await until("Boolean(document.querySelector('[role=dialog]'))");
      await capture(`${width}-${theme}-candidate-drawer`, width, height);
      await evaluate(
        "document.querySelector('[role=dialog] .execution-maintenance a').focus()",
      );
      await until(
        "document.querySelector('[role=tooltip]')?.textContent.includes('自动回收可能打断')",
      );
      await capture(`${width}-${theme}-candidate-hint`, width, height);
      await key("Enter", "Enter", 13);
      await until("Boolean(document.querySelector('.help-article'))");
      assert(
        await evaluate(
          "document.querySelector('.help-article').textContent.includes('自动回收仍可能打断')",
        ),
      );
      await capture(`${width}-${theme}-help`, width, height);
      await evaluate(
        "document.querySelector('.help-article strong').scrollIntoView({block:'center'})",
      );
      await capture(`${width}-${theme}-help-risk`, width, height);
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__session_maintenance?empty=1#/p/p-1/execution?view=all`,
      });
      await until(
        "Boolean(document.querySelector('.execution-page')) && !document.querySelector('.execution-maintenance')",
      );
      await capture(`${width}-${theme}-empty`, width, height);
    }
  assert.deepEqual(browser.errors, []);
} finally {
  await browser?.close();
  await server.close();
}
await writeFile(
  resolve(output, "measurements.json"),
  `${JSON.stringify(measurements, null, 2)}\n`,
  { flag: "wx" },
);
console.log(
  `Verified ${Object.keys(measurements.cases).length} synthetic views`,
);
