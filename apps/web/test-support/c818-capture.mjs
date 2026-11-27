// C-818: the device list under the machine settings page — one table per
// machine (型号, 编号, 状态, 占用, 项目, 操作), the 改项目 dialog and a refused
// request's feedback — at 1440/390 in light/dark, beside the card list at the
// same width and theme.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c818-capture.mjs <new output dir>
// C818_BASELINE_REF=<git ref> renders that ref's machine settings (before).
// C818_BEFORE=<before output dir> counts differing pixels against it.
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
const baseline = process.env.C818_BASELINE_REF;
const before = process.env.C818_BEFORE && resolve(process.env.C818_BEFORE);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const historical = new Map(
  baseline
    ? ["views/MachinesSettings.tsx"].map((path) => [
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
      name: "c818-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c818")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c818",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c818-fixture.tsx"></script></body></html>',
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
  const devicesReady = baseline
    ? machinesReady
    : `${machinesReady} && !!document.querySelector('table[aria-label="构建机 的设备"]')`;
  const toDevices = () =>
    run(() => {
      const target =
        document.querySelector("table[aria-label='本机 的设备']") ??
        document.querySelector("table[aria-label='机器列表']");
      target.closest("section").scrollIntoView({ block: "start" });
    });
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
      const p = panel?.getBoundingClientRect();
      const table = (t) => ({
        label: t.getAttribute("aria-label"),
        box: box(t),
        heading: box(t.closest("section")?.querySelector("h3") ?? null),
        overflow: p ? t.getBoundingClientRect().right > p.right + 0.5 : null,
        headers: [...t.querySelectorAll("th")].map(box),
        rows: [...t.querySelectorAll("tbody tr")].map((r) => ({
          row: box(r),
          cells: [...r.querySelectorAll("td")].map(box),
          buttons: [...r.querySelectorAll("button")].map((b) => ({
            ...box(b),
            label: b.getAttribute("aria-label") ?? b.textContent.trim(),
          })),
          ids: [...r.querySelectorAll("[data-ui='id-badge'], .id-tag")].map(
            box,
          ),
        })),
      });
      const dialog = document.querySelector("[role=dialog]");
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        hash: location.hash,
        panel: box(panel),
        panelTitle: box(panel?.querySelector("h2")),
        machineTable: (() => {
          const t = document.querySelector("table[aria-label='机器列表']");
          return t ? { headers: [...t.querySelectorAll("th")].map(box) } : null;
        })(),
        deviceTables: [
          ...document.querySelectorAll("table[aria-label$=' 的设备']"),
        ].map(table),
        dialog: dialog
          ? {
              box: box(dialog),
              title: box(dialog.querySelector("h2")),
              checkboxes: [...dialog.querySelectorAll("[role=checkbox]")].map(
                (c) => ({ ...box(c), checked: c.getAttribute("aria-checked") }),
              ),
              buttons: [...dialog.querySelectorAll("button")]
                .filter((b) => b.getAttribute("role") !== "checkbox")
                .map(box),
            }
          : null,
        feedback: [...document.querySelectorAll(".request-feedback")]
          .map(box)
          .filter((b) => b.text),
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
        cells: [...document.querySelectorAll("td")].slice(0, 2).map((h) => {
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
      await open("/#/p/p-1/settings?tab=machines", devicesReady, theme);
      await scene("machines");
      await toDevices();
      await scene("devices");
      if (!baseline) {
        await run(() => {
          document
            .querySelector(
              "button[aria-label='修改MRR-W39（WGC6R21609003324）的项目']",
            )
            .click();
        });
        await until(
          "!!document.querySelector('[role=dialog] [role=checkbox]')",
        );
        await scene("devices-dialog");
        await open(
          "/?scene=fail#/p/p-1/settings?tab=machines",
          devicesReady,
          theme,
        );
        await toDevices();
        await run(() => {
          document
            .querySelector(
              "button[aria-label='停用MRR-W39（WGC6R21609003324）']",
            )
            .click();
        });
        await until(has("未能停用MRR-W39（WGC6R21609003324）"));
        await run(() => document.activeElement?.blur());
        await scene("devices-failed");
        results.failedRowStatus = await run(
          () =>
            document
              .querySelector("tr[aria-label='MRR-W39（WGC6R21609003324）']")
              ?.querySelectorAll("td")[2]?.textContent,
        );
      }
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
      "test-support/c818-fixture.tsx: src/testing/machines-fixture.ts (3 synthetic machines; 本机 and 构建机 registered by p-1), 4 synthetic devices (held by p-1's R-31/C-1; pending + unauthorized; disabled; unplugged and held by peer's R-9), one capacity record, the synthetic card list of src/testing/fixtures.ts; ?scene=fail refuses device requests with 409; fixed clock; no backend, host, device or production data, not production scale",
    cases,
    pixelDiffAgainstBefore: before ? diffs : null,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  assert.deepEqual(browser.errors, []);
  for (const { results } of cases)
    for (const [name, m] of Object.entries(results)) {
      if (name === "cards" || name === "failedRowStatus") continue;
      assert(m.scrollWidth <= m.innerWidth, `${name}: page overflows`);
      assert(m.hash.includes("tab=machines"), `${name}: not the machine page`);
      for (const t of m.deviceTables)
        assert.notEqual(
          t.overflow,
          true,
          `${name}: ${t.label} leaves the panel`,
        );
    }
  if (!baseline)
    for (const { results } of cases)
      assert.equal(
        results.failedRowStatus?.trim(),
        "可用",
        "a refused request keeps the row",
      );
  console.log(`C-818 ${report.stage}: ${Object.keys(shots).length} shots`);
} finally {
  await browser?.close();
  await server.close();
}
