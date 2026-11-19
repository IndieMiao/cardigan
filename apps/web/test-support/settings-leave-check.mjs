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
      `JSON.stringify({ hash: location.hash, settings: !!document.querySelector('[data-settings-content]'), alerts: [...document.querySelectorAll('[role=alert]')].map(a => a.textContent).join('|') })`,
    );
  const base = server.resolvedUrls.local[0];
  for (const [minutes, how] of [
    [1439, "link"],
    [1438, "back"],
    [1439, "back"],
  ]) {
    const label = `${minutes === 1439 ? "slow success" : "slow failure"} via ${how}`;
    console.error("start", label);
    const nav = send("Page.navigate", { url: "about:blank" });
    await delay(1500);
    try {
      await send("Page.handleJavaScriptDialog", { accept: true });
      console.error("a dialog was open before leaving");
    } catch (e) {
      console.error("no dialog:", String(e).slice(0, 80));
    }
    await nav;
    await send("Page.navigate", { url: `${base}__settings#/p/p-1/cards` });
    await until("!!document.querySelector('main, #root > *')");
    await evaluate("location.hash = '#/p/p-1/settings'");
    await until("!!document.querySelector('[role=switch]')");
    await evaluate(`(() => {
      const input = document.querySelector("input[id$='-minutes']");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "${minutes}");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      [...document.querySelectorAll('[role=switch]')].find(s => document.getElementById(s.getAttribute('aria-labelledby'))?.textContent === '超时自动合并').click();
    })()`);
    await delay(100);
    if (how === "link")
      await evaluate(
        `[...document.querySelectorAll('a')].find(a => a.textContent.trim() === '帮助').click()`,
      );
    else await evaluate("history.back()");
    await delay(500);
    out.push(
      `${label} t+0.6s: ${await state()} unloadBlocked=${await evaluate("(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })()")}`,
    );
    console.error(out.at(-1));
    await delay(1800);
    out.push(
      `${label} t+2.4s: ${await state()} unloadBlocked=${await evaluate("(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })()")}`,
    );
    console.error(out.at(-1));
    console.error("done", label);
  }
} finally {
  await browser?.close();
  await server.close();
}
console.log(out.join("\n"));
