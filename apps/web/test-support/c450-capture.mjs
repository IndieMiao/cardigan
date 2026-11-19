// C-450 (MC-5): machine list, machine drawer, capacity popover and work item
// placement on fixed synthetic data, 1440/390 x light/dark, viewport shots.
// CHROMIUM_PATH=<chrome-headless-shell> node apps/web/test-support/c450-capture.mjs <new output dir>
// C450_BASELINE_REF=<git ref> renders that ref's versions of the MC-5 view
// files (those that exist there) on the same data for before shots; the
// machine drawer is only shot when the ref has one.
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
const baseline = process.env.C450_BASELINE_REF;
const historical = new Map(
  baseline
    ? [
        "views/ExecutionPage.tsx",
        "components/CardSidebar.tsx",
        "components/Capacity.tsx",
        "components/MachineDetail.tsx",
        "components/MachineSummary.tsx",
        "machine-labels.ts",
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
const hasDrawer =
  !baseline ||
  historical.has(resolve(root, "src/components/MachineDetail.tsx"));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c450-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c450")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c450",
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
    "C-450 synthetic: 4 machines (verified/expired/unverified capabilities), 8 Assignments, 3 capacity rows (5 resources; one machine without a row), 3 work items (resource-bound choice, deferred, assigned without audit); no production data",
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
      const clipped = [
        ...document.querySelectorAll(
          ".execution-machines li *, .drawer-content dd, .drawer-content li *, .work-item p, .work-item li, .capacity-tooltip *",
        ),
      ]
        .filter((e) => e.getClientRects().length)
        .filter((e) => {
          const s = getComputedStyle(e);
          return (
            e.scrollWidth > e.clientWidth + 1 &&
            ["hidden", "clip"].includes(s.overflowX) &&
            e.clientWidth > 0
          );
        })
        .map((e) => e.textContent.slice(0, 40));
      const drawer = document.querySelector(".drawer-content");
      const machines = document.querySelector(".execution-machines");
      const workItem = document.querySelector(".work-item");
      const workRect = workItem?.getBoundingClientRect();
      const lineOut = workItem
        ? [...workItem.querySelectorAll("p, li")].some(
            (e) => e.getBoundingClientRect().right > workRect.right + 1,
          )
        : false;
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        clipped,
        lineOutsideWorkItem: lineOut,
        body: font(document.body),
        pageTitle: font(document.querySelector("h1")),
        machinesSummary: font(machines?.querySelector("summary")),
        machineRow: font(machines?.querySelector("li")),
        machineRowBox: box(machines?.querySelector("li")),
        detailButton: box(machines?.querySelector("li button")),
        statusTag: box(machines?.querySelector("li .status")),
        drawer: box(drawer),
        drawerTitle: font(drawer?.querySelector(".drawer-title")),
        drawerDt: font(drawer?.querySelector("dt")),
        drawerDd: font(drawer?.querySelector("dd")),
        drawerH3: font(drawer?.querySelector("h3")),
        drawerListItem: font(drawer?.querySelector(".execution-runs li")),
        capability: box(drawer?.querySelector(".execution-runs li")),
        capacityTooltip: box(document.querySelector(".capacity-tooltip")),
        capacityText: font(
          document.querySelector(".capacity-tooltip .capacity-detail-row span"),
        ),
        workItemText: font(workItem?.querySelector("p")),
        workItemBox: box(workItem),
        focus: document.activeElement?.getAttribute("aria-label") ?? null,
      };
    });
  const shot = async (name) => {
    await frames();
    report.cases[name] = await measure();
    assert(!report.cases[name].overflow, `${name}: page overflow`);
    assert.deepEqual(report.cases[name].clipped, [], `${name}: clipped text`);
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
      url: `${server.resolvedUrls.local[0]}__c450#/p/p-1/${route}`,
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
      // 1. Machine list: open the existing <details> by keyboard.
      await open(
        "execution?view=all",
        "!!document.querySelector('.execution-machines summary') && !!document.querySelector('.capacity-wide')",
        theme,
      );
      await run(() =>
        document.querySelector(".execution-machines summary").focus(),
      );
      await press("Enter", "Enter", 13);
      await until("document.querySelector('.execution-machines').open");
      await run(() =>
        document
          .querySelector(".execution-machines")
          .scrollIntoView({ block: "start" }),
      );
      await shot(`machines-${tag}`);
      // 2. Machine drawers via keyboard; Escape returns focus. Machine 2 has
      // all three capability states; machine 4 has no capacity row.
      if (hasDrawer)
        for (const n of [2, 4]) {
          const trigger = `.execution-machines li:nth-child(${n}) button`;
          await run(
            (trigger) => document.querySelector(trigger).focus(),
            trigger,
          );
          await press("Enter", "Enter", 13);
          await until(
            "!!document.querySelector('.drawer-content .execution-basics')",
          );
          await shot(`machine-drawer-${n}-${tag}`);
          await run(() =>
            [...document.querySelectorAll(".drawer-content section")]
              .at(-2)
              ?.scrollIntoView({ block: "start" }),
          );
          await shot(`machine-drawer-${n}-sections-${tag}`);
          await press("Escape", "Escape", 27);
          await until(
            `!document.querySelector('.drawer-content') && document.activeElement.matches(${JSON.stringify(trigger)})`,
          );
        }
      // 3. Capacity popover by keyboard focus.
      await run(() => {
        scrollTo(0, 0);
        document.querySelector(".capacity-status").focus();
      });
      await until("!!document.querySelector('.capacity-tooltip')");
      await shot(`capacity-${tag}`);
      // 4. Card detail work item placement.
      await open(
        "cards/C-1",
        "!!document.querySelector('.card-section-nav')",
        theme,
      );
      await run(() =>
        [
          ...document.querySelectorAll(
            ".card-section-nav button, .card-section-nav a",
          ),
        ]
          .find((e) => e.textContent.trim().startsWith("工作项"))
          .click(),
      );
      await until("!!document.querySelector('.work-item details')");
      await run(() => {
        for (const d of document.querySelectorAll(".work-item details"))
          d.open = true;
        document.querySelector(".work-item").scrollIntoView({ block: "start" });
      });
      await shot(`work-items-${tag}`);
    }
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
