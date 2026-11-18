// C-459 evidence: Needs You tabs before/after with synthetic data.
// Usage: node test-support/needs-you-screenshots.mjs <output> <before|after>
// `before` renders apps/web/src from NEEDS_BASELINE_REF; the fixture is shared.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "../../artifacts/c459");
const phase = process.argv[3] === "before" ? "before" : "after";
const baseline =
  process.env.NEEDS_BASELINE_REF ?? "1279eac7f543489bb8755f38068a6a32a17144e7";
await mkdir(output, { recursive: true });
const tabs = [
  ["decisions", "待拍板"],
  ["merges", "合并确认"],
  ["actions", "待你执行"],
  ["later", "稍后"],
  ["notices", "知会"],
];
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "needs-you-fixture",
      enforce: "pre",
      load(id) {
        const file = id.split("?")[0];
        if (phase !== "before" || !file.startsWith(`${root}src/`)) return;
        const relative = file.slice(root.length);
        if (!/\.(tsx?|css)$/.test(relative)) return;
        try {
          return execFileSync(
            "git",
            ["show", `${baseline}:apps/web/${relative}`],
            { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch {
          return;
        }
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__needs")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__needs",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/needs-you-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
const results = [];
try {
  await server.listen();
  browser = await chromium({
    args: [
      "--run-all-compositor-stages-before-draw",
      "--disable-gpu",
      "--force-color-profile=srgb",
      "--num-raster-threads=1",
    ],
  });
  const { send, evaluate } = browser;
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const version = await send("Browser.getVersion");
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
      await send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
      const scenarios = tabs.flatMap(([key, label]) => [
        { key, label, expanded: false },
        ...(phase === "after" &&
        ["decisions", "merges", "actions"].includes(key)
          ? [{ key, label, expanded: true }]
          : []),
      ]);
      for (const { key, label, expanded } of scenarios) {
        await send("Page.navigate", { url: "about:blank" });
        await until("location.href === 'about:blank'");
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__needs#/p/p-1/needs-you`,
        });
        await until("!!document.querySelector('[role=tab]:not([disabled])')");
        await evaluate("document.fonts.ready.then(() => true)");
        await run((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await run((label) => {
          [...document.querySelectorAll("[role=tab]")]
            .find((tab) => tab.textContent.startsWith(label))
            .click();
        }, label);
        await until(
          "!!document.querySelector('[role=tabpanel]:not([hidden]) article, [role=tabpanel]:not([hidden]) li, [role=tabpanel]:not([hidden]) .empty')",
        );
        if (expanded) {
          await run(() => {
            document
              .querySelector(
                "[role=tabpanel]:not([hidden]) [data-needs-row] [aria-expanded=false]",
              )
              ?.click();
          });
          await until(
            "!!document.querySelector('[role=tabpanel]:not([hidden]) [aria-expanded=true]')",
          );
        }
        await run(async () => {
          document.activeElement?.blur();
          window.scrollTo(0, 0);
          await new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          );
        });
        await delay(250);
        const metrics = await run(() => {
          const box = (e) => {
            const r = e.getBoundingClientRect(),
              s = getComputedStyle(e);
            return {
              text: (e.getAttribute("aria-label") || e.textContent)
                .trim()
                .slice(0, 40),
              x: Math.round(r.x * 10) / 10,
              y: Math.round(r.y * 10) / 10,
              right: Math.round(r.right * 10) / 10,
              width: Math.round(r.width * 10) / 10,
              height: Math.round(r.height * 10) / 10,
              font: s.fontSize,
              line: s.lineHeight,
              weight: s.fontWeight,
            };
          };
          const panel = document.querySelector("[role=tabpanel]:not([hidden])");
          const visible = (e) => e.getClientRects().length > 0;
          return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth,
            overflow: document.documentElement.scrollWidth > innerWidth,
            title: [...document.querySelectorAll("h1")].map(box),
            tabs: [...document.querySelectorAll("[role=tab]")].map(box),
            rows: [
              ...(panel?.querySelectorAll("[data-needs-row], article, li") ??
                []),
            ]
              .filter(visible)
              .slice(0, 8)
              .map(box),
            rowTitles: [
              ...(panel?.querySelectorAll("[data-needs-row-title], h3") ?? []),
            ]
              .filter(visible)
              .slice(0, 8)
              .map(box),
            primary: [
              ...(panel?.querySelectorAll("[data-needs-row-action] button") ??
                []),
            ]
              .filter(visible)
              .map(box),
            buttons: [...(panel?.querySelectorAll("button") ?? [])]
              .filter(visible)
              .slice(0, 16)
              .map(box),
            pageHeight: document.documentElement.scrollHeight,
          };
        });
        assert(!metrics.overflow, `${key}/${width}/${theme}: page overflows`);
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        const name = `${phase}-${key}${expanded ? "-expanded" : ""}-${width}-${theme}.png`;
        await writeFile(resolve(output, name), Buffer.from(data, "base64"));
        results.push({ name, ...metrics });
        console.log(`Captured ${name}`);
        await evaluate("localStorage.clear()");
      }
      if (phase === "after") {
        // Side by side with the reviewed card-page baseline of the same width/theme.
        const reference = (
          await readFile(
            resolve(
              root,
              `test-support/page-skeleton-snapshots/list-${width}-${theme}.png`,
            ),
          )
        ).toString("base64");
        for (const key of ["decisions", "merges", "notices"]) {
          const mine = (
            await readFile(
              resolve(output, `after-${key}-${width}-${theme}.png`),
            )
          ).toString("base64");
          const joined = await run(
            async (a, b) => {
              const load = async (d) =>
                createImageBitmap(
                  await (await fetch(`data:image/png;base64,${d}`)).blob(),
                );
              const [left, right] = await Promise.all([load(a), load(b)]);
              const gap = 16;
              const canvas = new OffscreenCanvas(
                left.width + gap + right.width,
                Math.max(left.height, right.height),
              );
              const ctx = canvas.getContext("2d");
              ctx.fillStyle = "#888";
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(left, 0, 0);
              ctx.drawImage(right, left.width + gap, 0);
              const blob = await canvas.convertToBlob({ type: "image/png" });
              const bytes = new Uint8Array(await blob.arrayBuffer());
              let text = "";
              for (const b of bytes) text += String.fromCharCode(b);
              return btoa(text);
            },
            reference,
            mine,
          );
          const name = `side-by-side-cards-vs-${key}-${width}-${theme}.png`;
          await writeFile(resolve(output, name), Buffer.from(joined, "base64"));
          console.log(`Composed ${name}`);
        }
      }
    }
  if (phase === "after") {
    // Real-CSS regressions (C-459 V-2057/V-2060): takeover gating and focus.
    const checks = [];
    for (const width of [1440, 390]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const load = async (label) => {
        await send("Page.navigate", { url: "about:blank" });
        await until("location.href === 'about:blank'");
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__needs#/p/p-1/needs-you`,
        });
        await until("!!document.querySelector('[role=tab]:not([disabled])')");
        await run((label) => {
          [...document.querySelectorAll("[role=tab]")]
            .find((tab) => tab.textContent.startsWith(label))
            .click();
        }, label);
        await until(
          "!!document.querySelector('[role=tabpanel]:not([hidden]) [data-needs-row]')",
        );
      };
      const press = async (name) => {
        await run((name) => {
          const button = [
            ...document.querySelectorAll(
              "[role=tabpanel]:not([hidden]) button, [role=dialog] button",
            ),
          ].find(
            (b) =>
              (b.getAttribute("aria-label") || b.textContent.trim()) === name,
          );
          button.focus();
          button.click();
        }, name);
        await delay(150);
      };
      const active = () =>
        run(() => {
          const e = document.activeElement;
          return (
            e?.getAttribute("aria-label") ||
            e?.labels?.[0]?.textContent?.trim().slice(0, 30) ||
            e?.textContent?.trim().slice(0, 30)
          );
        });
      const controls = () =>
        run(() => {
          const form = document.querySelector(
            '[aria-label="合并确认 Q-6"] form[aria-label="合并处理操作"]',
          );
          const buttons = [...form.querySelectorAll("button")];
          return {
            hidden: form.hidden,
            display: getComputedStyle(form).display,
            height: form.getBoundingClientRect().height,
            visibleButtons: buttons.filter((b) => b.getClientRects().length)
              .length,
          };
        });
      await load("待拍板");
      await press("处理 Q-1");
      checks.push({ width, case: "处理 Q-1", focus: await active() });
      await load("待你执行");
      await press("处理 H-1");
      checks.push({ width, case: "处理 H-1", focus: await active() });
      await load("合并确认");
      await press("处理 Q-3");
      checks.push({ width, case: "处理 Q-3", focus: await active() });
      await press("查看 Q-6");
      const before = await controls();
      checks.push({
        width,
        case: "PM 行展开、未接手",
        focus: await active(),
        ...before,
      });
      assert.equal(before.display, "none", "PM controls must stay hidden");
      assert.equal(before.visibleButtons, 0);
      await press("接手处理");
      await press("取消");
      const cancelled = await controls();
      checks.push({ width, case: "取消接手", ...cancelled });
      assert.equal(cancelled.display, "none");
      await press("接手处理");
      await press("确认接手");
      const after = await controls();
      checks.push({ width, case: "确认接手后", ...after });
      assert.notEqual(after.display, "none");
      assert(after.visibleButtons > 0);
      await load("知会");
      const titles = await run(() =>
        [
          ...document.querySelectorAll(
            "[role=tabpanel]:not([hidden]) [data-needs-row-title]",
          ),
        ].map((h) => h.textContent),
      );
      checks.push({ width, case: "知会标题", titles });
      assert.equal(new Set(titles).size, titles.length, "notice titles differ");
      const gap = await run(() => {
        const tabs = document.querySelector("[role=tablist]");
        const group = document.querySelector(
          "[role=tabpanel]:not([hidden]) section.needs-group",
        );
        return (
          group.getBoundingClientRect().top -
          tabs.getBoundingClientRect().bottom
        );
      });
      checks.push({ width, case: "标签栏到组框间距", gap });
    }
    for (const c of checks) console.log(JSON.stringify(c));
    const expected = {
      "处理 Q-1": "a灰度发布",
      "处理 H-1": "H-1 执行结果",
      "处理 Q-3": "确认合并",
      "PM 行展开、未接手": "接手处理",
    };
    for (const c of checks)
      if (expected[c.case])
        assert(
          String(c.focus).startsWith(expected[c.case]),
          `${c.case}: focus ${c.focus}`,
        );
    await writeFile(
      resolve(output, "after-checks.json"),
      `${JSON.stringify(checks, null, 2)}\n`,
    );
  }
  assert.deepEqual(browser.errors, []);
  await writeFile(
    resolve(output, `${phase}-measurements.json`),
    `${JSON.stringify({ phase, baseline: phase === "before" ? baseline : "working tree", browser: version, dpr: 1, viewport: "1440x1000 / 390x1000", fonts: ["Inter Variable", "Noto Sans SC Variable", "JetBrains Mono Variable"], cases: results }, null, 2)}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
