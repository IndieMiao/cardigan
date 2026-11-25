// C-699: the card overview (two columns, facts column, no index block) for a
// dev card (C-701), a general card with a dependency graph (C-48) and a story
// card (C-704), page and drawer, 1440×1000 and 390×844, light and dark, plus
// the card list page (the baseline page) at the same viewport and theme and a
// side-by-side image of each overview next to it. Synthetic data from
// c695-fixture.tsx only; same browser flags as the page-skeleton check.
//
// Each shot records: the overview main and facts boxes, the facts label width,
// fonts of section titles, body, facts labels and values, where the story's
// 子卡进度 sits against the first screen, the dependency graph's own scroll
// box, and horizontal overflow of the page and of the drawer body.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c699-capture.mjs <new dir>
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
      name: "c699-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c699")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c699",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c695-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const cards = ["C-701", "C-48", "C-704"];
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
  const viewport = async (width, height, theme) => {
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
  };
  const open = async (hash, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c699#/p/p-1/${hash}`,
    });
    await until(ready);
    await evaluate("document.fonts.ready.then(() => true)");
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    // Let the story's child graph and other follow-up reads land.
    await delay(300);
    await settle();
  };
  // Two screenshots side by side on one canvas, 16px apart, page background.
  const pair = async (left, right, name, width, height, theme) => {
    const data = async (file) =>
      `data:image/png;base64,${(await readFile(resolve(output, file))).toString("base64")}`;
    await viewport(width * 2 + 16, height, theme);
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await run(
      (a, b, bg) => {
        document.body.style.cssText = `margin:0;display:flex;gap:16px;background:${bg}`;
        for (const src of [a, b]) {
          const img = document.createElement("img");
          img.src = src;
          document.body.append(img);
        }
        return Promise.all(
          [...document.images].map((i) => i.decode().then(() => true)),
        );
      },
      await data(left),
      await data(right),
      theme === "dark" ? "#000" : "#888",
    );
    await settle();
    await shot(name);
  };
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
      const panel = article?.querySelector("[data-card-panel][id$=overview]");
      const facts = panel?.querySelector("aside[aria-label='卡片信息']");
      const main = facts?.previousElementSibling ?? null;
      const dt = facts?.querySelector("dt");
      const dd = facts?.querySelector("dd");
      const tabs = article?.querySelector("[role=tablist]");
      const children = panel?.querySelector("section[aria-label='子卡进度']");
      const graph = panel?.querySelector(
        "section[aria-label='卡片依赖'], section[aria-label='子卡进度']",
      );
      const graphScroller = graph
        ? [graph, ...graph.querySelectorAll("*")].find(
            (e) => e.scrollWidth > e.clientWidth + 1,
          )
        : null;
      const titles = panel
        ? [...panel.querySelectorAll("h2")]
            .filter((e) => e.getClientRects().length)
            .map((e) => ({
              text: e.textContent.trim(),
              font: font(e),
              y: Math.round(e.getBoundingClientRect().y),
            }))
        : [];
      const body = document.querySelector(".drawer-body");
      const firstTitle = panel?.querySelector("h2");
      const markdown = panel?.querySelector(".markdown p, .markdown");
      return {
        viewport: { width: innerWidth, height: innerHeight },
        tabs: rect(tabs),
        tabsToFirstTitle:
          tabs && firstTitle
            ? Math.round(
                firstTitle.getBoundingClientRect().top -
                  tabs.getBoundingClientRect().bottom,
              )
            : null,
        main: rect(main),
        facts: facts && {
          ...rect(facts),
          border: getComputedStyle(facts).borderTopWidth,
          borderRadius: getComputedStyle(facts).borderTopLeftRadius,
          padding: getComputedStyle(facts).padding,
          columns: getComputedStyle(facts.querySelector("dl"))
            .gridTemplateColumns,
          labelWidth: dt ? Math.round(dt.getBoundingClientRect().width) : null,
          labelFont: font(dt),
          labelColor: dt ? getComputedStyle(dt).color : null,
          valueFont: font(dd),
          labels: [...facts.querySelectorAll("dt")].map((e) => e.textContent),
        },
        gap:
          main &&
          facts &&
          facts.getBoundingClientRect().x > main.getBoundingClientRect().right
            ? Math.round(
                facts.getBoundingClientRect().x -
                  main.getBoundingClientRect().right,
              )
            : null,
        titles,
        bodyFont: font(markdown),
        indexBlock: !!article?.textContent.includes("卡片索引与关联"),
        emptyText: [
          "没有附件",
          "没有拆解方案",
          "没有总结",
          "没有子卡",
          "没有问题清单",
          "没有关联卡片或 PR",
          "验收标准（0",
        ].filter((t) => article?.textContent.includes(t)),
        storyChildren: children && {
          ...rect(children),
          firstScreen: children.getBoundingClientRect().top < innerHeight,
        },
        graph: graph && {
          ...rect(graph),
          scroller: graphScroller
            ? {
                clientWidth: graphScroller.clientWidth,
                scrollWidth: graphScroller.scrollWidth,
                overflowX: getComputedStyle(graphScroller).overflowX,
              }
            : null,
        },
        overflow: {
          page: document.documentElement.scrollWidth > innerWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
          drawer: body ? body.scrollWidth > body.clientWidth : null,
          drawerScrollWidth: body?.scrollWidth ?? null,
          drawerClientWidth: body?.clientWidth ?? null,
        },
      };
    });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const height = width === 390 ? 844 : 1000;
      await viewport(width, height, theme);
      await open(
        "cards?view=list",
        "!!document.querySelector('.card-table, .card-records')",
        theme,
      );
      const list = `list-${width}-${theme}.png`;
      await shot(list);
      for (const id of cards) {
        for (const mode of ["page", "drawer"]) {
          await viewport(width, height, theme);
          await open(
            mode === "page" ? `cards/${id}` : `cards?view=list&card=${id}`,
            mode === "page"
              ? "!!document.querySelector('article.card-page .card-main')"
              : "!!document.querySelector('.drawer-body article.card-page .card-main')",
            theme,
          );
          const name = `${mode}-${id}-${width}-${theme}.png`;
          report.shots.push({ name, ...(await measure()) });
          await shot(name);
          // Scrolled to the overview: the facts column in view.
          const scrolled = await run((mode) => {
            const facts = document.querySelector(
              "aside[aria-label='卡片信息']",
            );
            if (!facts) return false;
            const box =
              mode === "drawer"
                ? document.querySelector(".drawer-body")
                : document.scrollingElement;
            const top =
              facts.getBoundingClientRect().top -
              (mode === "drawer" ? box.getBoundingClientRect().top : 0);
            if (top + facts.offsetHeight <= box.clientHeight) return false;
            box.scrollTop += top - 80;
            return true;
          }, mode);
          if (scrolled) {
            await settle();
            await shot(`${mode}-${id}-${width}-${theme}-facts.png`);
          }
          await pair(
            list,
            name,
            `cmp-${mode}-${id}-${width}-${theme}.png`,
            width,
            height,
            theme,
          );
        }
      }
    }
} finally {
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  ).catch(() => {});
  await browser?.close();
  await server.close();
}
