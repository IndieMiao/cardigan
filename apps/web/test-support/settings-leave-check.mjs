import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-455 evidence: leaving settings while a save is in flight (real Chromium,
// settings fixture only; 1439 saves slowly, 1438 fails slowly).
// Usage: node test-support/settings-leave-check.mjs
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "f",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__settings")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__settings",
              `<!doctype html><html lang="zh-CN"><body><div id="root"></div><script type="module" src="/test-support/settings-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const out = [];
let browser;
try {
  await server.listen();
  browser = await chromium();
  const { send, evaluate } = browser;
  out.push((await send("Browser.getVersion")).product);
  const until = async (expr, ms = 15000) => {
    const t = Date.now() + ms;
    while (!(await evaluate(expr))) {
      if (Date.now() > t) throw new Error(`timeout ${expr}`);
      await delay(40);
    }
  };
  const state = () =>
    evaluate(
      `JSON.stringify({ hash: location.hash, panel: document.querySelector('[data-settings-content]:not([hidden]) h2')?.textContent ?? null, alerts: [...document.querySelectorAll('[role=alert]')].filter((a) => a.offsetParent).map((a) => a.textContent).join('|') })`,
    );
  const base = server.resolvedUrls.local[0];
  const unload = () =>
    evaluate(
      "(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })()",
    );
  const log = async (label) => {
    out.push(`${label}: ${await state()} unloadBlocked=${await unload()}`);
  };
  // History cards → help → settings; then save slowly and try to leave.
  const scene = async (minutes, label, leave, after) => {
    await send("Page.navigate", { url: "about:blank" });
    await delay(1500);
    await send("Page.navigate", { url: `${base}__settings#/p/p-1/cards` });
    await until("!!document.querySelector('#root > *')");
    await evaluate("location.hash = '#/p/p-1/help'");
    await delay(200);
    await evaluate("location.hash = '#/p/p-1/settings'");
    await until("!!document.querySelector('[role=switch]')");
    await evaluate(`(() => {
      const input = document.querySelector("input[id$='-minutes']");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "${minutes}");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      [...document.querySelectorAll('[role=switch]')].find(s => document.getElementById(s.getAttribute('aria-labelledby'))?.textContent === '超时自动合并').click();
    })()`);
    await delay(100);
    await evaluate(leave);
    await delay(500);
    await log(`${label} t+0.6s`);
    await delay(1800);
    await log(`${label} t+2.4s`);
    for (const [name, step] of after) {
      await evaluate(step);
      await delay(400);
      await log(`${label} then ${name}`);
    }
  };
  const link = (text) =>
    `[...document.querySelectorAll('a')].find(a => a.textContent.trim() === '${text}').click()`;
  const tab = (text) =>
    `[...document.querySelectorAll("nav[aria-label='设置分栏'] button")].find(b => b.textContent.trim() === '${text}').click()`;
  await scene(1439, "slow success, link 帮助", link("帮助"), [
    ["Back", "history.back()"],
  ]);
  await scene(1438, "slow failure, link 帮助", link("帮助"), []);
  await scene(1438, "slow failure, Back", "history.back()", [
    ["Back", "history.back()"],
  ]);
  await scene(1439, "slow success, Back", "history.back()", [
    ["Back", "history.back()"],
    ["Forward", "history.forward()"],
    ["Forward", "history.forward()"],
  ]);
  await scene(
    1438,
    "slow failure, tab 授权 then link 帮助",
    `${tab("授权")}; ${link("帮助")}`,
    [],
  );
} finally {
  await browser?.close();
  await server.close();
}
console.log(out.join("\n"));
