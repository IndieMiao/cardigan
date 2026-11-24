// C-708: the install entry of the first-batch tools in the machine detail —
// the machine list, the drawer's 能力 table (catalog keys with 安装 on the
// unverified first-batch tools), the install dialog for node on Linux and on
// SteamOS, after 复查 registered it, and the browser search's locations — at
// 1440/390 in light/dark, beside the card list at the same width and theme.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c708-capture.mjs <new output dir>
// C708_BASELINE_REF=<git ref> renders that ref's page files (before; only the
// scenes that exist there: machines, machine-capabilities).
// C708_BEFORE=<before output dir> counts differing pixels against it.
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
const baseline = process.env.C708_BASELINE_REF;
const before = process.env.C708_BEFORE && resolve(process.env.C708_BEFORE);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const historical = new Map(
  baseline
    ? [
        "api.ts",
        "views/MachinesSettings.tsx",
        "components/layout/SettingsLayout.tsx",
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
      name: "c708-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c708")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c708",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c708-fixture.tsx"></script></body></html>',
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
      url: `${server.resolvedUrls.local[0]}__c708${path}`,
    });
    await until(ready);
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  const machinesReady =
    "!!document.querySelector('table[aria-label=\"机器列表\"]') && document.body.textContent.includes('Mac mini')";
  const capabilityTable =
    '[role=dialog] table[aria-label="能力"], [role=dialog] table[aria-label="已验证能力"]';
  const openDrawer = async () => {
    await run(() => {
      const buttons = [
        ...document.querySelectorAll("table[aria-label='机器列表'] button"),
      ];
      buttons.find((b) => b.getAttribute("aria-label") === "本机 详情").click();
    });
    await until(`!!document.querySelector(${JSON.stringify(capabilityTable)})`);
    await run((selector) => {
      // The 能力 section at the top of the drawer body.
      document
        .querySelector(selector)
        .closest("section")
        .scrollIntoView({ block: "start" });
      document.activeElement?.blur();
    }, capabilityTable);
    await settle();
  };
  const installDialog = (name) =>
    `[...document.querySelectorAll('[role=dialog]')].find((d) => d.querySelector('h2')?.textContent.trim() === ${JSON.stringify(name)})`;
  const openInstall = async (key) => {
    await run((key) => {
      document.querySelector(`button[aria-label="安装 ${key}"]`).click();
    }, key);
    await until(`!!${installDialog(`安装 ${key}`)}`);
    await run(() => document.activeElement?.blur());
    await settle();
  };
  const measure = (dialogName) =>
    run(
      (capabilitySelector, dialogName) => {
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
        const overflow = (container) =>
          container
            ? [...container.querySelectorAll("*")]
                .filter(
                  (e) =>
                    e.getBoundingClientRect().right >
                    container.getBoundingClientRect().right + 0.5,
                )
                .slice(0, 5)
                .map(box)
            : [];
        const table = document.querySelector(capabilitySelector);
        const drawer = table?.closest("[role=dialog]");
        const dialog = dialogName
          ? [...document.querySelectorAll("[role=dialog]")].find(
              (d) => d.querySelector("h2")?.textContent.trim() === dialogName,
            )
          : null;
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth,
          hash: location.hash,
          capabilities: table
            ? {
                section: box(table.closest("section")?.querySelector("h3")),
                headers: [...table.querySelectorAll("th")].map(box),
                rows: [...table.querySelectorAll("tbody tr")].map((r) => ({
                  row: box(r),
                  cells: [...r.querySelectorAll("td")].map(box),
                  buttons: [...r.querySelectorAll("button")].map(box),
                })),
                tableOverflow:
                  table.getBoundingClientRect().right >
                  drawer.getBoundingClientRect().right + 0.5,
                drawerOverflow: overflow(drawer),
              }
            : null,
          dialog: dialog
            ? {
                box: box(dialog),
                title: box(dialog.querySelector("h2")),
                facts: [...dialog.querySelectorAll("dt")].map((dt) => ({
                  label: box(dt),
                  value: box(dt.nextElementSibling),
                })),
                systems: [...dialog.querySelectorAll("fieldset button")].map(
                  (b) => ({
                    ...box(b),
                    pressed: b.getAttribute("aria-pressed"),
                  }),
                ),
                commands: box(dialog.querySelector("pre")),
                commandsScroll: (() => {
                  const pre = dialog.querySelector("pre");
                  return pre
                    ? {
                        scrollWidth: pre.scrollWidth,
                        clientWidth: pre.clientWidth,
                      }
                    : null;
                })(),
                footer: [
                  ...dialog.querySelectorAll(".ui-dialog-footer button"),
                ].map(box),
                feedback: [
                  ...dialog.querySelectorAll(".request-feedback-region > *"),
                ].map(box),
                overflow: overflow(dialog),
                inViewport:
                  dialog.getBoundingClientRect().bottom <= innerHeight + 0.5 &&
                  dialog.getBoundingClientRect().top >= -0.5,
              }
            : null,
        };
      },
      capabilityTable,
      dialogName ?? null,
    );
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
      results.cards = await run(() => {
        const h = document.querySelector("h1");
        const s = getComputedStyle(h);
        const b = h.getBoundingClientRect();
        const th = document.querySelector("th");
        const t = th && getComputedStyle(th);
        const button = document.querySelector("button");
        return {
          title: { font: `${s.fontSize}/${s.lineHeight}`, x: b.left, y: b.top },
          header: t && `${t.fontSize}/${t.lineHeight} ${t.fontWeight}`,
          control: button?.getBoundingClientRect().height,
        };
      });
      const scene = async (name, dialog) => {
        await settle();
        const data = await shot(`${name}-${suffix}`);
        results[name] = await measure(dialog);
        pairs.push({ name, width, theme, left: cards, right: data });
      };
      await open("/#/p/p-1/settings?tab=machines", machinesReady, theme);
      await scene("machines");
      await openDrawer();
      await scene("machine-capabilities");
      if (!baseline) {
        await openInstall("node");
        await scene("install-node-linux", "安装 node");
        await run(() => {
          [...document.querySelectorAll("fieldset button")]
            .find((b) => b.textContent.trim() === "SteamOS")
            .click();
          document.activeElement?.blur();
        });
        await until(has("SteamOS 根分区只读"));
        await scene("install-node-steamos", "安装 node");
        await run(() => {
          [...document.querySelectorAll(".ui-dialog-footer button")]
            .find((b) => b.textContent.trim() === "复查")
            .click();
          document.activeElement?.blur();
        });
        await until(
          `${installDialog("安装 node")}?.querySelector('dd')?.parentElement?.parentElement?.textContent.includes('已验证 24.11.0')`,
        );
        await run(() => document.activeElement?.blur());
        await scene("install-node-checked", "安装 node");
        results.afterCheckButtons = await run(() =>
          [...document.querySelectorAll("table[aria-label='能力'] button")].map(
            (b) => b.getAttribute("aria-label"),
          ),
        );
        // A fresh page: node unverified again for the browser scene.
        await open("/#/p/p-1/settings?tab=machines", machinesReady, theme);
        await openDrawer();
        await openInstall("browser.chromium");
        await scene("install-chromium", "安装 browser.chromium");
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
      "test-support/c708-fixture.tsx: src/testing/machines-fixture.ts (3 synthetic machines, 2 projects) with 本机's binding to this project listing 8 catalog keys (2 verified, 6 first-batch tools unverified with built-in probes, browser search locations recorded), one capacity record, the synthetic card list of src/testing/fixtures.ts; 复查 is a fake check that marks node verified; fixed clock; no backend, host or production data, not production scale",
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
      if (name === "cards" || name === "afterCheckButtons") continue;
      assert(m.scrollWidth <= m.innerWidth, `${name}: page overflows`);
      assert(m.hash.includes("tab=machines"), `${name}: not the machine page`);
      assert.deepEqual(
        m.capabilities?.drawerOverflow ?? [],
        [],
        `${name}: drawer overflows`,
      );
      assert.notEqual(
        m.capabilities?.tableOverflow,
        true,
        `${name}: table leaves the drawer`,
      );
      if (m.dialog) {
        assert.deepEqual(m.dialog.overflow, [], `${name}: dialog overflows`);
        assert(m.dialog.inViewport, `${name}: dialog outside the viewport`);
      }
    }
  if (!baseline)
    for (const { results } of cases)
      assert.deepEqual(results.afterCheckButtons, [
        "安装 android.emulator",
        "安装 android.sdk",
        "安装 blender",
        "安装 browser.chromium",
        "安装 godot",
      ]);
  console.log(`C-708 ${report.stage}: ${Object.keys(shots).length} shots`);
} finally {
  await browser?.close();
  await server.close();
}
