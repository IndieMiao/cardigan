// C-831 evidence: the execution detail drawer closes on any click outside it,
// rows included. Before/after on the same synthetic data (C-704 fixture),
// real CDP mouse clicks, plus the card page list and its card preview drawer
// at the same width/theme. Synthetic fixtures only, no business service.
// Usage (repo root): CHROMIUM_PATH=... C831_BASELINE_REF=<sha> \
//   node apps/web/test-support/c831-capture.mjs <output-dir>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = resolve(process.argv[2] ?? "c831-evidence");
const baselineRef = process.env.C831_BASELINE_REF;
assert(baselineRef, "Set C831_BASELINE_REF to the clean baseline commit");
await mkdir(output, { recursive: true });
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = resolve(webRoot, "../..");
const fromBaseline = (path) =>
  execFileSync("git", ["show", `${baselineRef}:${path}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
// CSS @import is read from disk, not through the load hook (see C-824): the
// baseline theme.css inlines the baseline legacy sheets in the same order.
const baselineTheme = () => {
  let css = fromBaseline("apps/web/src/components/ui/theme.css");
  const legacy = [
    ["../../styles.css", "apps/web/src/styles.css"],
    ["../TemplateMarker.css", "apps/web/src/components/TemplateMarker.css"],
    ["../CardLegend.css", "apps/web/src/components/CardLegend.css"],
  ].map(([from, path]) => {
    const line = `@import "${from}" layer(legacy);\n`;
    const text = fromBaseline(path);
    assert(css.includes(line), `baseline ${path}`);
    assert(!/@import|url\(/.test(text), `${path} imports`);
    css = css.replace(line, "");
    return text;
  });
  const end = css.indexOf("\n", css.lastIndexOf("@import")) + 1;
  return `${css.slice(0, end)}@layer legacy {\n${legacy.join("\n")}\n}\n${css.slice(end)}`;
};
const baselineFiles = new Map([
  ...[
    "apps/web/src/components/Drawer.tsx",
    "apps/web/src/views/ExecutionPage.tsx",
  ].map((path) => [resolve(repoRoot, path), fromBaseline(path)]),
  [resolve(repoRoot, "apps/web/src/components/ui/theme.css"), baselineTheme()],
]);
const entries = {
  "/__c704": "/test-support/c704-fixture.tsx",
  "/__skeleton": "/test-support/page-skeleton-fixture.tsx",
};
const serve = (before) =>
  createServer({
    root: webRoot,
    logLevel: "error",
    cacheDir: resolve(
      webRoot,
      `node_modules/.vite-c831-${before ? "before" : "after"}`,
    ),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "c831-evidence",
        enforce: "pre",
        load(id) {
          return before ? baselineFiles.get(id.split("?")[0]) : undefined;
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = req.url?.split("?")[0] ?? "";
            const entry = entries[path];
            if (!entry) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                path,
                `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
  });

const state = `(() => {
  const d = document.querySelector('[role=dialog]');
  return {
    open: Boolean(d),
    title: d?.querySelector('.drawer-title')?.textContent.trim() ?? null,
    overlay: document.querySelector('.drawer-overlay')?.className ?? null,
    bodyPointerEvents: document.body.style.pointerEvents,
    focus: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null,
    hash: location.hash,
    pageScrollWidth: document.documentElement.scrollWidth,
    innerWidth,
  };
})()`;
const measureDrawer = `(() => {
  const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) }; };
  const font = e => { if (!e) return null; const s = getComputedStyle(e); return { fontSize: s.fontSize, lineHeight: s.lineHeight }; };
  const d = document.querySelector('.drawer-content');
  const title = d?.querySelector('.drawer-title');
  const close = d?.querySelector('.drawer-close');
  const overlay = document.querySelector('.drawer-overlay');
  return {
    drawer: box(d),
    title: { ...box(title), ...font(title) },
    close: box(close),
    overlay: overlay && { ...box(overlay), background: getComputedStyle(overlay).backgroundColor, pointerEvents: getComputedStyle(overlay).pointerEvents },
    drawerScroll: d && { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth },
  };
})()`;

