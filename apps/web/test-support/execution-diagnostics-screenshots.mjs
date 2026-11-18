import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-464: execution diagnostics placement evidence. Pass a new output directory.
const output = process.argv[2];
assert(output, "Pass a new screenshot output directory");
await mkdir(output, { recursive: false });
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = {
  __execution_diagnostics: "execution-diagnostics",
  __skeleton: "page-skeleton",
};
// UI_BASELINE_REF renders the "before" page: changed src files load from that ref.
const baseline = process.env.UI_BASELINE_REF;
const historical = new Map(
  baseline
    ? execFileSync(
        "git",
        ["diff", "--name-only", "--diff-filter=M", baseline, "--", "src"],
        { cwd: root, encoding: "utf8" },
      )
        .split("\n")
        .filter(Boolean)
        .map((path) => [
          resolve(root, "..", "..", path),
          execFileSync("git", ["show", `${baseline}:${path}`], {
            cwd: root,
            encoding: "utf8",
          }),
        ])
    : [],
);
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "execution-diagnostics-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const route = Object.keys(fixtures).find((r) =>
            req.url?.startsWith(`/${r}`),
          );
          if (!route) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              `/${route}`,
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/${fixtures[route]}-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const report = {
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean),
  fixture:
    "非生产规模数据：执行视图 8 个合成 Assignment（executionDisplayFixture）+ 诊断四态（检查中/无告警/不可用/1 配置告警+2 会话异常）；卡片页 7 张合成卡（page-skeleton-fixture）",
  viewport: "1440×1000 / 390×1000, DPR 1",
  baseline: baseline ?? null,
  historicalSources: [...historical.keys()].map((p) => relative(root, p)),
  cases: {},
};
let browser;
try {
  await server.listen();
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
  const { send, evaluate } = browser;
  report.browser = (await send("Browser.getVersion")).product;
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const modes = [
    "checking",
    "ok",
    "ok-open",
    "unavailable",
    "warn",
    "warn-open",
  ];
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      for (const mode of ["cards", ...modes]) {
        await send("Page.navigate", { url: "about:blank" });
        await until("location.href === 'about:blank'");
        const base = server.resolvedUrls.local[0];
        await send("Page.navigate", {
          url:
            mode === "cards"
              ? `${base}__skeleton#/p/p-1/cards?view=list`
              : `${base}__execution_diagnostics?diag=${mode.replace("-open", "")}#/p/p-1/execution`,
        });
        await until(
          "!!document.querySelector('.capacity-wide') && !!document.querySelector('.card-table, .execution-cards, .board-list')",
        );
        if (mode !== "cards" && mode !== "checking")
          await until(
            "!document.body.textContent.includes('检查中') || !!document.querySelector('[data-diagnostics-state]:not([data-diagnostics-state=checking])')",
          );
        await evaluate("document.fonts.ready.then(() => true)");
        await run((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        if (mode === "ok-open") {
          await run(() =>
            document
              .querySelector(
                "[data-diagnostics-trigger], .execution-diagnostics summary",
              )
              .click(),
          );
          await until("document.body.textContent.includes('没有告警')");
        }
        if (mode === "warn-open") {
          await run(() => {
            const trigger = document.querySelector(
              "[data-diagnostics-trigger], .execution-diagnostics summary",
            );
            trigger.click();
          });
          await until("document.body.textContent.includes('等待交互确认')");
        }
        await run(async (keep) => {
          if (!keep) document.activeElement?.blur();
          window.scrollTo(0, 0);
          await new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          );
        }, mode === "ok-open");
        await delay(250);
        const metrics = await run(() => {
          const box = (e) => {
            if (!e) return null;
            const r = e.getBoundingClientRect(),
              s = getComputedStyle(e);
            return {
              x: Math.round(r.x * 100) / 100,
              y: Math.round(r.y * 100) / 100,
              width: Math.round(r.width * 100) / 100,
              height: Math.round(r.height * 100) / 100,
              right: Math.round(r.right * 100) / 100,
              bottom: Math.round(r.bottom * 100) / 100,
              font: `${s.fontSize}/${s.lineHeight}`,
              padding: s.padding,
            };
          };
          const q = (s) => document.querySelector(s);
          const toolbar = q(".ui-filter-bar");
          const content = q(
            ".card-table-scroll, .execution-cards, .board-list, .execution-groups",
          );
          const diag = q(
            "[data-diagnostics-trigger], .execution-diagnostics summary",
          );
          const alert = q("[data-diagnostics-alert], .execution-diagnostics");
          const workspace = q(".ui-workspace");
          return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth,
            overflow: document.documentElement.scrollWidth > innerWidth,
            title: box(q(".ui-page-header h1")),
            header: box(q(".ui-page-header")),
            capacity: box(q(".ui-page-capacity")),
            toolbar: box(toolbar),
            actionRow: box(q(".ui-action-row")),
            refresh: box(q(".ui-action-row button")),
            content: box(content),
            workspace: box(workspace),
            toolbarToContent:
              toolbar && content
                ? Math.round(
                    (content.getBoundingClientRect().top -
                      toolbar.getBoundingClientRect().bottom) *
                      100,
                  ) / 100
                : null,
            diagnosticsTrigger: box(diag),
            diagnosticsTriggerText: diag?.textContent?.trim() ?? null,
            diagnosticsBlock: box(alert),
            diagnosticsPopover: box(q("[data-diagnostics-panel]")),
            diagnosticsText:
              (q("[data-diagnostics-panel]") ?? alert)?.innerText ?? null,
          };
        });
        assert(!metrics.overflow, `${mode}/${width}/${theme}: page overflows`);
        const name = `${mode}-${width}-${theme}`;
        report.cases[name] = metrics;
        const shot = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(
          resolve(output, `${name}.png`),
          Buffer.from(shot.data, "base64"),
        );
      }
    }
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
