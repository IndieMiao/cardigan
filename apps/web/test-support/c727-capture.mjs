// C-727: capability usage notes in the machine detail's 能力 table — the
// notes under their rows (a long Markdown note folded after six lines and
// expanded, a 本机补充, short notes, no row for keys without a note), the
// 编辑说明 entry beside 安装, the edit dialog, a refused save with its
// reason, and the table after a save — at 1440/390 in light/dark, beside the
// card list at the same width and theme.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c727-capture.mjs <new output dir>
// C727_BASELINE_REF=<git ref> renders that ref's page files (before; only the
// scenes that exist there: machines, machine-capabilities).
// C727_BEFORE=<before output dir> counts differing pixels against it.
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
const baseline = process.env.C727_BASELINE_REF;
const before = process.env.C727_BEFORE && resolve(process.env.C727_BEFORE);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const historical = new Map(
  baseline
    ? [
        "api.ts",
        "views/MachinesSettings.tsx",
        "components/layout/SettingsLayout.tsx",
        "components/layout/DataTableLayout.tsx",
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
      name: "c727-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c727")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c727",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c727-fixture.tsx"></script></body></html>',
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
      url: `${server.resolvedUrls.local[0]}__c727${path}`,
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
                notes: [...table.querySelectorAll("tr[data-row-detail]")].map(
                  (r) => ({
                    row: box(r),
                    above: box(r.previousElementSibling),
                    aboveDivider: getComputedStyle(
                      r.previousElementSibling.querySelector("td"),
                    ).borderBottomStyle,
                    labels: [...r.querySelectorAll("dt")].map(box),
                    text: [...r.querySelectorAll(".long-body")].map(box),
                    paragraph: box(r.querySelector(".markdown p")),
                    toggles: [
                      ...r.querySelectorAll(".long-content > button"),
                    ].map((b) => ({
                      ...box(b),
                      expanded: b.getAttribute("aria-expanded"),
                    })),
                  }),
                ),
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
                labels: [...dialog.querySelectorAll("label")].map(box),
                textareas: [...dialog.querySelectorAll("textarea")].map(box),
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
        const emulatorNote =
          "[...document.querySelectorAll('table[aria-label=\"能力\"] tr[data-row-detail]')].find((r) => r.getAttribute('aria-label') === 'android.emulator 使用说明')";
        await run(() => {
          const row = [
            ...document.querySelectorAll(
              'table[aria-label="能力"] tr[data-row-detail]',
            ),
          ].find(
            (r) => r.getAttribute("aria-label") === "android.emulator 使用说明",
          );
          row.querySelector(".long-content > button").click();
          row.previousElementSibling.scrollIntoView({ block: "start" });
          document.activeElement?.blur();
        });
        await until(
          `${emulatorNote}?.querySelector('.long-content > button')?.getAttribute('aria-expanded') === 'true'`,
        );
        await scene("note-expanded");
        await run(() => {
          document
            .querySelector('button[aria-label="编辑 godot 使用说明"]')
            .click();
        });
        await until(`!!${installDialog("godot 使用说明")}`);
        await run(() => document.activeElement?.blur());
        await scene("guide-edit", "godot 使用说明");
        const type = (value) =>
          run((value) => {
            const area = document.querySelector("[role=dialog] textarea");
            const set = Object.getOwnPropertyDescriptor(
              HTMLTextAreaElement.prototype,
              "value",
            ).set;
            set.call(area, value);
            area.dispatchEvent(new Event("input", { bubbles: true }));
          }, value);
        const submit = () =>
          run(() => {
            [...document.querySelectorAll(".ui-dialog-footer button")]
              .find((b) => b.textContent.trim() === "保存使用说明")
              .click();
          });
        await type("导出前设 TOKEN=abc12345xyz 再跑。");
        await submit();
        await until(has("使用说明未保存"));
        await run(() => document.activeElement?.blur());
        await scene("guide-error", "godot 使用说明");
        // The reread after the failed write unlocks 保存 again.
        await until(
          `!document.querySelector(".ui-dialog-footer button[aria-disabled='true']")`,
        );
        await type(
          "导出用 `godot --headless --export-release <预设>`，预设名见 export_presets.cfg。",
        );
        await submit();
        await until(`!${installDialog("godot 使用说明")}`);
        await until(has("export_presets.cfg"));
        await run(() => {
          document
            .querySelector('tr[aria-label="godot 使用说明"]')
            .previousElementSibling.scrollIntoView({ block: "center" });
          document.activeElement?.blur();
        });
        await scene("guide-saved");
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
      "test-support/c727-fixture.tsx: the C-708 fixture (src/testing/machines-fixture.ts, 3 synthetic machines, 2 projects; 本机's binding to this project lists 8 catalog keys) plus 4 synthetic usage notes in an in-memory fake of the C-725 endpoint (android.emulator: 17-line Markdown note + 本机补充; godot and harness.codex: one line); a note naming TOKEN=<value> is refused with the server's message; one capacity record, the synthetic card list of src/testing/fixtures.ts; fixed clock; no backend, host or production data, not production scale",
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
      if (name === "cards") continue;
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
    for (const { results } of cases) {
      const notes = results["machine-capabilities"].capabilities.notes;
      assert.deepEqual(notes.length, 3, "three capabilities have notes");
      for (const note of notes)
        assert.equal(
          note.aboveDivider,
          "none",
          "a note shares its row's divider",
        );
    }
  console.log(`C-727 ${report.stage}: ${Object.keys(shots).length} shots`);
} finally {
  await browser?.close();
  await server.close();
}
