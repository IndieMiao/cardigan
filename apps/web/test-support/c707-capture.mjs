// C-707: device pairing in the machine page — the panel with its pairing
// entry, a QR link's prefilled first step (steps and field hints on the first
// screen), a refused code, the paired preview, and the passed wizard with the
// onboarding report before the separate remote-launch step — at 1440/390 in
// light/dark, beside the card list at the same width and theme.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c707-capture.mjs <new output dir>
// C707_BASELINE_REF=<git ref> renders that ref's page files (before; only the
// scenes that exist there: machines, manual-form, manual-passed).
// C707_BEFORE=<before output dir> counts differing pixels against it.
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
const baseline = process.env.C707_BASELINE_REF;
const before = process.env.C707_BEFORE && resolve(process.env.C707_BEFORE);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const historical = new Map(
  baseline
    ? [
        "App.tsx",
        "api.ts",
        "views/MachinesSettings.tsx",
        "views/WorkerWizard.tsx",
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
      name: "c707-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c707")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c707",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c707-fixture.tsx"></script></body></html>',
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
      url: `${server.resolvedUrls.local[0]}__c707${path}`,
    });
    await until(ready);
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  const machinesReady =
    "!!document.querySelector('table[aria-label=\"机器列表\"]') && document.body.textContent.includes('Mac mini')";
  const click = (text) =>
    run((text) => {
      const button = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === text,
      );
      if (!button) throw new Error(`no button ${text}`);
      button.click();
      requestAnimationFrame(() => document.activeElement?.blur());
    }, text);
  const typeInto = (label, value) =>
    run(
      (label, value) => {
        const input = [...document.querySelectorAll("[role=dialog] label")]
          .find((l) => l.textContent.startsWith(label))
          ?.querySelector("input");
        const set = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set;
        set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      label,
      value,
    );
  const measure = () =>
    run(() => {
      const box = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e),
          b = e.getBoundingClientRect();
        return {
          text: e.textContent.trim().slice(0, 48),
          font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
          x: Math.round(b.left * 10) / 10,
          y: Math.round(b.top * 10) / 10,
          w: Math.round(b.width * 10) / 10,
          h: Math.round(b.height * 10) / 10,
        };
      };
      const panel = document.getElementById("machines");
      const dialog = document.querySelector("[role=dialog]");
      const report = dialog?.querySelector("table[aria-label='体检报告']");
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        innerHeight,
        hash: location.hash,
        panelActions: [
          ...(panel
            ?.querySelector("h2")
            ?.parentElement?.querySelectorAll("button") ?? []),
        ].map(box),
        drawer: dialog
          ? {
              box: box(dialog),
              title: box(dialog.querySelector("h2")),
              steps: [
                ...dialog.querySelectorAll(
                  "ol[aria-label='添加 worker 的步骤'] li",
                ),
              ].map((li) => ({
                ...box(li),
                state: li.dataset.state,
              })),
              fields: [...dialog.querySelectorAll("form label")].map((l) => ({
                label: box(l),
                control: box(l.querySelector("input, button")),
                hint: box(
                  l.parentElement?.querySelector("[id$='-hint']") ?? null,
                ),
                error: box(
                  l.parentElement?.querySelector("[id]:not([id$='-hint'])") ??
                    null,
                ),
              })),
              submit: box(
                [...dialog.querySelectorAll("button")].find(
                  (b) => b.textContent.trim() === "确认接入",
                ) ?? null,
              ),
              facts: [...dialog.querySelectorAll("dt")].map((dt) => ({
                label: box(dt),
                value: box(dt.nextElementSibling),
              })),
              report: report
                ? {
                    table: box(report),
                    headers: [...report.querySelectorAll("th")].map(box),
                    rows: [...report.querySelectorAll("tbody tr")].map((r) =>
                      [...r.querySelectorAll("td")].map(box),
                    ),
                  }
                : null,
              sections: [...dialog.querySelectorAll("h3")].map(
                (h) => h.textContent,
              ),
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
      const scene = async (name) => {
        await settle();
        const data = await shot(`${name}-${suffix}`);
        results[name] = await measure();
        pairs.push({ name, width, theme, left: cards, right: data });
      };
      await open("/#/p/p-1/settings?tab=machines", machinesReady, theme);
      await scene("machines");
      await click("添加 worker");
      await until(has("预览配置"));
      await scene("manual-form");
      await open(
        "/?scene=manual-passed#/p/p-1/settings?tab=machines",
        machinesReady,
        theme,
      );
      await click("继续添加 worker");
      await until(has("复查"));
      await scene("manual-passed");
      if (!baseline) {
        await run(() =>
          document
            .querySelector("table[aria-label='体检报告']")
            ?.closest("section")
            ?.scrollIntoView({ block: "start" }),
        );
        await scene("manual-report");
        // A QR link: cleared before routing, then the prefilled first step.
        await open(
          "/#/pair/ABCD-EFGH",
          "!!document.querySelector('[role=dialog] form[aria-label=\"配对确认\"]')",
          theme,
        );
        await scene("pairing-form");
        results.linkCleared = await run(() => ({
          href: location.href.replace(location.origin, ""),
          historyLength: history.length,
        }));
        await typeInto("配对码", "EXP2-RED2");
        await click("确认接入");
        await until(has("配对码已过期"));
        await scene("pairing-error");
        await typeInto("配对码", "ABCD-EFGH");
        await click("确认接入");
        await until(has("确认写入配置"));
        await scene("pairing-preview");
        await open(
          "/?scene=passed#/p/p-1/settings?tab=machines",
          machinesReady,
          theme,
        );
        await click("继续添加 worker");
        await until(has("体检报告"));
        await scene("pairing-passed");
        await run(() =>
          document
            .querySelector("table[aria-label='体检报告']")
            ?.closest("section")
            ?.scrollIntoView({ block: "start" }),
        );
        await scene("pairing-report");
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
      "test-support/c707-fixture.tsx: src/testing/machines-fixture.ts (3 synthetic machines), settings-panels-data.ts, 2 synthetic projects, 1 synthetic paired device (self-reported facts) and 1 hand-filled session, the synthetic card list of src/testing/fixtures.ts; fixed clock; no backend, host or production data, not production scale",
    cases,
    pixelDiffAgainstBefore: before ? diffs : null,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  // Checked after the report is written, so a failure leaves its numbers.
  assert.deepEqual(browser.errors, []);
  for (const { results } of cases)
    for (const [name, m] of Object.entries(results)) {
      if (name === "linkCleared") {
        assert(!m.href.includes("pair"), "pairing code left in the URL");
        continue;
      }
      assert(m.scrollWidth <= m.innerWidth, `${name}: page overflows`);
      assert.deepEqual(
        m.drawer?.innerOverflow ?? [],
        [],
        `${name}: drawer overflows`,
      );
      if (name === "pairing-form")
        for (const f of m.drawer.fields)
          assert(
            (f.hint?.y ?? 0) + (f.hint?.h ?? 0) <= m.innerHeight,
            `${name}: hint of ${f.label.text} below the first screen`,
          );
    }
  console.log(`C-707 ${report.stage}: ${Object.keys(shots).length} shots`);
} finally {
  await browser?.close();
  await server.close();
}
