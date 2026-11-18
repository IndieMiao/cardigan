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
  const measure = (phase) =>
    run((phase) => {
      const drawer = document.querySelector(".drawer-content");
      const box = drawer?.getBoundingClientRect();
      const title = drawer?.querySelector(".drawer-title");
      const style = title && getComputedStyle(title);
      return {
        phase,
        open: !!drawer,
        loaded: !!drawer?.querySelector(".card-page-drawer"),
        width: box?.width,
        left: box?.left,
        right: box?.right,
        title: style && { font: style.fontSize, line: style.lineHeight },
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
      };
    }, phase);
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
      ]) {
        // A real click on the list row title opens the drawer.
        await run((id) => {
          const link = document.querySelector(
            `.card-table a[href$="/cards/${id}"]`,
          );
          if (!link) throw new Error(`no link for ${id}`);
          link.click();
        }, id);
        // Sample the very first frame the drawer exists, before any data.
        await until("!!document.querySelector('.drawer-content')");
        const first = await measure("first-frame");
        await frames();
        await until("window.c463Pending() > 0");
        const loading = await measure("loading");
        if (open === "first") await shot(`loading-${width}-${theme}.png`);
        await run(() => window.c463Release());
        await until("!!document.querySelector('.drawer-content .card-main')");
        await frames();
        await delay(150);
        const loaded = await measure("loaded");
        if (open === "first") await shot(`loaded-${width}-${theme}.png`);
        const samples = [first, loading, loaded];
        opens.push({ open, id, samples });
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
            ({ open, samples }) =>
              `${open} ${samples.map((s) => s.width).join("→")}`,
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
    fixture: "test-support/c463-fixture.tsx: 3 synthetic cards, gated detail",
    cases,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (!baseline)
    for (const { width, theme, opens } of cases)
      for (const { open, samples } of opens) {
        for (const s of samples) {
          assert(s.open, `${width}/${theme}/${open}/${s.phase}: open`);
          assert(
            s.scrollWidth <= s.innerWidth,
            `${width}/${theme}/${open}/${s.phase}: page overflows`,
          );
          assert.equal(
            s.width,
            samples[0].width,
            `${width}/${theme}/${open}: width changed at ${s.phase}`,
          );
        }
        assert.equal(samples[0].loaded, false, "first frame is loading");
        assert.equal(samples.at(-1).loaded, true, "content loaded");
        assert.equal(
          samples[0].width,
          Math.min(760, width),
          `${width}/${theme}/${open}: drawer width`,
        );
      }
} finally {
  await browser?.close();
  await server.close();
}
