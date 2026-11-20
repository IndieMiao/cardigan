// C-506: dependency graph node popover and drag-to-pan, detail page and
// drawer, light/dark, 1440/390, plus the card list page at the same
// width/theme for comparison.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c506-capture.mjs <new output dir>
// C506_BASELINE_REF=<git ref> renders that ref's graph (before; no popover).
// C506_BEFORE=<before output dir> counts differing pixels against it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass a new output directory");
const baseline = process.env.C506_BASELINE_REF;
const before = process.env.C506_BEFORE && resolve(process.env.C506_BEFORE);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
// Files this card changes; the baseline renders its own copies.
const historical = new Map(
  baseline
    ? [
        "components/CardDependencies.tsx",
        "components/layout/DependencyGraphLayout.tsx",
        "components/layout/DependencyGraphLayout.module.css",
        "components/ui/id-badge.tsx",
        "views/CardDetailPage.tsx",
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
      name: "c506-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c506")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c506",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c506-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const cases = [];
const shots = {};
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
    shots[name] = data;
    return data;
  };
  const open = async (hash, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c506${hash}`,
    });
    await until(ready);
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  const mouse = (type, x, y, buttons = 0) =>
    send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" && !buttons ? "none" : "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
      pointerType: "mouse",
    });
  const key = async (name, code) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
        // Enter activates a button through its key's text.
        ...(name === "Enter" && type === "keyDown" ? { text: "\r" } : {}),
      });
  };
  // Bring a node into view and return its centre in viewport pixels.
  const nodeCentre = (id) =>
    run((id) => {
      const el = document.querySelector(
        `.card-dependencies [data-node="${id}"] > *`,
      );
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 20) };
    }, id);
  const scroller =
    "document.querySelector('.card-dependencies ul').parentElement.parentElement";
  const scrollLeft = () => evaluate(`${scroller}.scrollLeft`);
  const measureGraph = () =>
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
      const scroll = section?.querySelector("ul")?.parentElement?.parentElement;
      const node = section?.querySelector("[data-node] :is(a, button)");
      return {
        section: box(section),
        nodeTag: node?.tagName ?? null,
        node: node
          ? {
              box: box(node),
              font: `${px(node, "fontSize")}/${px(node, "lineHeight")} ${px(node, "fontFamily").split(",")[0]}`,
              padding: px(node, "padding"),
              radius: px(node, "borderRadius"),
              border: `${px(node, "borderTopWidth")} ${px(node, "borderTopColor")}`,
              background: px(node, "backgroundColor"),
              color: px(node, "color"),
              textAlign: px(node, "textAlign"),
              cursor: px(node, "cursor"),
            }
          : null,
        nativeTitles: section?.querySelectorAll("[data-node] [title]").length,
        scroller: scroll
          ? {
              clientWidth: scroll.clientWidth,
              scrollWidth: scroll.scrollWidth,
              scrollLeft: scroll.scrollLeft,
              cursor: px(scroll, "cursor"),
              userSelect: px(scroll, "userSelect"),
            }
          : null,
        pageScrollWidth: document.documentElement.scrollWidth,
        innerWidth,
      };
    });
  const measurePeek = () =>
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
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
        };
      };
      const peek = document.querySelector('[role="dialog"][data-ui="popover"]');
      if (!peek) return null;
      const heading = peek.querySelector("p");
      const dt = peek.querySelector("dt");
      const dd = peek.querySelector("dd");
      const button = [...peek.querySelectorAll("a")].find(
        (a) => a.textContent === "打开卡片",
      );
      const avatar = peek.querySelector(".employee-avatar, .avatar, img");
      const trigger = document.querySelector('[aria-expanded="true"]');
      return {
        label: peek.getAttribute("aria-label"),
        box: box(peek),
        insideViewport:
          peek.getBoundingClientRect().left >= 0 &&
          peek.getBoundingClientRect().right <= innerWidth &&
          peek.getBoundingClientRect().bottom <= innerHeight,
        padding: px(peek, "padding"),
        radius: px(peek, "borderRadius"),
        background: px(peek, "backgroundColor"),
        color: px(peek, "color"),
        heading: {
          text: heading?.textContent,
          font: `${px(heading, "fontSize")}/${px(heading, "lineHeight")} ${px(heading, "fontWeight")}`,
          lines: heading
            ? Math.round(
                heading.getBoundingClientRect().height /
                  Number.parseFloat(px(heading, "lineHeight")),
              )
            : 0,
        },
        label_: `${px(dt, "fontSize")}/${px(dt, "lineHeight")} ${px(dt, "color")}`,
        value: `${px(dd, "fontSize")}/${px(dd, "lineHeight")}`,
        facts: [...peek.querySelectorAll("dt")].map(
          (d) => `${d.textContent}：${d.nextElementSibling?.textContent}`,
        ),
        openButton: button ? { ...box(button), href: button.hash } : null,
        avatar: box(avatar),
        gapToTrigger: trigger
          ? Math.round(
              peek.getBoundingClientRect().top -
                trigger.getBoundingClientRect().bottom,
            )
          : null,
        url: location.hash,
      };
    });
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
      const tag = `${width}-${theme}`;
      const results = {};
      await open(
        "#/p/p-1/cards?view=list",
        "!!document.querySelector('.card-table, .card-records, table')",
        theme,
      );
      const reference = await shot(`cards-${tag}.png`);
      for (const [name, hash, drawer] of [
        ["page", "#/p/p-1/cards/C-454", false],
        ["drawer", "#/p/p-1/cards?view=list&card=C-454", true],
        ["drawer-long", "#/p/p-1/cards?view=list&card=C-470", true],
      ]) {
        const ready = drawer
          ? "!!document.querySelector('.drawer-content .card-dependencies')"
          : "!!document.querySelector('.card-dependencies')";
        await open(hash, ready, theme);
        await shot(`${name}-${tag}.png`);
        results[name] = await measureGraph();
        if (baseline) continue;
        // Click (a press that does not move) opens the node's popover in place.
        const target = name === "drawer-long" ? "C-466" : "C-453";
        const before = await run(() => location.hash);
        const at = await nodeCentre(target);
        await settle();
        await mouse("mouseMoved", at.x, at.y);
        await mouse("mousePressed", at.x, at.y, 1);
        await mouse("mouseMoved", at.x + 2, at.y + 1, 1);
        await mouse("mouseReleased", at.x + 2, at.y + 1);
        await until(
          "!!document.querySelector('[data-ui=popover]') && !document.querySelector('[data-ui=popover]').textContent.includes('读取中')",
        );
        await settle();
        const peekShot = await shot(`${name}-peek-${tag}.png`);
        results[`${name}-peek`] = {
          ...(await measurePeek()),
          stayed: (await run(() => location.hash)) === before,
        };
        if (name !== "drawer-long")
          pairs.push({
            name: `${name}-peek`,
            width,
            theme,
            reference,
            data: peekShot,
          });
        // Escape closes and focus goes back to the node.
        await key("Escape", 27);
        await settle();
        results[`${name}-escape`] = await run(() => ({
          open: !!document.querySelector("[data-ui=popover]"),
          focus: document.activeElement?.closest("[data-node]")?.dataset.node,
        }));
        if (name !== "drawer-long") continue;
        // Drag from a node: pans, shows grabbing, opens nothing.
        const start = await scrollLeft();
        await mouse("mouseMoved", at.x, at.y);
        await mouse("mousePressed", at.x, at.y, 1);
        await mouse("mouseMoved", at.x - 60, at.y, 1);
        await mouse("mouseMoved", at.x - 120, at.y + 3, 1);
        const during = await evaluate(
          `({ cursor: getComputedStyle(${scroller}).cursor, selection: String(getSelection()) })`,
        );
        await mouse("mouseReleased", at.x - 120, at.y + 3);
        await settle();
        await shot(`${name}-dragged-${tag}.png`);
        results[`${name}-drag`] = {
          ...during,
          scrolledBy: (await scrollLeft()) - start,
          popover: await run(
            () => !!document.querySelector("[data-ui=popover]"),
          ),
          idleCursor: await evaluate(`getComputedStyle(${scroller}).cursor`),
        };
        // Arrow keys pan while a node has focus; Enter opens it.
        const keyStart = await scrollLeft();
        await run(() =>
          document
            .querySelector('.card-dependencies [data-node="C-466"] button')
            .focus({ preventScroll: true }),
        );
        await key("ArrowRight", 39);
        const afterRight = await scrollLeft();
        await key("Enter", 13);
        await until("!!document.querySelector('[data-ui=popover]')");
        results[`${name}-keys`] = {
          arrowRight: afterRight - keyStart,
          enterOpens: true,
        };
        await key("Escape", 27);
        await settle();
      }
      // The node hint keeps 标题 · 状态 after a hover.
      if (!baseline) {
        await open(
          "#/p/p-1/cards/C-454",
          "!!document.querySelector('.card-dependencies')",
          theme,
        );
        const at = await nodeCentre("C-456");
        await settle();
        await mouse("mouseMoved", at.x, at.y);
        await delay(1300);
        await settle();
        await shot(`page-hover-${tag}.png`);
        results.hover = await run(() => ({
          tooltips: [...document.querySelectorAll(".tooltip-content")].map(
            (t) => t.textContent,
          ),
          nativeTitles: document.querySelectorAll(
            ".card-dependencies [data-node] [title]",
          ).length,
        }));
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
  const compose = (a, b, width) =>
    run(
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
      a,
      b,
      width,
    );
  await send("Page.navigate", { url: "about:blank" });
  await until("location.href === 'about:blank'");
  for (const { name, width, theme, reference, data } of pairs)
    await writeFile(
      resolve(output, `side-by-side-${name}-${width}-${theme}.png`),
      Buffer.from(await compose(reference, data, width), "base64"),
    );
  // Pixel difference against the before capture, same name.
  const diffs = {};
  if (before)
    for (const name of Object.keys(shots).filter(
      (n) => !/-(peek|dragged|hover)-/.test(n),
    )) {
      const old = (await readFile(resolve(before, name))).toString("base64");
      diffs[name] = await run(
        async (a, b) => {
          const load = (src) =>
            new Promise((r) => {
              const img = new Image();
              img.onload = () => r(img);
              img.src = `data:image/png;base64,${src}`;
            });
          const [x, y] = await Promise.all([load(a), load(b)]);
          if (x.width !== y.width || x.height !== y.height) return "size";
          const pixels = (img) => {
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            return ctx.getImageData(0, 0, img.width, img.height).data;
          };
          const [p, q] = [pixels(x), pixels(y)];
          let n = 0;
          for (let i = 0; i < p.length; i += 4)
            if (
              p[i] !== q[i] ||
              p[i + 1] !== q[i + 1] ||
              p[i + 2] !== q[i + 2] ||
              p[i + 3] !== q[i + 3]
            )
              n++;
          return n;
        },
        old,
        shots[name],
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
      "test-support/c506-fixture.tsx: 2 synthetic cards with graphs of 9 and 15 nodes; popover reads from the same synthetic set (1 synthetic employee, fixed time); not production scale",
    cases,
    pixelDiffAgainstBefore: before ? diffs : null,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (!baseline)
    for (const { width, theme, results } of cases) {
      const label = `${width}/${theme}`;
      for (const name of ["page", "drawer", "drawer-long"]) {
        const graph = results[name];
        assert(graph.pageScrollWidth <= graph.innerWidth, `${label} ${name}`);
        assert.equal(graph.nativeTitles, 0, `${label} ${name}: native title`);
        const peek = results[`${name}-peek`];
        assert(peek?.insideViewport, `${label} ${name}: popover in view`);
        assert(peek.stayed, `${label} ${name}: page stayed`);
        assert.deepEqual(
          results[`${name}-escape`].open,
          false,
          `${label} ${name}: Escape`,
        );
      }
      const drag = results["drawer-long-drag"];
      assert(drag.scrolledBy >= 100, `${label}: drag pans`);
      assert.equal(drag.popover, false, `${label}: drag opens nothing`);
      assert.equal(drag.cursor, "grabbing", `${label}: grabbing`);
      assert.equal(drag.selection, "", `${label}: no selection`);
      assert.equal(results["drawer-long-keys"].arrowRight, 40, label);
    }
} finally {
  await browser?.close();
  await server.close();
}
