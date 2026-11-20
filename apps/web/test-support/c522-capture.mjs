// C-522: execution view without the machine info section, on the C-450
// synthetic fixture (4 machines, 8 Assignments; no production data).
// 1440/390 x light/dark viewport shots of the execution page (top, bottom and
// machine filter open) and of the card list page as the reference.
// CHROMIUM_PATH=<chrome-headless-shell> FONTCONFIG_FILE=apps/web/test-support/page-skeleton-fonts.conf \
//   node apps/web/test-support/c522-capture.mjs <new output dir>
// C522_BASELINE_REF=<git ref> renders that ref's execution view files on the
// same data for before shots (the machine section is expanded when present).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert(process.argv[2], "Pass a new output directory");
const output = resolve(process.argv[2]);
const baseline = process.env.C522_BASELINE_REF;
const historical = new Map(
  baseline
    ? [
        "views/ExecutionPage.tsx",
        "components/MachineDetail.tsx",
        "components/MachineSummary.tsx",
      ].flatMap((path) => {
        try {
          return [
            [
              resolve(root, "src", path),
              execFileSync(
                "git",
                ["show", `${baseline}:apps/web/src/${path}`],
                {
                  cwd: root,
                  encoding: "utf8",
                  stdio: ["ignore", "pipe", "ignore"],
                },
              ),
            ],
          ];
        } catch {
          return [];
        }
      })
    : [],
);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c522-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        // Deleted files only exist in the baseline.
        if (historical.has(source)) return source;
        if (!importer || !source.startsWith(".")) return;
        const path = resolve(importer.split("?")[0], "..", source).replace(
          /\.js$/,
          ".tsx",
        );
        if (historical.has(path)) return path;
      },
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c522")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c522",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c450-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const report = {
  fixture:
    "C-450 synthetic (apps/web/test-support/c450-fixture.tsx): 4 machines, 8 Assignments, 3 capacity rows, 1 card; fixed clock; no production data",
  baseline_ref: baseline ?? null,
  viewport_height: 1000,
  dpr: 1,
  cases: {},
};
let browser;
try {
  await mkdir(output, { recursive: true });
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
      await delay(25);
    }
  };
  const frames = () =>
    run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  const press = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode,
        ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}),
      });
    await delay(60);
  };
  const measure = () =>
    run(() => {
      const font = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e);
        return `${s.fontSize}/${s.lineHeight}`;
      };
      const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
          x: Math.round(r.x * 10) / 10,
          y: Math.round(r.y * 10) / 10,
          w: Math.round(r.width * 10) / 10,
          h: Math.round(r.height * 10) / 10,
        };
      };
      const content = document.querySelector(".ui-workspace");
      const last = content?.lastElementChild;
      const toolbarControls = [
        ...document.querySelectorAll(
          '.ui-filter-bar button, .ui-filter-bar input, .ui-filter-bar [role="combobox"]',
        ),
      ]
        .filter((e) => e.getClientRects().length)
        .map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10);
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        scrollHeight: document.documentElement.scrollHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
        machinesSection: !!document.querySelector(".execution-machines"),
        machinesSummaryText:
          document.querySelector(".execution-machines summary")?.textContent ??
          null,
        machineDetailButtons: [...document.querySelectorAll("button")].filter(
          (b) => /机器详情$/.test(b.getAttribute("aria-label") ?? ""),
        ).length,
        machineColumn: [...document.querySelectorAll("th")].some(
          (th) => th.textContent.trim() === "机器",
        ),
        machineFilter:
          [...document.querySelectorAll('[role="combobox"]')]
            .map((e) => e.getAttribute("aria-label") ?? e.textContent)
            .find((t) => t?.startsWith("机器：")) ?? null,
        pageTitle: font(document.querySelector("h1")),
        pageTitleBox: box(document.querySelector("h1")),
        toolbar: box(document.querySelector(".ui-filter-bar")),
        actionRow: box(document.querySelector(".ui-filter-bar .ui-action-row")),
        toolbarControlHeights: [...new Set(toolbarControls)],
        tableHead: font(document.querySelector("th")),
        tableCell: font(document.querySelector("td")),
        firstRow: box(document.querySelector("tbody tr")),
        lastContentChild: last
          ? {
              className: String(last.className),
              bottom:
                Math.round(
                  (last.getBoundingClientRect().bottom + scrollY) * 10,
                ) / 10,
            }
          : null,
        contentBox: box(content),
        menuItems: [...document.querySelectorAll('[role="option"]')].map((e) =>
          e.textContent.trim(),
        ),
        focus:
          document.activeElement?.getAttribute("aria-label") ??
          document.activeElement?.textContent?.slice(0, 30) ??
          null,
      };
    });
  const shot = async (name) => {
    await frames();
    report.cases[name] = await measure();
    assert(!report.cases[name].overflow, `${name}: page overflow`);
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
  const open = async (route, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c522#/p/p-1/${route}`,
    });
    await until(ready);
    await evaluate("document.fonts.ready.then(() => true)");
    await run((theme) => {
      localStorage.clear();
      document.documentElement.dataset.theme = theme;
    }, theme);
    await frames();
  };
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const tag = `${width}-${theme}`;
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
      const ready =
        "!!document.querySelector('.execution-page h1') && !!document.querySelector('.execution-page [aria-label^=\"查看 A-\"]')";
      await open("execution?view=all", ready, theme);
      // Before: the user's screenshot shows the section expanded.
      await run(() => {
        const d = document.querySelector(".execution-machines");
        if (d) d.open = true;
      });
      await shot(`execution-top-${tag}`);
      await run(() => scrollTo(0, document.documentElement.scrollHeight));
      await shot(`execution-bottom-${tag}`);
      // Machine filter: open by keyboard.
      await run(() => {
        scrollTo(0, 0);
        [...document.querySelectorAll('[role="combobox"]')]
          .find((e) =>
            (e.getAttribute("aria-label") ?? "").startsWith("机器："),
          )
          .focus();
      });
      await press("Enter", "Enter", 13);
      await until("!!document.querySelector('[role=\"option\"]')");
      await shot(`execution-filter-${tag}`);
      await press("Escape", "Escape", 27);
      // Reference: card list page, same width and theme.
      await open(
        "cards?view=list",
        "!!document.querySelector('h1') && !!document.querySelector('tbody tr, .board-card')",
        theme,
      );
      await shot(`cards-${tag}`);
    }
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
