import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-464 review: keyboard-only refresh must hand focus across the status/alert swap.
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "execution-diagnostics-focus",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__execution_diagnostics")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__execution_diagnostics",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/execution-diagnostics-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const results = [];
let browser;
try {
  await server.listen();
  browser = await chromium();
  const { send, evaluate } = browser;
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const press = async (key, code, keyCode, shift = false) => {
    const base = {
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers: shift ? 8 : 0,
    };
    await send("Input.dispatchKeyEvent", {
      ...base,
      type: "keyDown",
      ...(key === "Enter" ? { text: "\r" } : {}),
    });
    await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    await delay(60);
  };
  const active = () =>
    evaluate(
      "(() => { const e = document.activeElement; return e === document.body ? 'BODY' : (e.getAttribute('aria-label') || e.textContent.trim()); })()",
    );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const mode of ["ok-then-warn", "warn-then-ok"]) {
    const steps = [];
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__execution_diagnostics?diag=${mode}#/p/p-1/execution`,
    });
    await until("!!document.querySelector('[data-diagnostics-trigger]')");
    await until(
      "!document.querySelector('[data-diagnostics-state=checking]') && !document.body.textContent.includes('检查中')",
    );
    await evaluate(
      "document.querySelector('[data-diagnostics-trigger]').focus()",
    );
    steps.push(["focus entry", await active()]);
    if (mode === "ok-then-warn") {
      await press("Enter", "Enter", 13);
      await until("!!document.querySelector('[data-diagnostics-panel]')");
      steps.push(["Enter opens popover", await active()]);
      await until("document.activeElement.textContent.trim() === '刷新诊断'");
    } else {
      await press("Tab", "Tab", 9);
      steps.push(["Tab to refresh", await active()]);
    }
    await press("Enter", "Enter", 13);
    await until("!!window.__resolveDiagnostics");
    steps.push(["Enter refresh (pending)", await active()]);
    await press("Enter", "Enter", 13);
    steps.push(["Enter again while pending", await active()]);
    await evaluate("window.__resolveDiagnostics()");
    await until(
      mode === "ok-then-warn"
        ? "!!document.querySelector('[data-diagnostics-alert]')"
        : "!document.querySelector('[data-diagnostics-alert]') && !!document.querySelector('[data-diagnostics-trigger]')",
    );
    await delay(150);
    steps.push(["after swap", await active()]);
    if (mode === "ok-then-warn") {
      await press("Enter", "Enter", 13);
      steps.push([
        "Enter expands",
        await evaluate(
          "document.activeElement.getAttribute('aria-expanded') + ' / ' + document.body.textContent.includes('审批策略可能等待交互确认')",
        ),
      ]);
    }
    await press("Tab", "Tab", 9);
    steps.push(["next Tab", await active()]);
    results.push({ mode, steps });
  }
  console.log(
    JSON.stringify(
      { browser: (await send("Browser.getVersion")).product, results },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
