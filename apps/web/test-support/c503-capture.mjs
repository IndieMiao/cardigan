// C-503: story proposal (待确认/展开/修改意见/开卡失败/版本过期/已开卡), the
// completion confirmation and the Needs You row (待确认/失败), light/dark,
// 1440/390, beside the card list page and an ordinary card detail.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c503-capture.mjs <new output dir>
// C503_BASELINE_REF=<git ref> renders that ref's pages (the C-505 read-only frame).
// C503_BEFORE_DIR=<baseline output dir> adds frame | change side-by-sides.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass a new output directory");
const baseline = process.env.C503_BASELINE_REF;
const before = process.env.C503_BEFORE_DIR;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
// Files this card changes; a baseline renders its own copies of them.
const historical = new Map(
  baseline
    ? [
        "views/CardDetailPage.tsx",
        "views/NeedsYouPage.tsx",
        "components/StoryOverview.tsx",
        "components/layout/ChecklistLayout.tsx",
        "components/layout/ChecklistLayout.module.css",
        "components/layout/NeedsRowLayout.tsx",
        "components/layout/NeedsRowLayout.module.css",
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
      name: "c503-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c503")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c503",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c503-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const cases = [];
const hashes = {};
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
      "--hide-scrollbars",
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
  const save = async (name, data) => {
    const bytes = Buffer.from(data, "base64");
    hashes[name] = createHash("sha256").update(bytes).digest("hex");
    await writeFile(resolve(output, name), bytes);
    return data;
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    return save(name, data);
  };
  const open = async (hash, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c503${hash}`,
    });
    await until(ready);
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  /** Bring a section to the top, clear of the sticky section tabs. */
  const reveal = async (selector) => {
    await run((selector) => {
      document.querySelector(selector)?.scrollIntoView({ block: "start" });
      window.scrollBy(0, -64);
    }, selector);
    await settle();
  };
  const click = (selector) =>
    run((selector) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`missing ${selector}`);
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, selector);
  const measure = () =>
    run(() => {
      const css = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
      const font = (el) =>
        el ? `${css(el, "fontSize")}/${css(el, "lineHeight")}` : null;
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
          right: Math.round(r.right),
        };
      };
      const plan = document.querySelector('section[aria-label="拆解方案"]');
      const panel = plan?.querySelector("fieldset");
      const summary = document.querySelector('section[aria-label="对照总结"]');
      const needs = document.querySelector('[aria-label="确认拆解"]');
      const row = needs?.querySelector("article");
      const controls = (scope) =>
        [...(scope?.querySelectorAll("button") ?? [])].map((b) => ({
          name: b.getAttribute("aria-label") ?? b.textContent,
          font: font(b),
          ...box(b),
        }));
      const alert = document.querySelector('[role="alert"]');
      return {
        innerWidth,
        pageScrollWidth: document.documentElement.scrollWidth,
        plan: plan
          ? {
              box: box(plan),
              heading: font(plan.querySelector("h2")),
              panel: panel
                ? {
                    box: box(panel),
                    radius: css(panel, "borderRadius"),
                    padding: css(panel, "padding"),
                    border: css(panel, "borderTopWidth"),
                  }
                : null,
              panelTitle: font(panel?.firstElementChild),
              itemTitle: font(panel?.querySelector("li strong")),
              itemContext: panel?.querySelector("li p")
                ? {
                    font: font(panel.querySelector("li p")),
                    color: css(panel.querySelector("li p"), "color"),
                  }
                : null,
              details: font(panel?.querySelector("details summary")),
              detailsOpen: [...(panel?.querySelectorAll("details") ?? [])].map(
                (d) => d.open,
              ),
              items: panel?.querySelectorAll("ol > li").length ?? 0,
              controls: controls(plan),
              form: box(plan.querySelector("form")),
              empty: plan.querySelector(".empty")?.textContent ?? null,
            }
          : null,
        summary: summary
          ? { box: box(summary), controls: controls(summary) }
          : null,
        needs: row
          ? {
              group: box(needs),
              row: box(row),
              title: font(row.querySelector("h3")),
              summary: font(row.querySelector("h3 + p")),
              controls: controls(row),
            }
          : null,
        alert: alert
          ? {
              text: alert.textContent,
              font: font(alert),
              color: css(alert, "color"),
              ...box(alert),
            }
          : null,
      };
    });
  const detail = (id, extra = "") =>
    `#/p/p-1/cards/${id}${extra ? `?${extra}` : ""}`;
  const detailReady =
    "!!document.querySelector('.card-main [data-card-panel]') && !document.querySelector('.card-main .ui-skeleton')";
  const needsReady =
    "!!document.querySelector('[aria-label=\"确认拆解\"], .needs-tab-content .empty, .needs-tab-content [data-needs-row]')";
  const planSel = 'section[aria-label="拆解方案"]';
  const steps = {
    // [hash, ready, interaction, section to reveal]
    ordinary: [detail("C-700"), detailReady, null, null],
    pending: [detail("C-800"), detailReady, null, null],
    "pending-plan": [detail("C-800"), detailReady, null, planSel],
    "pending-open": [
      detail("C-800"),
      detailReady,
      async () => {
        await run(() => {
          const d = document.querySelectorAll(
            'section[aria-label="拆解方案"] details',
          )[1];
          if (d) d.open = true;
        });
      },
      planSel,
    ],
    comment: [
      detail("C-800"),
      detailReady,
      async () => {
        await run(() => {
          [
            ...document.querySelectorAll(
              'section[aria-label="拆解方案"] button',
            ),
          ]
            .find((b) => b.textContent === "提修改意见")
            ?.click();
        });
        await until("!!document.querySelector('form textarea')");
        await run(() => {
          const field = document.querySelector("form textarea");
          const set = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          ).set;
          set.call(field, "导出按钮先放到列表页，看板以后再加。");
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.blur();
        });
      },
      planSel,
    ],
    failure: [
      detail("C-800", "fail=refused"),
      detailReady,
      async () => {
        await click('button[aria-label="确认开卡：拆解方案第 2 版"]');
        await until("!!document.querySelector('[role=alert]')");
      },
      planSel,
    ],
    stale: [
      detail("C-800", "fail=stale"),
      detailReady,
      async () => {
        await click('button[aria-label="确认开卡：拆解方案第 2 版"]');
        await until("!!document.querySelector('[role=alert]')");
      },
      planSel,
    ],
    confirmed: [detail("C-810"), detailReady, null, planSel],
    summary: [
      detail("C-820"),
      detailReady,
      null,
      'section[aria-label="对照总结"]',
    ],
    needs: ["#/p/p-1/needs-you", needsReady, null, null],
    "needs-failure": [
      "#/p/p-1/needs-you?fail=refused",
      needsReady,
      async () => {
        await click('button[aria-label="确认开卡 C-800 第 2 版"]');
        await until("!!document.querySelector('[role=alert]')");
      },
      null,
    ],
  };
  // The read-only frame (baseline) has none of the interactions.
  const names = baseline
    ? ["pending", "pending-plan", "needs"]
    : Object.keys(steps);
  const pairs = [];
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
      await open(
        "#/p/p-1/cards?view=list",
        "!!document.querySelector('.card-table, .card-records, table')",
        theme,
      );
      const images = { cards: await shot(`cards-${width}-${theme}.png`) };
      const results = {};
      for (const name of names) {
        const [hash, ready, act, section] = steps[name];
        await open(hash, ready, theme);
        if (act) await act();
        if (section) await reveal(section);
        else await settle();
        images[name] = await shot(`${name}-${width}-${theme}.png`);
        results[name] = await measure();
      }
      if (!baseline)
        for (const [left, right] of [
          ["cards", "pending-plan"],
          ["ordinary", "pending-plan"],
          ["ordinary", "failure"],
          ["ordinary", "confirmed"],
          ["cards", "needs"],
          ["cards", "needs-failure"],
        ])
          pairs.push({
            name: `${left}-vs-${right}`,
            width,
            left: images[left],
            right: images[right],
            theme,
          });
      if (!baseline && before)
        for (const name of ["pending-plan", "needs"])
          pairs.push({
            name: `frame-vs-${name}`,
            width,
            theme,
            left: (
              await readFile(resolve(before, `${name}-${width}-${theme}.png`))
            ).toString("base64"),
            right: images[name],
          });
      cases.push({ width, theme, results });
    }
  // Side-by-side: reference (left) | change (right), same width/theme.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 2 * 1440 + 16,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const { name, width, theme, left, right } of pairs) {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    const png = await run(
      async (a, b, width) => {
        const load = (src) =>
          new Promise((r) => {
            const img = new Image();
            img.onload = () => r(img);
            img.src = `data:image/png;base64,${src}`;
          });
        const [l, r] = await Promise.all([load(a), load(b)]);
        const canvas = document.createElement("canvas");
        canvas.width = width * 2 + 16;
        canvas.height = Math.max(l.height, r.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#888";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(l, 0, 0);
        ctx.drawImage(r, width + 16, 0);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      left,
      right,
      width,
    );
    await save(`side-by-side-${name}-${width}-${theme}.png`, png);
  }
  assert.deepEqual(browser.errors, []);
  const report = {
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain") !== "",
    baseline: baseline ? git("rev-parse", baseline) : null,
    browser: await send("Browser.getVersion"),
    viewport:
      "1440x1000 / 390x1000, DPR 1, prefers-reduced-motion: reduce, --hide-scrollbars",
    fonts:
      "Inter Variable, Noto Sans SC Variable, JetBrains Mono Variable (lockfile @fontsource)",
    fixture:
      "test-support/c503-fixture.tsx: 3 synthetic story cards (pending 2nd proposal of 3 children, the same proposal confirmed with 3 children, finished with summary), 1 ordinary card, 1 Needs You proposal row; failures injected client-side (?fail=refused|stale); not production scale",
    hashes,
    cases,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  for (const { width, theme, results } of cases)
    for (const [name, r] of Object.entries(results))
      assert(
        r.pageScrollWidth <= r.innerWidth,
        `${width}/${theme}/${name}: page overflows`,
      );
} finally {
  await browser?.close();
  await server.close();
}