const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const report = {
  fixture:
    "C-704 synthetic execution data (C-314: 8 Assignments / 4 Runs), page-skeleton 7 cards; fixed clock. No production data.",
  baselineRef,
  head: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain") !== "",
  dpr: 1,
  viewportHeight: 900,
  fonts: "Inter / Noto Sans SC / JetBrains Mono variable (fontsource)",
  clicks: "CDP Input.dispatchMouseEvent (mouse, left button) at element centre",
  cases: {},
  steps: {},
};
const shots = {};
let browser;
const servers = [];
try {
  browser = await chromium({
    args: [
      "--force-color-profile=srgb",
      "--disable-gpu",
      "--disable-crash-reporter",
    ],
  });
  const { send, evaluate } = browser;
  report.browser = (await send("Browser.getVersion")).product;
  const until = async (expression) => {
    const deadline = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < deadline, expression);
      await delay(50);
    }
  };
  const settle = async () => {
    await evaluate("document.fonts.ready.then(() => true)");
    await evaluate(
      "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))",
    );
    await delay(200);
  };
  const shoot = async (name, width, height) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    shots[name] = data;
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
  /**
   * A real mouse click on the first element matching `selector`: its centre,
   * or with `edge` 4px inside its left edge (the row's own padding, left of
   * the drawer, away from links and buttons).
   */
  const click = async (selector, edge = false) => {
    const point = await evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: ${edge} ? r.x + 4 : r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    assert(point, `missing ${selector}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
    await settle();
    return point;
  };
  /** Park the pointer in the blank bottom-left corner: no hover state. */
  const park = async (height) => {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 1,
      y: height - 1,
      button: "none",
    });
    await settle();
  };
  const pressEscape = async () => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
    await settle();
  };
  const row = (n) =>
    `:is(.execution-table tbody tr.execution-row, .execution-cards .execution-card):nth-of-type(${n})`;
  // A plain cell / non-interactive spot of the row, away from links and buttons.
  const rowSpot = (n, wide) => (wide ? row(n) : `${row(n)} .execution-open`);
  for (const phase of ["before", "after"]) {
    const server = await serve(phase === "before");
    servers.push(server);
    await server.listen();
    const base = server.resolvedUrls.local[0];
    for (const width of [1440, 390]) {
      const height = 900;
      const wide = width === 1440;
      for (const theme of ["light", "dark"]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: !wide,
        });
        await send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-color-scheme", value: theme },
            { name: "prefers-reduced-motion", value: "reduce" },
          ],
        });
        const key = `${width}-${theme}-${phase}`;
        const steps = [];
        const step = async (name) =>
          steps.push({ step: name, ...(await evaluate(state)) });
        const open = async () => {
          // A fresh document each time: a hash-only change keeps focus state.
          await send("Page.navigate", { url: "about:blank" });
          await send("Page.navigate", {
            url: `${base}__c704?mode=table#/p/p-1/execution?view=all`,
          });
          await until(
            `Boolean(document.querySelector(${JSON.stringify(row(2))}))`,
          );
          await park(height);
        };
        await open();
        report.cases[`passthrough-rule-${key}`] = await evaluate(`(() => {
          for (const sheet of document.styleSheets)
            try { for (const r of sheet.cssRules) if (r.cssText.includes('drawer-overlay-passthrough')) return true; } catch {}
          return false;
        })()`);
        await shoot(`execution-closed-${key}`, width, height);
        // Open the first row's detail with the mouse.
        await click(rowSpot(1, wide), wide);
        await step("click row 1");
        await park(height);
        report.cases[`execution-open-${key}`] = await evaluate(measureDrawer);
        await shoot(`execution-open-${key}`, width, height);
        if (wide) {
          // Click another row while the drawer is open.
          await click(rowSpot(2, wide), wide);
          await step("click row 2 while open");
          await park(height);
          await shoot(`execution-row2-${key}`, width, height);
          // Click it again (after: the drawer was closed, so this opens row 2).
          if (
            !(await evaluate(
              "Boolean(document.querySelector('[role=dialog]'))",
            ))
          ) {
            await click(rowSpot(2, wide), wide);
            await step("click row 2 again");
          }
          await click(".execution-table thead th");
          await step("click table header");
          // Blank page padding left of the list, below the last row.
          await click(rowSpot(1, wide), wide);
          await step("click row 1 (reopen)");
          const blank = await evaluate(`(() => {
            const page = document.querySelector('.execution-page').getBoundingClientRect();
            const rows = [...document.querySelectorAll('.execution-table tbody tr')];
            const last = rows[rows.length - 1].getBoundingClientRect();
            return { x: page.left + 4, y: Math.min(innerHeight - 8, last.bottom + 12) };
          })()`);
          report.cases[`blank-point-${key}`] = blank;
          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
            await send("Input.dispatchMouseEvent", {
              type,
              x: blank.x,
              y: blank.y,
              button: type === "mouseMoved" ? "none" : "left",
              clickCount: type === "mouseMoved" ? 0 : 1,
            });
          await settle();
          await step("click blank page edge");
          await click(rowSpot(1, wide), wide);
          await step("click row 1 (reopen)");
        } else {
          // 390: the drawer is 100vw wide, so nothing outside it is visible.
          await step("narrow drawer covers the viewport");
        }
        await pressEscape();
        await step("Escape");
        await click(rowSpot(1, wide), wide);
        await step("click row 1 (reopen)");
        await click(".drawer-close");
        await step("close button");
        report.steps[`execution-${key}`] = steps;

        if (phase === "after") {
          // Card page list (reference) and its card preview drawer.
          // A fresh document each time: a hash-only change keeps focus state.
          await send("Page.navigate", { url: "about:blank" });
          await send("Page.navigate", {
            url: `${base}__skeleton#/p/p-1/cards?view=list`,
          });
          await until(
            "Boolean(document.querySelector('.card-table tbody tr, .card-tile'))",
          );
          await settle();
          await park(height);
          await shoot(`cards-closed-${width}-${theme}`, width, height);
          // A fresh document each time: a hash-only change keeps focus state.
          await send("Page.navigate", { url: "about:blank" });
          await send("Page.navigate", {
            url: `${base}__skeleton#/p/p-1/cards?view=list&card=C-2`,
          });
          await until(
            "Boolean(document.querySelector('[role=dialog] .drawer-title'))",
          );
          await settle();
          report.cases[`cards-open-${width}-${theme}`] =
            await evaluate(measureDrawer);
          await park(height);
          await shoot(`cards-open-${width}-${theme}`, width, height);
          const cardSteps = [];
          cardSteps.push({ step: "open C-2", ...(await evaluate(state)) });
          await click(".card-table tbody tr:nth-of-type(3), .card-tile", true);
          cardSteps.push({
            step: "click another card while open",
            ...(await evaluate(state)),
          });
          report.steps[`cards-${width}-${theme}`] = cardSteps;
        }
      }
    }
  }
  // Side-by-side sheets.
  const pair = async (name, left, right, width) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width: width * 2 + 16,
      height: 900 + 28,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: "about:blank" });
    await evaluate(`(() => {
      document.body.style.cssText = 'margin:0;display:flex;gap:16px;background:#888;font:12px monospace;color:#fff';
      for (const [label, data] of ${JSON.stringify([
        [left, shots[left]],
        [right, shots[right]],
      ])}) {
        const figure = document.createElement('div');
        figure.innerHTML = '<div style="height:28px;line-height:28px;padding-left:4px">' + label + '</div>';
        const img = new Image(); img.src = 'data:image/png;base64,' + data; img.style.display = 'block';
        figure.append(img); document.body.append(figure);
      }
      return Promise.all([...document.images].map(i => i.decode())).then(() => true);
    })()`);
    await shoot(name, width * 2 + 16, 900 + 28);
  };
  // Pixel diff of same-named before/after screenshots, in the browser.
  const diff = (a, b) =>
    evaluate(`(async () => {
      const load = async d => { const i = new Image(); i.src = 'data:image/png;base64,' + d; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
      const [p, q] = await Promise.all([load(${JSON.stringify(shots[a])}), load(${JSON.stringify(shots[b])})]);
      if (p.length !== q.length) return -1;
      let n = 0;
      for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i+1] !== q[i+1] || p[i+2] !== q[i+2] || p[i+3] !== q[i+3]) n++;
      return n;
    })()`);
  report.diffPixels = {};
  await send("Page.navigate", { url: "about:blank" });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"])
      for (const kind of ["closed", "open"]) {
        const k = `execution-${kind}-${width}-${theme}`;
        report.diffPixels[k] = await diff(`${k}-before`, `${k}-after`);
      }
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      if (width === 1440)
        await pair(
          `compare-row2-${width}-${theme}`,
          `execution-row2-${width}-${theme}-before`,
          `execution-row2-${width}-${theme}-after`,
          width,
        );
      await pair(
        `baseline-pair-${width}-${theme}`,
        `execution-open-${width}-${theme}-after`,
        `cards-open-${width}-${theme}`,
        width,
      );
    }
  report.screenshotSha256 = Object.fromEntries(
    await Promise.all(
      Object.keys(shots).map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(resolve(output, `${name}.png`)))
          .digest("hex"),
      ]),
    ),
  );
  await writeFile(
    resolve(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  // Assertions on the after phase.
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const s = report.steps[`execution-${width}-${theme}-after`];
      const at = (name) => s.find((x) => x.step === name);
      assert.equal(at("click row 1").open, true, "row opens the drawer");
      if (width === 1440) {
        assert.equal(at("click row 2 while open").open, false, "row closes");
        assert.match(at("click row 2 again").title ?? "", /^A-/, "then opens");
        assert.notEqual(
          at("click row 2 again").title,
          at("click row 1").title,
          "the second row",
        );
        for (const name of ["click table header", "click blank page edge"])
          assert.equal(at(name).open, false, `${name} closes`);
      }
      for (const name of ["Escape", "close button"])
        assert.equal(at(name).open, false, `${name} closes`);
      for (const x of s) assert.equal(x.pageScrollWidth, x.innerWidth);
      const c = report.steps[`cards-${width}-${theme}`];
      assert.equal(c[1].open, false, "card preview closes on outside click");
    }
  console.log(output);
} finally {
  await browser?.close();
  for (const server of servers) await server.close();
}
