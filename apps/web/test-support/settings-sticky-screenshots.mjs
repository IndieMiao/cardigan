import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-480 evidence: the settings title and sub-navigation stay in view while the
// panel scrolls (wide screens), the nav scrolls inside itself on short
// windows, and the narrow layout keeps its top list without covering content.
// Synthetic settings fixture only (no backend, live data or e2e suite).
// Usage: node settings-sticky-screenshots.mjs <output-dir> [--before]
// --before records measurements without asserting the sticky behaviour.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "../../artifacts/settings-sticky");
const before = process.argv.includes("--before");
await mkdir(output, { recursive: true });
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "settings-sticky-fixture",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const page = request.url?.match(/^\/__(settings|cards)/)?.[1];
          if (!page) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              `/__${page}`,
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/${page === "cards" ? "page-skeleton" : "settings"}-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
let browser;
const report = { scenes: {} };
try {
  await server.listen();
  // Same software raster path as the page skeleton visual baseline.
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
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression) => {
    const deadline = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < deadline, `Timed out: ${expression}`);
      await delay(40);
    }
  };
  const frames = () =>
    run(async () => {
      await document.fonts.ready;
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
    });
  const viewport = (width, height) =>
    send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  const open = async (page, hash, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__${page}${hash}`,
    });
    await until(ready);
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await frames();
  };
  // Viewport screenshot of what the user sees at the current scroll offset.
  const shot = async (file) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(output, file), Buffer.from(data, "base64"));
    return data;
  };
  // Positions are viewport coordinates; "visible" means fully inside it.
  const measure = () =>
    run(() => {
      const round = (n) => Math.round(n * 10) / 10;
      const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect(),
          s = getComputedStyle(e);
        return {
          text: e.textContent.trim().slice(0, 24),
          x: round(r.left),
          y: round(r.top),
          w: round(r.width),
          h: round(r.height),
          bottom: round(r.bottom),
          font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
          visible: r.top >= 0 && r.bottom <= innerHeight + 0.5,
        };
      };
      const nav = document.querySelector("nav[aria-label='设置分栏']");
      const items = [...(nav?.querySelectorAll("button") ?? [])];
      const navBox = nav?.getBoundingClientRect();
      const title = document.querySelector(".ui-page-header h1");
      const current = nav?.querySelector("[aria-current='page']");
      const content = document.querySelector(
        "[data-settings-content]:not([hidden])",
      );
      // What the user actually sees at the centre of each nav item and of
      // the title: the element itself, not the panel scrolled underneath.
      const hit = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const x = r.left + r.width / 2,
          y = r.top + r.height / 2;
        if (y < 0 || y > innerHeight) return false;
        const top = document.elementFromPoint(x, y);
        return !!top && e.contains(top);
      };
      const navStyle = nav ? getComputedStyle(nav) : null;
      // Narrow screens: the first panel element must start below the nav.
      const firstContent = content?.querySelector("h2");
      return {
        innerWidth,
        innerHeight,
        scrollY: Math.round(scrollY),
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
        title: { ...box(title), hit: hit(title) },
        nav: nav
          ? {
              x: round(navBox.left),
              y: round(navBox.top),
              w: round(navBox.width),
              h: round(navBox.height),
              bottom: round(navBox.bottom),
              position: navStyle.position,
              top: navStyle.top,
              overflowY: navStyle.overflowY,
              scrollHeight: nav.scrollHeight,
              clientHeight: nav.clientHeight,
              scrollTop: Math.round(nav.scrollTop),
            }
          : null,
        items: items.map((e) => ({ ...box(e), hit: hit(e) })),
        current: current
          ? {
              text: current.textContent.trim(),
              background: getComputedStyle(current).backgroundColor,
              hit: hit(current),
            }
          : null,
        panelTitle: box(firstContent),
        panel: box(content),
      };
    });
  const cases = [];
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const height = 1000;
      await viewport(width, height);
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      const key = `${width}-${theme}`;
      // Card page (style baseline) at the same width and theme.
      await open(
        "cards",
        "#/p/p-1/cards?view=board",
        "!!document.querySelector('.board-card')",
        theme,
      );
      const cards = await shot(`cards-${key}.png`);
      await open(
        "settings",
        "#/p/p-1/settings",
        "!!document.querySelector('[role=switch]')",
        theme,
      );
      await run(() => window.scrollTo(0, 0));
      await frames();
      report.scenes[`top-${key}`] = await measure();
      const top = await shot(`settings-top-${key}.png`);
      // Scroll the document to the very bottom of the preferences panel.
      await run(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await frames();
      const bottom = await measure();
      report.scenes[`bottom-${key}`] = bottom;
      await shot(`settings-bottom-${key}.png`);
      cases.push({ key, width, height, cards, top });
      assert.equal(bottom.scrollWidth, width, `${key}: horizontal overflow`);
      assert(bottom.scrollY > 0, `${key}: preferences panel does not scroll`);
      if (before) continue;
      if (width > 760) {
        // Wide: title and every nav item stay fully visible and on top.
        assert(bottom.title.visible && bottom.title.hit, `${key}: title`);
        for (const item of bottom.items)
          assert(item.visible && item.hit, `${key}: nav ${item.text}`);
        assert.equal(bottom.title.y, report.scenes[`top-${key}`].title.y);
        assert.equal(bottom.nav.y, report.scenes[`top-${key}`].nav.y);
        assert.equal(bottom.current?.text, "偏好");
        // Keyboard focus moving back up lands below the sticky header band.
        const focused = await run(() => {
          const target = document.querySelector(
            "[data-settings-content]:not([hidden]) [role=switch]",
          );
          target.focus();
          const r = target.getBoundingClientRect();
          const top = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2,
          );
          return { y: Math.round(r.top), hit: !!top && target.contains(top) };
        });
        report.scenes[`focus-${key}`] = focused;
        assert(focused.hit && focused.y >= bottom.nav.y, `${key}: focus`);
      } else {
        // Narrow: the nav stays in the flow above the panel; nothing sticks.
        assert.equal(bottom.nav.position, "static", `${key}: nav position`);
        const atTop = report.scenes[`top-${key}`];
        assert(
          atTop.panelTitle.y >= atTop.nav.bottom,
          `${key}: nav covers the panel`,
        );
      }
    }
  // Short wide window: the nav scrolls inside itself, nothing is cut off.
  for (const theme of ["light", "dark"]) {
    const [width, height] = [1440, 240];
    await viewport(width, height);
    await send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: theme },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });
    const key = `${width}x${height}-${theme}`;
    await open(
      "settings",
      "#/p/p-1/settings",
      "!!document.querySelector('[role=switch]')",
      theme,
    );
    await run(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await frames();
    report.scenes[`short-${key}`] = await measure();
    await shot(`settings-short-${key}.png`);
    // Scroll the nav itself to its end with the wheel over it.
    const nav = report.scenes[`short-${key}`].nav;
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: nav.x + nav.w / 2,
      y: Math.min(nav.y + 20, height - 4),
      deltaX: 0,
      deltaY: 400,
    });
    await delay(200);
    await frames();
    const end = await measure();
    report.scenes[`short-end-${key}`] = end;
    await shot(`settings-short-end-${key}.png`);
    if (before) continue;
    assert.equal(end.nav.overflowY, "auto", `${key}: nav overflow`);
    assert(end.nav.scrollHeight > end.nav.clientHeight, `${key}: nav fits`);
    assert(end.nav.bottom <= height, `${key}: nav cut off by the viewport`);
    const last = end.items.at(-1);
    assert(last.visible && last.hit, `${key}: last nav item not reachable`);
  }
  // Side-by-side: card page (left) and settings (right), same width/theme.
  await viewport(1440, 1000);
  for (const { key, width, height, cards, top } of cases) {
    const gap = 16;
    await viewport(width * 2 + gap, height);
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await run(
      async (cards, top, gap) => {
        document.body.style.cssText = `margin:0;display:flex;gap:${gap}px;background:#888`;
        for (const data of [cards, top]) {
          const img = new Image();
          img.src = `data:image/png;base64,${data}`;
          img.style.display = "block";
          document.body.append(img);
          await img.decode();
        }
      },
      cards,
      top,
      gap,
    );
    await frames();
    await shot(`side-by-side-${key}.png`);
  }
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
