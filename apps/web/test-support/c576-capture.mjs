// C-576: the machine settings page without the duplicate 并发与容量 entry —
// the list (占用 / 上限, 最近检查 with its time, row-end 详情), the machine
// drawer, and the drawer with the limit at the host maximum — at 1440/390 in
// light/dark, beside the card list at the same width and theme.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c576-capture.mjs <new output dir>
// C576_BASELINE_REF=<git ref> renders that ref's settings files (before).
// C576_BEFORE=<before output dir> counts differing pixels against it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert(process.argv[2], "Pass a new output directory");
const output = resolve(process.argv[2]);
const baseline = process.env.C576_BASELINE_REF;
const before = process.env.C576_BEFORE && resolve(process.env.C576_BEFORE);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const historical = new Map(
  baseline
    ? [
        "views/MachinesSettings.tsx",
        "views/AgentLimit.tsx",
        "views/SettingsPage.tsx",
        "components/Foundation.tsx",
        "components/Capacity.tsx",
      ].map((path) => [
        resolve(root, "src", path),
        git("show", `${baseline}:apps/web/src/${path}`),
      ])
    : [],
);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c576-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c576")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c576",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c576-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const cases = [];
const shots = {};
const pairs = [];
let browser;
try {
  await mkdir(output);
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
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression, ms = 15000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, `Timed out: ${expression}`);
      await delay(25);
    }
  };
  const has = (text) =>
    `document.body.textContent.includes(${JSON.stringify(text)})`;
  const settle = async () => {
    await evaluate("document.fonts.ready.then(() => true)");
    await run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await delay(150);
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    shots[name] = data;
    return data;
  };
  const open = async (path, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c576${path}`,
    });
    await until(ready);
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  const machinesReady =
    "!!document.querySelector('table[aria-label=\"机器列表\"]') && document.body.textContent.includes('Mac mini')";
  const openDrawer = async () => {
    await run(() => {
      // The row's 详情 where it exists (after), else the name (before).
      const buttons = [
        ...document.querySelectorAll("table[aria-label='机器列表'] button"),
      ];
      const button =
        buttons.find((b) => b.getAttribute("aria-label") === "本机 详情") ??
        buttons.find((b) => b.textContent.trim() === "本机");
      button.click();
      requestAnimationFrame(() => document.activeElement?.blur());
    });
    await until(has("项目绑定"));
    await until("!!document.querySelector('[role=dialog] input[type=number]')");
    await settle();
  };
  const measure = () =>
    run(() => {
      const box = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e),
          b = e.getBoundingClientRect();
        return {
          text: e.textContent.trim().slice(0, 48),
          font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
          color: s.color,
          x: Math.round(b.left * 10) / 10,
          y: Math.round(b.top * 10) / 10,
          w: Math.round(b.width * 10) / 10,
          h: Math.round(b.height * 10) / 10,
        };
      };
      const panel = document.getElementById("machines");
      const table = document.querySelector("table[aria-label='机器列表']");
      const dialog = document.querySelector("[role=dialog]");
      const field = dialog?.querySelector("input[type=number]");
      const row = field?.closest("[class*='row']");
      const p = panel?.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        nav: [
          ...document.querySelectorAll("nav[aria-label='设置分栏'] button"),
        ].map((b) => b.textContent.trim()),
        hash: location.hash,
        panel: box(panel),
        panelTitle: box(panel?.querySelector("h2")),
        panelHelp: box(panel?.querySelector("h2 ~ * button, h2 ~ button")),
        tableOverflow:
          table && p
            ? table.getBoundingClientRect().right > p.right + 0.5
            : null,
        headers: [...(table?.querySelectorAll("th") ?? [])].map(box),
        rows: [...(table?.querySelectorAll("tbody tr") ?? [])].map((r) => ({
          row: box(r),
          cells: [...r.querySelectorAll("td")].map(box),
          buttons: [...r.querySelectorAll("button")].map((b) => ({
            ...box(b),
            label: b.getAttribute("aria-label") ?? b.textContent.trim(),
          })),
        })),
        drawer: dialog
          ? {
              box: box(dialog),
              facts: [...dialog.querySelectorAll("dt")]
                .slice(0, 7)
                .map((dt) => ({
                  label: box(dt),
                  value: box(dt.nextElementSibling),
                })),
              limitRow: box(row),
              limitField: box(field),
              limitDescription: box(row?.querySelector("p") ?? null),
              innerOverflow: [...dialog.querySelectorAll("*")]
                .filter(
                  (e) =>
                    e.getBoundingClientRect().right >
                    dialog.getBoundingClientRect().right + 0.5,
                )
                .slice(0, 5)
                .map(box),
            }
          : null,
      };
    });
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
      const results = {};
      const suffix = `${width}-${theme}.png`;
      await open(
        "/#/p/p-1/cards?view=list",
        "!!document.querySelector('table, .card-list')",
        theme,
      );
      const cards = await shot(`cards-${suffix}`);
      results.cards = await run(() => ({
        title: (() => {
          const h = document.querySelector("h1");
          const s = getComputedStyle(h);
          const b = h.getBoundingClientRect();
          return { font: `${s.fontSize}/${s.lineHeight}`, x: b.left, y: b.top };
        })(),
        headers: [...document.querySelectorAll("th")].slice(0, 2).map((h) => {
          const s = getComputedStyle(h);
          return `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`;
        }),
      }));
      const scene = async (name) => {
        await settle();
        const data = await shot(`${name}-${suffix}`);
        results[name] = await measure();
        pairs.push({ name, width, theme, left: cards, right: data });
      };
      // The old link still lands on the machine page.
      await open("/#/p/p-1/settings?tab=capacity", machinesReady, theme);
      results.legacyLink = await measure();
      await open("/#/p/p-1/settings?tab=machines", machinesReady, theme);
      await scene("machines");
      await openDrawer();
      await scene("machine-drawer");
      await open(
        "/?scene=max#/p/p-1/settings?tab=machines",
        machinesReady,
        theme,
      );
      await openDrawer();
      await until(
        "document.querySelector('[role=dialog] input[type=number]')?.value === '16'",
      );
      await scene("machine-drawer-max");
      // Q-1138: with this host's CI slots, the machine list and the header
      // popover show the same 占用 (3 + 2), counted once.
      await open(
        "/?scene=ci#/p/p-1/settings?tab=machines",
        machinesReady,
        theme,
      );
      await scene("machines-ci");
      await run(() => {
        const button = [...document.querySelectorAll("button")].find((b) =>
          b.getAttribute("aria-label")?.endsWith("查看并发与容量详情"),
        );
        button.click();
      });
      await until("!!document.querySelector('[role=tooltip]')");
      await scene("popover-ci");
      results.ciCounts = await run(() => ({
        list: document
          .querySelector("table[aria-label='机器列表'] tbody tr")
          ?.querySelectorAll("td")[2]
          ?.textContent.trim(),
        popover: [...document.querySelectorAll("[role=tooltip] span")]
          .map((s) => s.textContent.trim())
          .filter((t) => t.startsWith("全部")),
        popoverText: document.querySelector("[role=tooltip]")?.textContent,
      }));
      cases.push({ width, theme, results });
    }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 2 * 1440 + 16,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: "about:blank" });
  await until("location.href === 'about:blank'");
  const images = (fn, ...args) =>
    run(
      async (fn, ...args) => {
        const load = (src) =>
          new Promise((r) => {
            const img = new Image();
            img.onload = () => r(img);
            img.src = `data:image/png;base64,${src}`;
          });
        const imgs = await Promise.all(args.slice(0, 2).map(load));
        return new Function("imgs", "extra", fn)(imgs, args[2]);
      },
      fn,
      ...args,
    );
  for (const { name, width, theme, left, right } of pairs) {
    const png = await images(
      `const [l, r] = imgs; const c = document.createElement("canvas");
       c.width = extra * 2 + 16; c.height = Math.max(l.height, r.height);
       const x = c.getContext("2d"); x.fillStyle = "#888"; x.fillRect(0, 0, c.width, c.height);
       x.drawImage(l, 0, 0); x.drawImage(r, extra + 16, 0);
       return c.toDataURL("image/png").split(",")[1];`,
      left,
      right,
      width,
    );
    await writeFile(
      resolve(output, `side-by-side-cards-${name}-${width}-${theme}.png`),
      Buffer.from(png, "base64"),
    );
  }
  const diffs = {};
  if (before)
    for (const name of Object.keys(shots)) {
      let old;
      try {
        old = (await readFile(resolve(before, name))).toString("base64");
      } catch {
        diffs[name] = "new scene";
        continue;
      }
      diffs[name] = await images(
        `const [a, b] = imgs; if (a.width !== b.width || a.height !== b.height) return "size";
         const px = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
           const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
         const [p, q] = [px(a), px(b)]; let n = 0;
         for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i+1] !== q[i+1] || p[i+2] !== q[i+2] || p[i+3] !== q[i+3]) n++;
         return n;`,
        old,
        shots[name],
      );
    }
  const report = {
    stage: baseline ? "before" : "after",
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain") !== "",
    baseline: baseline ? git("rev-parse", baseline) : null,
    browser: await send("Browser.getVersion"),
    viewport:
      "1440x1000 / 390x1000, DPR 1, prefers-reduced-motion: reduce, software raster flags of the page skeleton baseline",
    fonts:
      "Inter Variable, Noto Sans SC Variable, JetBrains Mono Variable (lockfile @fontsource)",
    fixture:
      "test-support/c576-fixture.tsx: src/testing/machines-fixture.ts (3 synthetic machines, 2 projects), one capacity record (2 Agent machines, 1 CI target), the synthetic card list of src/testing/fixtures.ts; ?scene=max sets 本机's limit to its maximum 16; fixed clock; no backend, host or production data, not production scale",
    cases,
    pixelDiffAgainstBefore: before ? diffs : null,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  // Checked after the report is written, so a failure leaves its numbers.
  if (!baseline)
    for (const { results } of cases) {
      const { list, popover } = results.ciCounts;
      assert.equal(list, "5 / 6", "machine list 占用 with CI slots");
      assert(
        popover.some((t) => t.includes("占用 5 / 上限 6")),
        `popover 占用 with CI slots: ${popover}`,
      );
    }
  assert.deepEqual(browser.errors, []);
  for (const { results } of cases)
    for (const [name, m] of Object.entries(results)) {
      if (name === "cards" || name === "ciCounts") continue;
      assert(m.scrollWidth <= m.innerWidth, `${name}: page overflows`);
      assert(m.hash.includes("tab=machines"), `${name}: not the machine page`);
      assert.deepEqual(
        m.drawer?.innerOverflow ?? [],
        [],
        `${name}: drawer overflows`,
      );
      assert.notEqual(m.tableOverflow, true, `${name}: table leaves the panel`);
    }
  console.log(`C-576 ${report.stage}: ${Object.keys(shots).length} shots`);
} finally {
  await browser?.close();
  await server.close();
}
