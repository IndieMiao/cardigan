import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = process.argv[2];
assert(output, "Pass a screenshot output directory");
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "execution-display-fixture",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__execution_display")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/__execution_display",
              `<!doctype html>
          <html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
          <body><div id="root"></div><script type="module" src="/test-support/execution-display-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const measurements = {
  fixture:
    "C-314 fixed synthetic fixture, 8 Assignments / 4 Runs / 4 Cards, no random seed or production data",
  cases: {},
};
let browser;
try {
  await server.listen();
  browser = await chromium();
  const { send, evaluate } = browser;
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Page.bringToFront");
  const until = async (expression) => {
    const deadline = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < deadline, expression);
      await delay(50);
    }
  };
  const button = (name) =>
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(name)})`;
  const key = async (key, code, keyCode) => {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: key === "Enter" ? "\r" : key === " " ? " " : "",
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
    await delay(80);
  };
  const capture = async (name, width, height) => {
    await evaluate("document.fonts.ready.then(() => true)");
    await delay(80);
    const metrics = await evaluate(`(() => {
      const page = document.querySelector('.execution-page, .cards-page');
      const execution = page.classList.contains('execution-page');
      const targets = [...page.querySelectorAll(execution ? 'button, a, summary, select' : '.table-group-heading button, .card-display-trigger'), ...document.querySelectorAll('.card-display-menu .menu-checkbox')].filter(e => e.getClientRects().length && !e.closest('[hidden]'));
      const box = e => { const r = e.getBoundingClientRect(); return { x:r.x, right:r.right, width: r.width, height: r.height }; };
      const capacity = document.querySelector('.capacity-status');
      const capacityStyle = getComputedStyle(capacity);
      const filter = document.querySelector('.filter-bar-compact');
      const filterRects = filter ? [...filter.querySelectorAll(':scope > .filter-controls, :scope > .filter-chips, :scope > .filter-summary')].map(e => {const r=e.getBoundingClientRect(); return {x:r.x, y:r.y, height:r.height};}) : [];
      const lanes = document.querySelector('.execution-lanes');
      const laneRects = [...document.querySelectorAll('.execution-lane')].map(e => { const r = e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width }; });
      const rgb = color => { const c = document.createElement('canvas'); c.width = c.height = 1; const ctx=c.getContext('2d'); ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3); };
      const luminance = c => rgb(c).map(x => x/255).map(x => x <= 0.04045 ? x/12.92 : ((x+0.055)/1.055)**2.4).reduce((n,x,i) => n + x*[0.2126,0.7152,0.0722][i],0);
      const style = getComputedStyle(document.documentElement);
      const contrast = (fg,bg) => { const a=luminance(style.getPropertyValue(fg)), b=luminance(style.getPropertyValue(bg)); return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05); };
      return { overflow: document.documentElement.scrollWidth > innerWidth,
        targets: targets.map(e => ({name:e.getAttribute('aria-label') || e.textContent.trim(), ...box(e)})),
        capacity: { border:capacityStyle.borderTopWidth, background:capacityStyle.backgroundColor }, filterRects,
        laneRects, lanes: lanes ? { client:lanes.clientWidth, scroll:lanes.scrollWidth } : null,
        contrast: { body:contrast('--text','--surface'), muted:contrast('--text-muted','--surface'), mutedPage:contrast('--text-muted','--bg') }
      };
    })()`);
    assert(!metrics.overflow, `${name}: page overflow`);
    assert(
      metrics.targets.every((t) => t.width >= 44 && t.height >= 44),
      `${name}: undersized target ${JSON.stringify(metrics.targets.filter((t) => t.width < 44 || t.height < 44))}`,
    );
    assert(
      Object.values(metrics.contrast).every((c) => c >= 4.5),
      `${name}: contrast`,
    );
    assert.equal(
      metrics.capacity.border,
      "0px",
      `${name}: capacity has a border`,
    );
    assert.equal(
      metrics.capacity.background,
      "rgba(0, 0, 0, 0)",
      `${name}: capacity has a background`,
    );
    if (name.endsWith("-compact-filter") && width === 1440) {
      const centers = metrics.filterRects.map((r) => r.y + r.height / 2);
      assert(
        Math.max(...centers) - Math.min(...centers) < 2,
        "wide filter/chip/counts stay on one line",
      );
    }
    measurements.cases[name] = metrics;
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    for (const theme of ["light", "dark"]) {
      const name = `${width}-${theme}`;
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
      await send("Page.navigate", { url: "about:blank" });
      await until(
        "document.URL === 'about:blank' && !document.querySelector('#root')",
      );
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__execution_display#/p/p-1/execution?view=all`,
      });
      await until("Boolean(document.querySelector('.execution-open'))");
      await capture(`${name}-table`, width, height);
      await evaluate(
        "(() => { const s=document.querySelector('.execution-page select');s.value='working';s.dispatchEvent(new Event('change',{bubbles:true})); })()",
      );
      await until(
        "document.querySelector('.execution-page select').value === 'working' && document.querySelectorAll('.execution-open').length === 6",
      );
      await capture(`${name}-compact-filter`, width, height);
      await evaluate(
        "document.querySelector('.execution-page .filter-chips button').click()",
      );
      await until("document.querySelectorAll('.execution-open').length === 8");
      await evaluate(`${button("按员工分组")}.focus()`);
      await key("Enter", "Enter", 13);
      await until(
        "Boolean(document.querySelector('.execution-group-heading'))",
      );
      await capture(`${name}-groups`, width, height);
      await evaluate(
        "document.querySelector('.execution-group-heading button[aria-expanded]').focus()",
      );
      await key(" ", "Space", 32);
      await until(
        "Boolean(document.querySelector('.execution-group-heading button[aria-expanded=false]'))",
      );
      await capture(`${name}-collapsed`, width, height);
      // Touch path on narrow screens; keyboard path on desktop.
      if (width === 390) {
        const point = await evaluate(
          `(() => { const e=${button("卡片")};e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
        );
        await send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [point],
        });
        await send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      } else {
        await evaluate(`${button("卡片")}.focus()`);
        await key("Enter", "Enter", 13);
      }
      await until("Boolean(document.querySelector('.execution-lanes'))");
      await evaluate("scrollTo(0,0)");
      await capture(`${name}-cards`, width, height);
      const m = measurements.cases[`${name}-cards`];
      if (width === 1440)
        assert(m.lanes.scroll > m.lanes.client, "wide lanes scroll internally");
      else
        assert(
          m.laneRects.every((r) => r.x === m.laneRects[0].x) &&
            m.laneRects[1].y > m.laneRects[0].y,
          "narrow lanes stack",
        );
      await evaluate(
        "document.querySelector('button[aria-label^=运行状态]').focus()",
      );
      await key("Enter", "Enter", 13);
      await until(
        "Boolean(document.querySelector('button[aria-label^=运行状态升序]'))",
      );
      await capture(`${name}-sorted`, width, height);
      await evaluate("document.querySelector('.execution-open').focus()");
      const trigger = await evaluate(
        "document.activeElement.getAttribute('aria-label')",
      );
      await key("Enter", "Enter", 13);
      await until("Boolean(document.querySelector('[role=dialog]'))");
      await capture(`${name}-drawer`, width, height);
      await key("Escape", "Escape", 27);
      await until("!document.querySelector('[role=dialog]')");
      assert.equal(
        await evaluate("document.activeElement.getAttribute('aria-label')"),
        trigger,
        "drawer returns focus",
      );
      measurements.cases[`${name}-drawer`].focusReturned = true;
      await evaluate("location.hash = '#/p/p-1/cards?view=list'");
      await until("Boolean(document.querySelector('.card-table'))");
      await evaluate(
        "[...document.querySelectorAll('.cards-page button')].find(b => b.textContent.trim().startsWith('显示')).focus()",
      );
      await key("Enter", "Enter", 13);
      await until("Boolean(document.querySelector('[role=menu]'))");
      await evaluate(
        "[...document.querySelectorAll('[role=menuitemcheckbox]')].find(b => b.textContent.includes('分组字段：状态')).focus()",
      );
      await key(" ", "Space", 32);
      await until(
        "document.querySelectorAll('.card-table .table-group-heading').length === 3",
      );
      await capture(`${name}-card-list-menu`, width, height);
      await key("Escape", "Escape", 27);
      await until("!document.querySelector('[role=menu]')");
      await capture(`${name}-card-list-groups`, width, height);
      await evaluate(
        "document.querySelector('.card-table button[aria-label=折叠进行中分组]').focus()",
      );
      await key("Enter", "Enter", 13);
      await until(
        "Boolean(document.querySelector('.card-table button[aria-label=展开进行中分组]'))",
      );
      await capture(`${name}-card-list-collapsed`, width, height);
      await evaluate("localStorage.clear()");
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
  resolve(output, "measurements.json"),
  `${JSON.stringify(measurements, null, 2)}\n`,
);
console.log(
  `Verified ${Object.keys(measurements.cases).length} layouts; screenshots and measurements in ${output}`,
);
