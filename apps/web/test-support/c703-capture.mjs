// C-703 evidence: the execution drawer's 当前 panel before/after for the five
// states (运行中 A-213, 空闲 A-214, 会话维护中 A-217, 失联 A-215, 已释放
// A-216), the writes (启动/重启 and 停止: in progress, success, failure, the
// confirm dialog) and 查看改动, at 1440×1000 and 390×1000, light and dark,
// plus the card detail drawer (C-48, the baseline page) at the same viewport
// and theme. "Before" serves the baseline commit's versions of the changed
// web files from the same server and fixture.
//
// Each shot records the panel and its buttons, whether a wrapped fact line
// starts with “·”, the drawer/sheet scroll widths and the document width.
// Synthetic data only (c703-fixture.tsx, c695-fixture.tsx).
//
// CHROMIUM_PATH=<chrome> C703_BASELINE_REF=<sha> \
//   node apps/web/test-support/c703-capture.mjs <new dir>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const outArg = process.argv[2];
assert(outArg, "Pass a new output directory");
const output = resolve(outArg);
const baselineRef = process.env.C703_BASELINE_REF;
assert(baselineRef, "Set C703_BASELINE_REF to the clean baseline commit");
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = resolve(webRoot, "../..");
const changed = [
  "apps/web/src/api.ts",
  "apps/web/src/components/ExecutionDetail.tsx",
  "apps/web/src/components/layout/CardDetailLayout.tsx",
  "apps/web/src/components/layout/CardDetailLayout.module.css",
  "apps/web/src/components/ui/icons.tsx",
  "apps/web/src/components/ui/theme.css",
  "apps/web/src/testing/fixtures.ts",
];
const baselineFiles = new Map(
  changed.map((path) => [
    resolve(repoRoot, path),
    execFileSync("git", ["show", `${baselineRef}:${path}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  ]),
);
const entries = {
  "/__c703": "/test-support/c703-fixture.tsx",
  "/__c695": "/test-support/c695-fixture.tsx",
};
const serve = (before) =>
  createServer({
    root: webRoot,
    logLevel: "error",
    cacheDir: resolve(
      webRoot,
      `node_modules/.vite-c703-${before ? "before" : "after"}`,
    ),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "c703-evidence",
        enforce: "pre",
        load(id) {
          return before ? baselineFiles.get(id.split("?")[0]) : undefined;
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = req.url?.split(/[?#]/)[0] ?? "";
            const entry = entries[path];
            if (!entry) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                path,
                `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
  });

const states = {
  "A-213": "running",
  "A-214": "idle",
  "A-217": "maintenance",
  "A-215": "lost",
  "A-216": "released",
};
const report = { baseline: baselineRef, shots: [] };
let browser;
const servers = [];
try {
  await mkdir(output);
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
  report.browser = await browser.send("Browser.getVersion");
  const { send, evaluate } = browser;
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression, ms = 20000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(25);
    }
  };
  const settle = async () => {
    await run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await delay(150);
  };
  const metrics = (width, height) =>
    send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
  };
  const load = async (base, url, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", { url: `${base}${url}` });
    await until(ready);
    await evaluate("document.fonts.ready.then(() => true)");
    await run((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await settle();
  };
  const openRow = async (id) => {
    await run((id) => {
      const b = document.querySelector(`button[aria-label="查看 ${id} 详情"]`);
      b.focus();
      b.click();
    }, id);
    await until(
      "!!document.querySelector('.drawer-content .execution-drawer')",
    );
    await until(
      "!document.querySelector('.drawer-content')?.textContent.includes('正在读取')",
    );
    await settle();
  };
  const click = (text, scope = "document") =>
    run(
      (text, scope) => {
        const root =
          scope === "dialog"
            ? [...document.querySelectorAll('[role="dialog"]')].at(-1)
            : document;
        const b = [...root.querySelectorAll("button")].find(
          (x) => x.textContent.trim() === text,
        );
        if (!b) throw new Error(`no button ${text}`);
        b.focus();
        b.click();
      },
      text,
      scope,
    );
  const measure = () =>
    run(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          font: `${s.fontSize}/${s.lineHeight}`,
          weight: s.fontWeight,
        };
      };
      const d = document.querySelector(".drawer-content");
      const panel = d?.querySelector("section[aria-label=当前]");
      const line = panel?.querySelector("h2 + div");
      // A “·” that is the first thing on its visual line.
      const dotAtLineStart = (() => {
        if (!line) return null;
        // Every rendered text fragment (a wrapped text node gives several).
        const pieces = [];
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of range.getClientRects())
            if (r.width > 0)
              pieces.push({ r, dot: n.textContent.trim() === "·" });
        }
        const lines = new Map();
        for (const { r, dot } of pieces) {
          const middle = Math.round(r.top + r.height / 2);
          const key = [...lines.keys()].find((k) => Math.abs(k - middle) < 6);
          const k = key ?? middle;
          const list = lines.get(k) ?? [];
          list.push({ x: r.left, dot });
          lines.set(k, list);
        }
        return [...lines.values()].some(
          (list) => list.sort((a, b) => a.x - b.x)[0]?.dot,
        );
      })();
      const body = d?.querySelector(".drawer-body");
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
        (x) => !x.classList.contains("drawer-content"),
      );
      const sheetBody = dialog?.querySelector(".ui-dialog-body");
      return {
        panel: box(panel),
        mine: panel?.hasAttribute("data-mine") ?? null,
        panelTitle: panel?.querySelector("h2")?.textContent,
        panelTitleBox: box(panel?.querySelector("h2")),
        factLine: line?.textContent,
        factLineBox: box(line),
        dotAtLineStart,
        buttons: [
          ...(panel?.querySelectorAll("[data-next-actions] > *") ?? []),
        ].map((b) => ({
          text: b.textContent,
          variant:
            [...b.classList]
              .find((c) => c.startsWith("ui-button-"))
              ?.replace("ui-button-", "") ?? null,
          disabled: b.disabled ?? false,
          ...box(b),
        })),
        feedback: [...document.querySelectorAll(".request-feedback")]
          .map((f) => f.textContent)
          .filter(Boolean),
        dialog: dialog
          ? {
              ...box(dialog),
              title: dialog.querySelector("h2")?.textContent,
              buttons: [...dialog.querySelectorAll("button")].map((b) => ({
                text: b.textContent,
                ...box(b),
              })),
              body: sheetBody
                ? {
                    scrollWidth: sheetBody.scrollWidth,
                    clientWidth: sheetBody.clientWidth,
                  }
                : null,
              patch: (() => {
                const p = dialog.querySelector("section[aria-label$=的改动]");
                return p
                  ? {
                      ...box(p),
                      scrollWidth: p.scrollWidth,
                      clientWidth: p.clientWidth,
                    }
                  : null;
              })(),
            }
          : null,
        drawerScroll: body
          ? { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth }
          : null,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth,
      };
    });
  const record = async (name, extra = {}) => {
    await shot(`${name}.png`);
    report.shots.push({ name, ...extra, measure: await measure() });
  };

  for (const before of [true, false]) {
    const server = await serve(before);
    servers.push(server);
    await server.listen();
    const base = server.resolvedUrls.local[0].replace(/\/$/, "");
    const label = before ? "before" : "after";
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        await metrics(width, 1000);
        await send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-color-scheme", value: theme },
            { name: "prefers-reduced-motion", value: "reduce" },
          ],
        });
        const tag = `${width}-${theme}`;
        // The baseline page: the card detail drawer, same width and theme.
        await load(
          base,
          "/__c695#/p/p-1/cards?view=list&card=C-48",
          "!!document.querySelector('.drawer-content .card-page-drawer')",
          theme,
        );
        await record(`${label}-card-drawer-${tag}`, { label, width, theme });
        const page = (op = "") =>
          load(
            base,
            `/__c703${op ? `?op=${op}` : ""}#/p/p-1/execution?view=all`,
            "!!document.querySelector('button[aria-label=\"查看 A-213 详情\"]')",
            theme,
          );
        for (const [id, state] of Object.entries(states)) {
          await page();
          await openRow(id);
          await record(`${label}-${state}-${tag}`, {
            label,
            width,
            theme,
            id,
            state,
          });
          if (width === 390) {
            const full = await run(() => {
              const d = document.querySelector(".drawer-content");
              const b = d.querySelector(".drawer-body");
              return Math.ceil(
                d.getBoundingClientRect().height -
                  b.clientHeight +
                  b.scrollHeight,
              );
            });
            await metrics(width, Math.max(full, 1000));
            await settle();
            await shot(`${label}-${state}-${tag}-full.png`);
            await metrics(width, 1000);
            await settle();
          }
        }
        if (before) continue;
        // 启动会话 (A-214): in progress, success, failure.
        for (const [op, name, ready] of [
          ["slow", "start-pending", "正在启动…"],
          ["", "start-success", "等待派发"],
          ["fail", "start-failure", "卡片已暂停"],
        ]) {
          await page(op);
          await openRow("A-214");
          await click("启动会话");
          await until(
            `document.querySelector('.drawer-content section[aria-label=当前]')?.textContent.includes(${JSON.stringify(ready)}) || [...document.querySelectorAll('.request-feedback')].some(f => f.textContent.includes(${JSON.stringify(ready)}))`,
          );
          await settle();
          await record(`after-${name}-${tag}`, { width, theme, id: "A-214" });
        }
        // 重启会话 (A-215): in progress, success, failure.
        for (const [op, name, ready] of [
          ["slow", "restart-pending", "正在重启…"],
          ["", "restart-success", "等待派发"],
          ["fail", "restart-failure", "不会另起会话"],
        ]) {
          await page(op);
          await openRow("A-215");
          await click("重启会话");
          await until(
            `[...document.querySelectorAll('.drawer-content section[aria-label=当前], .request-feedback')].some(f => f.textContent.includes(${JSON.stringify(ready)}))`,
          );
          await settle();
          await record(`after-${name}-${tag}`, { width, theme, id: "A-215" });
        }
        // 停止执行… (A-213): the dialog, in progress, failure, success.
        await page();
        await openRow("A-213");
        await click("停止执行…");
        await until("!!document.querySelector('form[aria-label=停止执行]')");
        await settle();
        await record(`after-stop-dialog-${tag}`, { width, theme, id: "A-213" });
        // 返回 writes nothing and gives the focus back to the trigger.
        await click("返回", "dialog");
        await until("!document.querySelector('form[aria-label=停止执行]')");
        await settle();
        const focusAfterCancel = await run(
          () => document.activeElement?.textContent,
        );
        report.shots.at(-1).focusAfterCancel = focusAfterCancel;
        for (const [op, name, ready] of [
          ["slow", "stop-pending", "正在停止…"],
          ["fail", "stop-failure", "worker 暂时无法连接"],
          ["", "stop-success", "已停止 A-213"],
        ]) {
          await page(op);
          await openRow("A-213");
          await click("停止执行…");
          await until("!!document.querySelector('form[aria-label=停止执行]')");
          await click("停止并取消执行", "dialog");
          await until(
            `[...document.querySelectorAll('[role=dialog], .request-feedback')].some(f => f.textContent.includes(${JSON.stringify(ready)}))`,
          );
          await settle();
          await record(`after-${name}-${tag}`, { width, theme, id: "A-213" });
        }
        // 查看改动 (A-213): folded, then two files open (one long line).
        await page();
        await openRow("A-213");
        await click("查看改动");
        await until(
          "!!document.querySelector('[role=dialog] ul[aria-label=已跟踪改动]')",
        );
        await settle();
        await record(`after-diff-${tag}`, { width, theme, id: "A-213" });
        await run(() => {
          const rows = document.querySelectorAll(
            "[role=dialog] ul[aria-label=已跟踪改动] button",
          );
          rows[0].click();
          rows[2].click();
        });
        await settle();
        await record(`after-diff-open-${tag}`, { width, theme, id: "A-213" });
        if (width === 1440 && theme === "light") {
          // The ⋯ menu ends with the stop, after a separator.
          await page();
          await openRow("A-213");
          await run(() =>
            document
              .querySelector("button[aria-label=更多执行操作]")
              .dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: "ArrowDown",
                  bubbles: true,
                }),
              ),
          );
          await until("!!document.querySelector('[role=menu]')");
          await settle();
          await record(`after-menu-${tag}`, { width, theme, id: "A-213" });
        }
      }
  }
  report.errors = browser.errors;
  await writeFile(
    resolve(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log("shots", report.shots.length, "errors", browser.errors.length);
} finally {
  await browser?.close();
  for (const server of servers) await server.close();
}
