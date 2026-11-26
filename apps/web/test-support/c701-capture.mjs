// C-701: the main-action dock on the card detail (page and drawer) at
// 1440×1000 and 390×844, light and dark. Uses the C-695 fixture with `?long`
// (40 timeline entries), opens the timeline tab and scrolls 700px so the
// “下一步” panel is gone. Five cards: four with a main action (C-48 标记完成,
// C-702 处理合并确认, C-704 回答问题, C-705 处理拍板) and C-701, which waits
// on someone else and has none. C-48 is also shot unscrolled, and the card
// list page (the baseline page) at the same viewport and theme.
//
// Each scrolled shot records the dock box, title and button, the sticky tab
// bar under it, and where an entry scrolled to with block "start" lands
// (the anchor rule). Synthetic data only; same browser flags as the
// page-skeleton check.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c701-capture.mjs <new dir>
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outArg = process.argv[2];
assert(outArg, "Pass a new output directory");
const output = resolve(outArg);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c695-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c695")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c695",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c695-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const cards = ["C-48", "C-702", "C-704", "C-705", "C-701"];
let browser;
const report = { shots: [] };
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
  report.browser = (await send("Browser.getVersion")).product;
  const run = (fn, ...a) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(a)})`);
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const settle = () =>
    run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  const shot = async (name) => {
    await delay(250);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    console.log(`Captured ${name}`);
  };
  const open = async (hash, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c695?long#/p/p-1/${hash}`,
    });
    await until(ready);
    await evaluate("document.fonts.ready.then(() => true)");
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  // The element that scrolls the detail: the drawer body or the page's.
  const scroller = () => {
    const article = document.querySelector("article.card-page");
    let node = article?.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        node.scrollHeight > node.clientHeight
      )
        return node;
      node = node.parentElement;
    }
    return document.scrollingElement;
  };
  const scrollBy = (by) =>
    evaluate(`(${scroller.toString()})().scrollTop += ${by}`);
  const measure = () =>
    run(() => {
      const rect = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
          bottom: Math.round(r.bottom),
        };
      };
      const font = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e);
        return `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`;
      };
      const article = document.querySelector("article.card-page");
      const dock = article?.querySelector("section[aria-label='主操作']");
      const title = dock?.firstElementChild;
      const button = dock?.querySelector("[data-ui=button]");
      const panel = article?.querySelector("section[aria-label='下一步']");
      const tabs = article?.querySelector(".card-section-nav");
      const header = article?.querySelector(".card-header");
      const body = document.querySelector(".drawer-body");
      const style = dock && getComputedStyle(dock);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        article: rect(article),
        content: rect(header),
        panel: rect(panel),
        dock: dock && {
          ...rect(dock),
          background: style.backgroundColor,
          borderBottom: `${style.borderBottomWidth} ${style.borderBottomStyle} ${style.borderBottomColor}`,
          paddingInline: `${style.paddingLeft} ${style.paddingRight}`,
          title: title?.textContent,
          titleFont: font(title),
          titleBox: rect(title),
          titleClipped: title ? title.scrollWidth > title.clientWidth : null,
          button: button && {
            text: button.textContent.trim(),
            variant: [...button.classList].find((c) =>
              c.startsWith("ui-button-"),
            ),
            ...rect(button),
            font: font(button),
          },
        },
        tabs: tabs && { ...rect(tabs), top: getComputedStyle(tabs).top },
        overflow: {
          page: document.documentElement.scrollWidth > innerWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
          drawer: body ? body.scrollWidth > body.clientWidth : null,
          drawerScrollWidth: body?.scrollWidth ?? null,
          drawerClientWidth: body?.clientWidth ?? null,
        },
      };
    });
  // An entry brought to the top as an anchor would be (block "start").
  const anchor = () =>
    run(() => {
      const article = document.querySelector("article.card-page");
      const entries = article.querySelectorAll(".timeline-entry[id]");
      const entry = entries[20];
      entry.scrollIntoView({ block: "start" });
      return entry.id;
    });
  const anchorLanding = (entryId) =>
    run((id) => {
      const entry = document.getElementById(id);
      const article = document.querySelector("article.card-page");
      const dock = article.querySelector("section[aria-label='主操作']");
      const tabs = article.querySelector(".card-section-nav");
      const top = Math.round(entry.getBoundingClientRect().top);
      return {
        id,
        scrollMarginTop: getComputedStyle(entry).scrollMarginTop,
        entryTop: top,
        dockBottom: dock
          ? Math.round(dock.getBoundingClientRect().bottom)
          : null,
        tabsBottom: Math.round(tabs.getBoundingClientRect().bottom),
        clearOfBars: top >= Math.round(tabs.getBoundingClientRect().bottom),
      };
    }, entryId);
  const openCard = async (id, mode, theme, topShot) => {
    await open(
      mode === "page" ? `cards/${id}` : `cards?view=list&card=${id}`,
      mode === "page"
        ? "!!document.querySelector('article.card-page .card-main')"
        : "!!document.querySelector('.drawer-body article.card-page .card-main')",
      theme,
    );
    if (topShot) {
      report.shots.push({ name: topShot, ...(await measure()) });
      await shot(topShot);
    }
  };
  // Timeline tab, then 700px down: the “下一步” panel is out of view.
  const scrollAway = async () => {
    await run(() =>
      document
        .querySelector("article.card-page [role=tab][id$='-timeline-tab']")
        ?.click(),
    );
    await until(
      "document.querySelectorAll('article.card-page .timeline-entry').length >= 40",
    );
    await settle();
    await scrollBy(700);
    await settle();
    await delay(100);
  };
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const height = width === 390 ? 844 : 1000;
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
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
        "cards?view=list",
        "!!document.querySelector('.card-table, .card-records')",
        theme,
      );
      await shot(`list-${width}-${theme}.png`);
      for (const id of cards) {
        for (const mode of ["page", "drawer"]) {
          await openCard(
            id,
            mode,
            theme,
            id === "C-48"
              ? `top-${mode}-${id}-${width}-${theme}.png`
              : undefined,
          );
          await scrollAway();
          const name = `scrolled-${mode}-${id}-${width}-${theme}.png`;
          const measured = await measure();
          await shot(name);
          const entry = await anchor();
          await settle();
          await delay(100);
          report.shots.push({
            name,
            ...measured,
            anchor: await anchorLanding(entry),
          });
        }
      }
    }
  // The dock runs the panel's action: where focus lands and whether the dock
  // is gone afterwards (1440×1000, light).
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  report.clicks = [];
  for (const id of cards.filter((id) => id !== "C-701"))
    for (const mode of ["page", "drawer"]) {
      await openCard(id, mode, "light");
      await scrollAway();
      await run(() =>
        document
          .querySelector("section[aria-label='主操作'] [data-ui=button]")
          .click(),
      );
      await delay(500);
      await settle();
      report.clicks.push({
        id,
        mode,
        ...(await run(() => {
          const active = document.activeElement;
          const r = active.getBoundingClientRect();
          return {
            url: location.hash,
            focus: `${active.tagName} ${active.getAttribute("aria-label") ?? active.textContent.trim().slice(0, 20)}`,
            focusInView: r.top >= 0 && r.bottom <= innerHeight,
            form: !!document.querySelector("form[aria-label='标记完成']"),
            dock: !!document.querySelector("section[aria-label='主操作']"),
          };
        })),
      });
    }
} finally {
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  ).catch(() => {});
  await browser?.close();
  await server.close();
}
