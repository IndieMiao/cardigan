// C-487: card dependency graph in the detail page and drawer, light/dark,
// 1440/390, plus the card list page at the same width/theme for comparison.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c487-capture.mjs <new output dir>
// C487_BASELINE_REF=<git ref> renders that ref's dependency section (before).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass a new output directory");
const baseline = process.env.C487_BASELINE_REF;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const shownAt = (ref, path) => {
  try {
    return git("show", `${ref}:apps/web/src/${path}`);
  } catch {
    return undefined;
  }
};
// Files the graph spans; the ones a baseline lacks stay at the working copy.
const historical = new Map(
  baseline
    ? [
        "components/CardDependencies.tsx",
        "components/ui/theme.css",
        "components/layout/DependencyGraphLayout.tsx",
        "components/layout/DependencyGraphLayout.module.css",
        "dependency-graph.ts",
      ].flatMap((path) => {
        const source = shownAt(baseline, path);
        return source === undefined
          ? []
          : [[resolve(root, "src", path), source]];
      })
    : [],
);
// theme.css inlines styles.css from disk, so point it at the baseline copy.
const legacy = resolve(root, "node_modules/.c487-baseline/styles.css");
if (baseline) {
  await mkdir(dirname(legacy), { recursive: true });
  await writeFile(legacy, git("show", `${baseline}:apps/web/src/styles.css`));
  const theme = resolve(root, "src/components/ui/theme.css");
  historical.set(
    theme,
    historical
      .get(theme)
      .replace(
        '@import "../../styles.css"',
        '@import "../../../node_modules/.c487-baseline/styles.css"',
      ),
  );
}
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c487-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c487")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c487",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c487-fixture.tsx"></script></body></html>',
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
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    return data;
  };
  const open = async (hash, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c487${hash}`,
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
      const section = document.querySelector(".card-dependencies");
      const scroller =
        section?.querySelector("ul")?.parentElement?.parentElement;
      const nodes = [...(section?.querySelectorAll("[data-node]") ?? [])];
      const current = section?.querySelector('[aria-current="page"]');
      const link = section?.querySelector("[data-node] a");
      const title = link?.lastElementChild;
      const facts = section?.querySelector("h2 + p");
      const drawer = document.querySelector(".drawer-content");
      return {
        drawer: box(drawer),
        section: box(section),
        heading: `${px(section?.querySelector("h2"), "fontSize")}/${px(section?.querySelector("h2"), "lineHeight")}`,
        facts: facts
          ? {
              text: facts.textContent,
              font: `${px(facts, "fontSize")}/${px(facts, "lineHeight")}`,
              box: box(facts),
            }
          : null,
        scroller: scroller
          ? {
              clientWidth: scroller.clientWidth,
              scrollWidth: scroller.scrollWidth,
              overflowX: px(scroller, "overflowX"),
            }
          : null,
        nodeCount: nodes.length,
        edgeCount: section?.querySelectorAll("[data-edge]").length ?? 0,
        node: link
          ? {
              box: box(link),
              font: `${px(link, "fontSize")}/${px(link, "lineHeight")}`,
              padding: px(link, "padding"),
              radius: px(link, "borderRadius"),
              border: `${px(link, "borderTopWidth")} ${px(link, "borderTopColor")}`,
              background: px(link, "backgroundColor"),
              titleEllipsis: px(title, "textOverflow"),
            }
          : null,
        current: current
          ? {
              box: box(current),
              border: px(current, "borderTopColor"),
              background: px(current, "backgroundColor"),
              color: px(current, "color"),
            }
          : null,
        columnGap:
          nodes.length > 1
            ? (() => {
                const xs = [
                  ...new Set(
                    nodes.map((n) => Math.round(n.getBoundingClientRect().x)),
                  ),
                ].sort((a, b) => a - b);
                return xs.length > 1
                  ? xs[1] -
                      xs[0] -
                      Math.round(nodes[0].getBoundingClientRect().width)
                  : null;
              })()
            : null,
        pageScrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        graph: (() => {
          const list = section?.querySelector("ul");
          if (!list || !scroller) return null;
          const frame = scroller.parentElement;
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
          // Path length (px, sampled every 1px) inside nodes it does not join.
          const overlaps = [
            ...(section?.querySelectorAll("[data-edge]") ?? []),
          ].flatMap((path) => {
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
            return Object.entries(hits).map(([node, px]) => ({
              edge: path.dataset.edge,
              node,
              px,
            }));
          });
          const ends = [
            ...(section?.querySelectorAll("[data-edge]") ?? []),
          ].map((path) => {
            const end = path.getPointAtLength(path.getTotalLength());
            return `${path.dataset.edge.split(">")[1]}@${Math.round(end.y)}`;
          });
          const view = {
            left: scroller.scrollLeft,
            right: scroller.scrollLeft + scroller.clientWidth,
          };
          const currentLi = current?.closest("[data-node]");
          const visible = (id) => {
            const r = rects.get(id);
            return !!r && r.left >= view.left && r.right <= view.right;
          };
          return {
            scrollLeft: scroller.scrollLeft,
            clipStart: frame?.className.includes("clipStart") ?? false,
            clipEnd: frame?.className.includes("clipEnd") ?? false,
            fade: {
              before: getComputedStyle(frame, "::before").visibility,
              after: getComputedStyle(frame, "::after").visibility,
            },
            hiddenNodes: [...rects]
              .filter(([, r]) => r.right <= view.left || r.left >= view.right)
              .map(([id]) => id),
            // The node cut by each side of the view: id and hidden px.
            cut: {
              start: [...rects]
                .filter(([, r]) => r.left < view.left && r.right > view.left)
                .map(([id, r]) => `${id}:${view.left - r.left}`),
              end: [...rects]
                .filter(([, r]) => r.left < view.right && r.right > view.right)
                .map(([id, r]) => `${id}:${r.right - view.right}`),
            },
            currentVisible: visible(currentLi?.dataset.node),
            directBefore: (currentLi?.dataset.before ?? "")
              .split(" ")
              .filter(Boolean)
              .map((id) => ({ id, visible: visible(id) })),
            nodeHeights: [...new Set(nodes.map((n) => n.offsetHeight))],
            rowGap: px(list, "rowGap"),
            waypoints: section?.querySelectorAll("[data-waypoint]").length ?? 0,
            overlaps,
            sharedArrowEnds: ends.length - new Set(ends).size,
            relations: Object.fromEntries(
              nodes.map((n) => {
                const target = n.querySelector("[aria-describedby]");
                return [
                  n.dataset.node,
                  target
                    ? document.getElementById(
                        target.getAttribute("aria-describedby"),
                      )?.textContent
                    : null,
                ];
              }),
            ),
          };
        })(),
      };
    });
  const scenarios = [
    ["page-multi", "#/p/p-1/cards/C-454", false],
    ["drawer-multi", "#/p/p-1/cards?view=list&card=C-454", true],
    ["drawer-single", "#/p/p-1/cards?view=list&card=C-460", true],
    ["drawer-long", "#/p/p-1/cards?view=list&card=C-470", true],
    ["drawer-early", "#/p/p-1/cards?view=list&card=C-480", true],
    ["page-cross", "#/p/p-1/cards/C-490", false],
    ["drawer-cross", "#/p/p-1/cards?view=list&card=C-490", true],
    ["drawer-shortcut", "#/p/p-1/cards?view=list&card=C-498", true],
  ];
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
        await open(
          hash,
          drawer
            ? "!!document.querySelector('.drawer-content .card-dependencies')"
            : "!!document.querySelector('.card-dependencies')",
          theme,
        );
        const data = await shot(`${name}-${width}-${theme}.png`);
        results[name] = await measure();
        if (["drawer-multi", "page-multi", "drawer-cross"].includes(name))
          pairs.push({ name, width, theme, reference, data });
        // Scroll the long chain to its end to show the far nodes.
        if (name === "drawer-long" && !baseline) {
          await run(() => {
            const s = document.querySelector(".card-dependencies ul")
              ?.parentElement?.parentElement;
            if (s) s.scrollLeft = s.scrollWidth;
          });
          await settle();
          await shot(`${name}-scrolled-${width}-${theme}.png`);
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
    await writeFile(
      resolve(output, `side-by-side-${name}-${width}-${theme}.png`),
      Buffer.from(png, "base64"),
    );
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
      "test-support/c487-fixture.tsx: 6 synthetic cards; graphs of 9 (fork/merge/待核/重复), 2, 15, 9 (long edges), 3 (shortcut) and 4 nodes; not production scale",
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
        assert(r.current, `${label}: current node`);
        assert.deepEqual(r.graph.overlaps, [], `${label}: edge under a node`);
        assert.equal(r.graph.sharedArrowEnds, 0, `${label}: shared arrow`);
        assert(r.graph.currentVisible, `${label}: current card cut`);
        assert(
          r.graph.directBefore.every((b) => b.visible) ||
            r.scroller.clientWidth < 600,
          `${label}: direct prerequisite cut`,
        );
        assert.equal(r.graph.clipStart, r.graph.scrollLeft > 1, label);
        if (r.drawer)
          assert(
            r.section.x + r.section.width <= r.drawer.x + r.drawer.width,
            `${label}: section wider than drawer`,
          );
      }
} finally {
  await browser?.close();
  await server.close();
}
