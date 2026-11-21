// C-505: story card overview frame (原始需求、子卡进度图、拆解方案/总结空态) in
// the detail page and drawer, light/dark, 1440/390, an ordinary card for
// regression, and the card list page at the same width/theme for comparison.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c505-capture.mjs <new output dir>
// C505_BASELINE_REF=<git ref> renders that ref's detail page (before).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass a new output directory");
const baseline = process.env.C505_BASELINE_REF;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
// Files this card changes; a baseline renders its own copies of them.
const historical = new Map(
  baseline
    ? [
        "views/CardDetailPage.tsx",
        "components/CardDependencies.tsx",
        "components/layout/DependencyGraphLayout.tsx",
        "components/layout/DependencyGraphLayout.module.css",
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
      name: "c505-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c505")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c505",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c505-fixture.tsx"></script></body></html>',
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
  /** The whole document, for sections below the fold; evidence only. */
  const fullShot = async (name, width) => {
    const height = await evaluate(
      "Math.ceil(document.documentElement.scrollHeight)",
    );
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    return save(name, data);
  };
  const open = async (hash, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c505${hash}`,
    });
    await until(ready);
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  const measure = () =>
    run(() => {
      const px = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
      const font = (el) =>
        el ? `${px(el, "fontSize")}/${px(el, "lineHeight")}` : null;
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      };
      const scope =
        document.querySelector(".drawer-content .card-main") ??
        document.querySelector(".card-main");
      const named = (label) =>
        scope?.querySelector(`section[aria-label="${label}"]`);
      const sections = Object.fromEntries(
        [
          "原始需求",
          "子卡进度",
          "拆解方案",
          "讨论",
          "对照总结",
          "目标和验收标准",
          "卡片依赖",
        ].map((label) => {
          const s = named(label);
          return [
            label,
            s
              ? {
                  box: box(s),
                  heading: font(s.querySelector("h2")),
                  empty: s.querySelector(
                    ":scope > .empty, :scope > section > .empty",
                  )
                    ? {
                        text: s.querySelector(".empty").textContent,
                        font: font(s.querySelector(".empty")),
                      }
                    : null,
                  buttons: [...s.querySelectorAll("button")].map((b) => ({
                    name: b.getAttribute("aria-label") ?? b.textContent,
                    ...box(b),
                  })),
                }
              : null,
          ];
        }),
      );
      const progress = named("子卡进度");
      const list = progress?.querySelector("ul[aria-label]");
      const scroller = list?.parentElement?.parentElement;
      const nodes = [...(progress?.querySelectorAll("[data-node]") ?? [])];
      const paths = [...(progress?.querySelectorAll("[data-edge]") ?? [])];
      const rects = new Map(
        nodes.map((n) => [
          n.dataset.node,
          {
            left: n.offsetLeft,
            right: n.offsetLeft + n.offsetWidth,
            top: n.offsetTop,
            bottom: n.offsetTop + n.offsetHeight,
          },
        ]),
      );
      const overlaps = paths.flatMap((path) => {
        const [from, to] = path.dataset.edge.split(">");
        const length = path.getTotalLength();
        const hits = {};
        for (let at = 0; at <= length; at++) {
          const p = path.getPointAtLength(at);
          for (const [id, r] of rects)
            if (
              id !== from &&
              id !== to &&
              p.x > r.left &&
              p.x < r.right &&
              p.y > r.top &&
              p.y < r.bottom
            )
              hits[id] = (hits[id] ?? 0) + 1;
        }
        return Object.entries(hits).map(([node, n]) => ({
          edge: path.dataset.edge,
          node,
          px: n,
        }));
      });
      const parentPath = paths.find((p) => p.dataset.edgeKind === "parent");
      const depPath = paths.find((p) => p.dataset.edgeKind === "dependency");
      const nodeButton = progress?.querySelector("[data-node] button");
      const goal = named("原始需求")?.querySelector(".markdown p");
      const overview = scope?.querySelector(
        '[data-card-panel][id$="-overview"]',
      );
      return {
        innerWidth,
        pageScrollWidth: document.documentElement.scrollWidth,
        overviewGap: px(overview, "rowGap"),
        goalText: font(goal),
        sections,
        graph: list
          ? {
              scroller: {
                clientWidth: scroller.clientWidth,
                scrollWidth: scroller.scrollWidth,
                clientHeight: scroller.clientHeight,
                scrollHeight: scroller.scrollHeight,
                maxBlockSize: px(scroller, "maxBlockSize"),
                overflow: px(scroller, "overflow"),
              },
              nodes: nodes.length,
              edges: {
                parent: paths.filter((p) => p.dataset.edgeKind === "parent")
                  .length,
                dependency: paths.filter(
                  (p) => p.dataset.edgeKind === "dependency",
                ).length,
              },
              parentStroke: parentPath
                ? {
                    dasharray: px(parentPath, "strokeDasharray"),
                    color: px(parentPath, "stroke"),
                    marker: parentPath.getAttribute("marker-end"),
                  }
                : null,
              dependencyStroke: depPath
                ? {
                    dasharray: px(depPath, "strokeDasharray"),
                    color: px(depPath, "stroke"),
                    marker: !!depPath.getAttribute("marker-end"),
                  }
                : null,
              node: nodeButton
                ? { ...box(nodeButton), font: font(nodeButton) }
                : null,
              current: box(progress.querySelector('[aria-current="page"]')),
              waypoints: progress.querySelectorAll("[data-waypoint]").length,
              overlaps,
              facts: progress.querySelector("h2 + p")?.textContent ?? null,
              factsFont: font(progress.querySelector("h2 + p span")),
            }
          : null,
      };
    });
  const scenarios = [
    ["story", "#/p/p-1/cards/C-600", false],
    ["story-empty", "#/p/p-1/cards/C-610", false],
    ["story-long", "#/p/p-1/cards/C-620", false],
    ["story-summary", "#/p/p-1/cards/C-640", false],
    ["ordinary", "#/p/p-1/cards/C-700", false],
    ["drawer-story", "#/p/p-1/cards?view=list&card=C-600", true],
  ];
  const ready = (drawer) =>
    `!!document.querySelector('${drawer ? ".drawer-content " : ""}.card-main [data-card-panel]') && !document.querySelector('.card-main .ui-skeleton')`;
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
      const reference = await shot(`cards-${width}-${theme}.png`);
      const results = {};
      for (const [name, hash, drawer] of scenarios) {
        await open(hash, ready(drawer), theme);
        const data = await shot(`${name}-${width}-${theme}.png`);
        results[name] = await measure();
        if (!drawer)
          await fullShot(`${name}-full-${width}-${theme}.png`, width);
        if (["story", "ordinary"].includes(name))
          pairs.push({ name, width, theme, reference, data });
        if (!baseline && name === "story") {
          // Scroll the child graph into view and open one child's peek.
          await run(() =>
            document
              .querySelector('section[aria-label="子卡进度"]')
              ?.scrollIntoView({ block: "start" }),
          );
          // Clear the sticky section tabs above the heading.
          await run(() => window.scrollBy(0, -64));
          await settle();
          const view = await shot(`story-graph-${width}-${theme}.png`);
          pairs.push({
            name: "story-graph",
            width,
            theme,
            reference,
            data: view,
          });
          await run(() =>
            document
              .querySelector('[data-node="C-603"] button')
              ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
          );
          await until(
            "!!document.querySelector('[role=dialog][aria-label=\"卡片 C-603\"]')",
          );
          await settle();
          await shot(`story-peek-${width}-${theme}.png`);
        }
        if (!baseline && name === "story-long") {
          await run(() => {
            const s = document.querySelector(
              'section[aria-label="子卡进度"] ul[aria-label]',
            )?.parentElement?.parentElement;
            s?.scrollIntoView({ block: "start" });
            if (s) s.scrollLeft = s.scrollWidth;
          });
          await settle();
          await shot(`story-long-scrolled-${width}-${theme}.png`);
        }
      }
      cases.push({ width, theme, results });
    }
  // Side-by-side: card list (reference) | changed view, same width/theme.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 2 * 1440 + 16,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const { name, width, theme, reference, data } of pairs) {
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
        const [left, right] = await Promise.all([load(a), load(b)]);
        const canvas = document.createElement("canvas");
        canvas.width = width * 2 + 16;
        canvas.height = Math.max(left.height, right.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#888";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(left, 0, 0);
        ctx.drawImage(right, width + 16, 0);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      reference,
      data,
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
      "test-support/c505-fixture.tsx: 4 synthetic story cards (5 children with sibling dependencies, empty, 12-child long graph, finished with summary) and 1 ordinary card with a 4-node dependency graph; 2 synthetic attachments; not production scale",
    hashes,
    cases,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (!baseline)
    for (const { width, theme, results } of cases)
      for (const [name, r] of Object.entries(results)) {
        const label = `${width}/${theme}/${name}`;
        assert(r.pageScrollWidth <= r.innerWidth, `${label}: page overflows`);
        if (r.graph)
          assert.deepEqual(r.graph.overlaps, [], `${label}: edge under a node`);
      }
} finally {
  await browser?.close();
  await server.close();
}
