// C-488: card timeline loads older records as the reader scrolls to its bottom,
// on the full page and inside the drawer. Captures 1440/390 × light/dark, the
// card list reference at the same size, and measures row geometry, request
// cursors, duplicates and whether already shown entries move.
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c488-capture.mjs <new output dir>
// C488_BASELINE_REF=<git ref> serves that ref's timeline code for before shots.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass a new output directory");
const baseline = process.env.C488_BASELINE_REF;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const historical = new Map(
  baseline
    ? [
        "views/CardDetailPage.tsx",
        "components/TimelineControls.tsx",
        "useResource.ts",
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
      name: "c488-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c488")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c488",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c488-fixture.tsx"></script></body></html>',
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
  const until = async (expression, ms = 20000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(25);
    }
  };
  const settle = async () => {
    await run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await delay(100);
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    return name;
  };
  const open = async (hash, theme, ready) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c488${hash}`,
    });
    await until(ready);
    await evaluate("document.fonts.ready.then(() => true)");
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  /** Open the timeline tab inside `scope` (the drawer or the whole page). */
  const timelineTab = async (scope) => {
    await run((scope) => {
      const tab = [...document.querySelectorAll(`${scope} [role=tab]`)].find(
        (t) => t.textContent.startsWith("时间线"),
      );
      tab.click();
    }, scope);
    await until("document.querySelectorAll('.timeline-entry').length >= 20");
    await settle();
  };
  /** Scroller: null for the page; the drawer body otherwise. */
  const scrollBottom = (drawer) =>
    run((drawer) => {
      const el = drawer
        ? document.querySelector(".drawer-body")
        : document.scrollingElement;
      el.scrollTop = el.scrollHeight;
    }, drawer);
  const measure = (drawer) =>
    run((drawer) => {
      const px = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el);
        return {
          top: Math.round(r.top * 100) / 100,
          left: r.left,
          width: r.width,
          height: r.height,
          font: `${s.fontSize}/${s.lineHeight}`,
          color: s.color,
        };
      };
      const records = document.querySelector(".timeline-records");
      const pager = records?.lastElementChild;
      const rows = [...document.querySelectorAll(".timeline-entry")];
      const lastEntry = rows.at(-1);
      return {
        entries: rows.length,
        unique: new Set(rows.map((r) => r.id)).size,
        count: document.querySelector(".timeline-count")?.textContent,
        controls: px(document.querySelector(".timeline-controls")),
        controlButtons: [
          ...document.querySelectorAll(".timeline-controls button"),
        ].map((b) => b.textContent),
        pagerText: pager?.textContent ?? null,
        pager: px(pager),
        pagerChild: px(pager?.firstElementChild),
        gapAfterLastEntry:
          pager && lastEntry
            ? pager.getBoundingClientRect().top -
              lastEntry.getBoundingClientRect().bottom
            : null,
        records: px(records),
        scroller: drawer ? px(document.querySelector(".drawer-body")) : null,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
      };
    }, drawer);
  /** Top of the last visible entry; it must not move when a page lands. */
  const pin = () =>
    run(() => {
      const rows = [...document.querySelectorAll(".timeline-entry")];
      const visible = rows.filter(
        (r) => r.getBoundingClientRect().top < innerHeight,
      );
      const row = visible.at(-1);
      return row ? { id: row.id, top: row.getBoundingClientRect().top } : null;
    });
  const topOf = (id) =>
    run((id) => document.getElementById(id)?.getBoundingClientRect().top, id);
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
      const tag = `${width}-${theme}`;
      const result = { width, theme, shots: [] };
      cases.push(result);
      // Reference page: the card list at the same width and theme.
      await open(
        "#/p/p-1/cards?view=list",
        theme,
        "!!document.querySelector('.card-table')",
      );
      result.shots.push(await shot(`cards-${tag}.png`));
      // Full page.
      await open(
        "#/p/p-1/cards/C-1",
        theme,
        "!!document.querySelector('.card-page .card-main')",
      );
      await timelineTab(".card-page");
      await run(() =>
        document.querySelector(".card-timeline").scrollIntoView(),
      );
      await settle();
      result.top = await measure(false);
      result.shots.push(await shot(`page-top-${tag}.png`));
      await run(() => {
        window.c488.hold = true;
      });
      await scrollBottom(false);
      await settle();
      if (baseline) {
        await delay(400);
        result.bottom = await measure(false);
        result.requests = await run(() => window.c488.requests);
        result.shots.push(await shot(`page-bottom-${tag}.png`));
        continue;
      }
      await until("window.c488.pending.length > 0");
      await settle();
      result.loading = await measure(false);
      const pinned = await pin();
      result.shots.push(await shot(`page-loading-${tag}.png`));
      await run(() => {
        window.c488.hold = false;
        for (const release of window.c488.pending.splice(0)) release();
      });
      await until("document.querySelectorAll('.timeline-entry').length >= 40");
      await settle();
      result.loaded = await measure(false);
      result.pinned = { ...pinned, after: await topOf(pinned.id) };
      result.shots.push(await shot(`page-loaded-${tag}.png`));
      for (let i = 0; i < 10; i++) {
        if (
          await evaluate("document.body.textContent.includes('已到最早的记录')")
        )
          break;
        await scrollBottom(false);
        await settle();
        await delay(150);
      }
      await until("document.body.textContent.includes('已到最早的记录')");
      await scrollBottom(false);
      await settle();
      result.end = await measure(false);
      result.requests = await run(() => window.c488.requests);
      result.shots.push(await shot(`page-end-${tag}.png`));
      // Failure and retry.
      await open(
        "#/p/p-1/cards/C-1",
        theme,
        "!!document.querySelector('.card-page .card-main')",
      );
      await run(() => {
        window.c488.fail = true;
      });
      await timelineTab(".card-page");
      await scrollBottom(false);
      await until("document.body.textContent.includes('未能加载更早的记录')");
      await settle();
      result.error = await measure(false);
      result.shots.push(await shot(`page-error-${tag}.png`));
      await run(() => {
        window.c488.fail = false;
        [...document.querySelectorAll(".timeline-records button")]
          .find((b) => b.textContent === "重试")
          .click();
      });
      await until("document.querySelectorAll('.timeline-entry').length >= 40");
      result.retried = await measure(false);
      // Drawer over the card list.
      await open(
        "#/p/p-1/cards?view=list&card=C-1",
        theme,
        "!!document.querySelector('.drawer-content .card-main')",
      );
      await timelineTab(".drawer-content");
      await run(() => {
        window.c488.hold = true;
      });
      await scrollBottom(true);
      await until("window.c488.pending.length > 0");
      await settle();
      result.drawerLoading = await measure(true);
      const drawerPin = await pin();
      result.shots.push(await shot(`drawer-loading-${tag}.png`));
      await run(() => {
        window.c488.hold = false;
        for (const release of window.c488.pending.splice(0)) release();
      });
      await until("document.querySelectorAll('.timeline-entry').length >= 40");
      await settle();
      result.drawerPinned = { ...drawerPin, after: await topOf(drawerPin.id) };
      result.drawerLoaded = await measure(true);
      result.shots.push(await shot(`drawer-loaded-${tag}.png`));
      console.log(
        `${tag}: pinned Δ=${result.pinned.after - result.pinned.top} drawer Δ=${result.drawerPinned.after - result.drawerPinned.top} end=${result.end.entries}/${result.end.unique}`,
      );
    }
  assert.deepEqual(browser.errors, []);
  const report = {
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain") !== "",
    baseline: baseline ? git("rev-parse", baseline) : null,
    browser: await send("Browser.getVersion"),
    viewport: "1440x1000 / 390x1000, DPR 1, prefers-reduced-motion: reduce",
    fixture:
      "test-support/c488-fixture.tsx: 1 synthetic card with 95 timeline entries in 20-entry cursor pages + 2 list cards; not production data",
    cases,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (!baseline)
    for (const c of cases) {
      const label = `${c.width}/${c.theme}`;
      assert.deepEqual(c.top.controlButtons.length, 2, `${label}: controls`);
      assert.equal(c.loading.pagerText, "正在加载更早的记录…", label);
      assert.equal(c.pinned.after, c.pinned.top, `${label}: page jumped`);
      assert.equal(
        c.drawerPinned.after,
        c.drawerPinned.top,
        `${label}: drawer jumped`,
      );
      assert.equal(c.end.entries, 95, `${label}: entries`);
      assert.equal(c.end.unique, 95, `${label}: duplicates`);
      assert.equal(c.end.pagerText, "已到最早的记录", label);
      const cursors = c.requests.flatMap((r) => (r.before ? [r.before] : []));
      assert.deepEqual(cursors, ["76", "56", "36", "16"], `${label}: cursors`);
      assert.match(c.error.pagerText, /^未能加载更早的记录/, label);
      assert.equal(c.retried.entries, 40, `${label}: retry`);
      assert.equal(c.drawerLoaded.entries, 40, `${label}: drawer`);
      for (const m of [c.top, c.loading, c.end, c.error, c.drawerLoaded])
        assert(m.scrollWidth <= m.innerWidth, `${label}: page overflows`);
    }
} finally {
  await browser?.close();
  await server.close();
}
