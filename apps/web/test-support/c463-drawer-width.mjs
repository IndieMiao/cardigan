// C-463: card detail drawer keeps one width from its first frame through
// loading and after load, on the first and later opens.
// CHROMIUM_PATH=<chrome-headless-shell> node apps/web/test-support/c463-drawer-width.mjs <new output dir>
// C463_BASELINE_REF=<git ref> loads that ref's drawer styles for before shots.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass a new output directory");
const baseline = process.env.C463_BASELINE_REF;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const historical = new Map(
  baseline
    ? [
        "components/ui/theme.css",
        "components/layout/CardDetailLayout.module.css",
        "views/CardDetailPage.tsx",
        "views/CardListPage.tsx",
        "components/PageLoader.tsx",
      ].map((path) => [
        resolve(root, "src", path),
        git("show", `${baseline}:apps/web/src/${path}`),
      ])
    : [],
);
// theme.css inlines styles.css from disk, so point it at the baseline copy.
const legacy = resolve(root, "node_modules/.c463-baseline/styles.css");
if (baseline) {
  await mkdir(dirname(legacy), { recursive: true });
  await writeFile(legacy, git("show", `${baseline}:apps/web/src/styles.css`));
  const theme = resolve(root, "src/components/ui/theme.css");
  const source = historical.get(theme);
  assert(source.includes('@import "../../styles.css"'), "theme import");
  historical.set(
    theme,
    source.replace(
      '@import "../../styles.css"',
      '@import "../../../node_modules/.c463-baseline/styles.css"',
    ),
  );
}
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c463-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c463")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c463",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c463-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const cases = [];
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium({
    args: [
      "--run-all-compositor-stages-before-draw",
      "--disable-gpu",
      "--force-color-profile=srgb",
    ],
  });
  const { send, evaluate } = browser;
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
  // Installed in the page before the click: a MutationObserver callback runs
  // right after the drawer is inserted (before the next paint), and a
  // requestAnimationFrame loop samples the layout before every painted frame.
  // Consecutive identical states are collapsed with a count.
  const startTrace = () =>
    run(() => {
      const trace = [];
      let painted = 0;
      const snap = (source) => {
        const drawer = document.querySelector(".drawer-content");
        if (!drawer) return;
        if (source === "frame") painted++;
        const box = drawer.getBoundingClientRect();
        const title = getComputedStyle(drawer.querySelector(".drawer-title"));
        const state = {
          width: box.width,
          left: box.left,
          right: box.right,
          skeleton: !!drawer.querySelector(".drawer-body [data-ui=skeleton]"),
          loaded: !!drawer.querySelector(".card-page-drawer"),
          empty: !!drawer
            .querySelector(".drawer-body")
            ?.textContent.includes("找不到卡片"),
          title: `${title.fontSize}/${title.lineHeight}`,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth,
        };
        const key = JSON.stringify(state);
        const last = trace.at(-1);
        if (last && last.key === key && last.source === source) last.count++;
        else trace.push({ source, key, count: 1, ...state });
      };
      const observer = new MutationObserver(() => snap("mutation"));
      observer.observe(document.body, { childList: true, subtree: true });
      let handle = requestAnimationFrame(function tick() {
        snap("frame");
        handle = requestAnimationFrame(tick);
      });
      window.c463Trace = () => {
        observer.disconnect();
        cancelAnimationFrame(handle);
        return {
          frames: painted,
          trace: trace.map(({ key: _key, ...rest }) => rest),
        };
      };
    });
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
  };
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
      await send("Page.navigate", { url: "about:blank" });
      await until("location.href === 'about:blank'");
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__c463#/p/p-1/cards?view=list`,
      });
      await until("!!document.querySelector('.card-table')");
      await evaluate("document.fonts.ready.then(() => true)");
      await run((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      const opens = [];
      for (const [open, id] of [
        ["first", "C-2"],
        ["repeat", "C-2"],
        ["other", "C-3"],
        ["empty", "C-404"],
      ]) {
        await startTrace();
        // A real click on the list row title opens the drawer.
        await run((id) => {
          const link = document.querySelector(
            `.card-table a[href$="/cards/${id}"]`,
          );
          // C-404 is not listed; open it through the same drawer route.
          if (link) link.click();
          else location.hash = `#/p/p-1/cards?view=list&card=${id}`;
        }, id);
        await until("!!document.querySelector('.drawer-content')");
        await until("window.c463Pending() > 0");
        // Let several frames paint while the request is still pending.
        await frames();
        await frames();
        const placeholder = await run(() => {
          const node = document.querySelector(
            ".drawer-body [data-ui=skeleton]",
          );
          if (!node) return null;
          const box = node.getBoundingClientRect();
          const body = node.parentElement.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            body: { left: body.left, width: body.width },
            box: { left: box.left, top: box.top, width: box.width },
            padding: style.padding,
            gap: style.rowGap,
            bars: [...node.children].map((bar) => {
              const r = bar.getBoundingClientRect(),
                s = getComputedStyle(bar);
              return {
                width: r.width,
                height: r.height,
                radius: s.borderRadius,
                background: s.backgroundColor,
              };
            }),
          };
        });
        if (open === "first") await shot(`loading-${width}-${theme}.png`);
        await run(() => window.c463Release());
        await until(
          "!!document.querySelector('.drawer-content .card-main') || document.querySelector('.drawer-body')?.textContent.includes('找不到卡片')",
        );
        await frames();
        await delay(150);
        await frames();
        if (open === "first") await shot(`loaded-${width}-${theme}.png`);
        if (open === "empty") await shot(`empty-${width}-${theme}.png`);
        const traced = await run(() => window.c463Trace());
        opens.push({ open, id, placeholder, ...traced });
        await run(() =>
          document.querySelector('[aria-label="关闭抽屉"]').click(),
        );
        await until("!document.querySelector('.drawer-content')");
        await frames();
      }
      // Reference: the card list page at the same width and theme.
      await shot(`cards-${width}-${theme}.png`);
      cases.push({ width, theme, opens });
      console.log(
        `${width}/${theme}: ${opens
          .map(
            ({ open, trace }) =>
              `${open} ${trace
                .map(
                  (t) =>
                    `${t.source[0]}${t.width}${t.skeleton ? "S" : ""}${t.loaded ? "L" : ""}${t.empty ? "E" : ""}x${t.count}`,
                )
                .join(" ")}`,
          )
          .join("; ")}`,
      );
    }
  assert.deepEqual(browser.errors, []);
  const report = {
    head: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain") !== "",
    baseline: baseline ? git("rev-parse", baseline) : null,
    browser: await send("Browser.getVersion"),
    viewport: "1440x1000 / 390x1000, DPR 1, prefers-reduced-motion: reduce",
    fixture:
      "test-support/c463-fixture.tsx: 3 synthetic cards + unknown C-404, gated detail; not production scale",
    cases,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (!baseline)
    for (const { width, theme, opens } of cases)
      for (const { open, frames: painted, trace } of opens) {
        const label = `${width}/${theme}/${open}`;
        const [inserted] = trace;
        const firstFrame = trace.find((t) => t.source === "frame");
        // Insertion and the first painted frame are pending, with placeholder.
        assert.equal(inserted?.source, "mutation", `${label}: insertion`);
        for (const t of [inserted, firstFrame])
          assert(t?.skeleton && !t.loaded && !t.empty, `${label}: pending`);
        assert(painted >= 3, `${label}: sampled ${painted} frames`);
        for (const t of trace) {
          assert.equal(t.width, Math.min(760, width), `${label}: width`);
          assert(t.scrollWidth <= t.innerWidth, `${label}: page overflows`);
          // Content replaces the placeholder; never both at once.
          assert(!(t.skeleton && (t.loaded || t.empty)), `${label}: overlap`);
        }
        const last = trace.at(-1);
        assert(
          !last.skeleton && (open === "empty" ? last.empty : last.loaded),
          `${label}: final content`,
        );
      }
} finally {
  await browser?.close();
  await server.close();
}
