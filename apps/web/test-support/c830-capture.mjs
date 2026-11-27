// C-830 evidence: the image preview (zoom controls, wheel / double click /
// pinch zoom, drag to pan, blank click to close) opened from the attachments
// tab, a timeline Markdown chip and an open decision, plus the card list (the
// reference page) at the same width and theme. Synthetic fixture only
// (c830-fixture.tsx); no backend, database or production records.
// Usage: CHROMIUM_PATH=... node test-support/c830-capture.mjs <output-dir> [before-dir]
// Run on the baseline (no zoom controls) it captures the list and the fitted
// preview only. With a before-dir it also writes before|after side-by-side
// images and per-image pixel differences.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "c830-evidence");
const before = process.argv[3] ? resolve(process.argv[3]) : undefined;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sharp = createRequire(resolve(root, "../server/package.json"))("sharp");

// A tall 2×3 comparison like SEN-C-141's: dark cells, small labels.
const cell = (col, row) => {
  const x = col * 720,
    y = row * 1120,
    label = ["GLES3 old c7af66f5", "GLES3 new ec5244d9", "Mobile new ec5244d9"][
      row
    ],
    clock = ["shake @10s", "shake @3000.37s"][col];
  const marks = Array.from({ length: 6 }, (_, i) => {
    const cx = x + 90 + ((i * 113 + row * 47 + col * 29) % 540),
      cy = y + 80 + ((i * 167 + row * 61) % 900);
    return `<rect x="${cx}" y="${cy}" width="18" height="12" rx="2" fill="#d0d0d0"/><text x="${cx + 24}" y="${cy + 10}" font-family="sans-serif" font-size="9" fill="#9a9a9a">p${row}${col}${i} Δ0.${(i * 7 + row) % 10}px</text>`;
  }).join("");
  return `<rect x="${x}" y="${y}" width="720" height="1120" fill="#000"/>${marks}<rect x="${x}" y="${y + 1096}" width="720" height="24" fill="#2a2a2a"/><text x="${x + 360}" y="${y + 1112}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#e0e0e0">${label}: ${clock}</text><rect x="${x + 719}" y="${y}" width="2" height="1120" fill="#333"/>`;
};
const svg = {
  "attachment-1": `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="3360">${[0, 1, 2].flatMap((r) => [cell(0, r), cell(1, r)]).join("")}</svg>`,
  "attachment-2": `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="500"><rect width="4000" height="500" fill="#20262e"/>${Array.from({ length: 12 }, (_, i) => `<rect x="${i * 333 + 8}" y="40" width="317" height="420" rx="6" fill="${i % 2 ? "#3b6fd8" : "#c0843d"}"/><text x="${i * 333 + 24}" y="480" font-family="sans-serif" font-size="12" fill="#ddd">frame ${i + 1}</text>`).join("")}</svg>`,
  "attachment-3": `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900"><rect width="1440" height="900" fill="#f4f6f8"/><rect width="1440" height="54" fill="#4f86f7"/><circle cx="1000" cy="500" r="160" fill="#e8a85a"/></svg>`,
};
const images = {};
for (const [id, source] of Object.entries(svg)) {
  const full = await sharp(Buffer.from(source)).png().toBuffer();
  images[id] = {
    full,
    thumbnail: await sharp(full)
      .resize({ width: 320, height: 320, fit: "inside" })
      .png()
      .toBuffer(),
  };
}

const server = await createServer({
  root,
  logLevel: "error",
  // The baseline run may sit in a copy whose node_modules link elsewhere.
  server: { host: "127.0.0.1", port: 0, fs: { strict: false } },
  plugins: [
    {
      name: "c830-fixture",
      enforce: "pre",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          const file =
            /^\/api\/projects\/p-1\/attachments\/(attachment-\d)(\/thumbnail)?(?:\?.*)?$/.exec(
              req.url ?? "",
            );
          if (file) {
            const bytes = images[file[1]]?.[file[2] ? "thumbnail" : "full"];
            res.setHeader("Cache-Control", "no-store");
            if (!bytes) {
              res.statusCode = 404;
              res.end();
              return;
            }
            res.setHeader("Content-Type", "image/png");
            res.end(bytes);
            return;
          }
          if (!req.url?.startsWith("/__c830")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__c830",
              '<!doctype html><html lang="zh-CN"><head><title>图片预览</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c830-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const results = [];
const checks = [];
const shots = {};
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
    ],
  });
  const { send, evaluate } = browser;
  const version = await send("Browser.getVersion");
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression, ms = 20000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const settle = () =>
    run(async () => {
      await document.fonts.ready;
      await Promise.race([
        Promise.all(
          [...document.images].map((img) =>
            img.complete
              ? null
              : new Promise((r) => {
                  img.addEventListener("load", r, { once: true });
                  img.addEventListener("error", r, { once: true });
                }),
          ),
        ),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
  let viewport = { width: 1440, height: 1000 };
  const open = async (width, theme, hash) => {
    viewport = { width, height: 1000 };
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c830${hash}`,
    });
    await until(
      "document.readyState === 'complete' && !!document.querySelector('#root > *')",
    );
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
  };
  const tab = (label) =>
    run((label) => {
      const tab = [...document.querySelectorAll("[role=tab]")].find((t) =>
        t.textContent.startsWith(label),
      );
      tab.click();
      return !!tab;
    }, label);
  const mouse = (type, x, y, extra = {}) =>
    send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" || type === "mouseWheel" ? "none" : "left",
      buttons: extra.buttons ?? (type === "mouseReleased" ? 0 : 0),
      clickCount: extra.clickCount ?? (type === "mouseMoved" ? 0 : 1),
      ...extra,
    });
  const click = async (x, y, clickCount = 1) => {
    await mouse("mouseMoved", x, y);
    await mouse("mousePressed", x, y, { clickCount, buttons: 1 });
    await mouse("mouseReleased", x, y, { clickCount });
  };
  const drag = async (from, to, steps = 8) => {
    await mouse("mouseMoved", from.x, from.y);
    await mouse("mousePressed", from.x, from.y, { buttons: 1 });
    for (let i = 1; i <= steps; i++)
      await mouse(
        "mouseMoved",
        from.x + ((to.x - from.x) * i) / steps,
        from.y + ((to.y - from.y) * i) / steps,
        { buttons: 1 },
      );
    await mouse("mouseReleased", to.x, to.y);
  };
  const wheel = (x, y, deltaY) =>
    mouse("mouseWheel", x, y, { deltaX: 0, deltaY });
  /** The preview's state: zoom text, image and stage boxes, open or not. */
  const state = () =>
    run(() => {
      const dialog = document.querySelector("[role=dialog]");
      const img = dialog?.querySelector("img");
      const stage = img?.parentElement;
      const bar = dialog?.querySelector("[role=toolbar]");
      const rect = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
          x: Math.round(r.x * 100) / 100,
          y: Math.round(r.y * 100) / 100,
          w: Math.round(r.width * 100) / 100,
          h: Math.round(r.height * 100) / 100,
        };
      };
      return {
        open: !!dialog,
        title: dialog?.querySelector("h2")?.textContent ?? null,
        zoom: bar?.querySelector("span")?.textContent ?? null,
        image: rect(img),
        natural: img ? [img.naturalWidth, img.naturalHeight] : null,
        stage: rect(stage),
        cursor: stage ? getComputedStyle(stage).cursor : null,
      };
    });
  const waitOpen = async () => {
    await until(
      "(() => { const d = document.querySelector('[role=dialog]'); const i = d?.querySelector('img'); return !!(i && i.complete && i.naturalWidth); })()",
    );
    await until(
      "(() => { const b = document.querySelector('[role=dialog] [role=toolbar]'); return !b || b.querySelector('span').textContent !== '—'; })()",
    );
    await settle();
  };
  const waitClosed = () => until("!document.querySelector('[role=dialog]')");
  const zoomable = () =>
    evaluate("!!document.querySelector('[role=dialog] [role=toolbar]')");
  const button = (name) =>
    run((name) => {
      const b = document.querySelector(
        `[role=dialog] button[aria-label="${name}"]`,
      );
      b.click();
      return !!b;
    }, name);
  /** The image pixel under a viewport point. */
  const imagePoint = (s, p) => [
    ((p.x - s.image.x) / s.image.w) * s.natural[0],
    ((p.y - s.image.y) / s.image.h) * s.natural[1],
  ];
  const measure = () =>
    run(() => {
      const px = (v) => Math.round(Number.parseFloat(v) * 100) / 100;
      const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height) };
      };
      const text = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e);
        return {
          font: s.fontSize,
          line: s.lineHeight,
          weight: s.fontWeight,
          box: box(e),
        };
      };
      const dialog = document.querySelector("[role=dialog]");
      const bar = dialog?.querySelector("[role=toolbar]");
      return {
        innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        preview: dialog && {
          close: box(dialog.querySelector("[aria-label='关闭预览']")),
          previous: box(dialog.querySelector("[aria-label='上一张']")),
          next: box(dialog.querySelector("[aria-label='下一张']")),
          image: box(dialog.querySelector("img")),
          caption: text(dialog.querySelector(".lightbox-caption")),
          toolbar: bar && {
            box: box(bar),
            gap: getComputedStyle(bar).gap,
            padding: getComputedStyle(bar).padding,
            radius: getComputedStyle(bar).borderRadius,
            border: `${getComputedStyle(bar).borderTopWidth} ${getComputedStyle(bar).borderTopColor}`,
            background: getComputedStyle(bar).backgroundColor,
            value: text(bar.querySelector("span")),
            buttons: [...bar.querySelectorAll("button")].map((b) => ({
              label: b.getAttribute("aria-label"),
              box: box(b),
              icon: box(b.querySelector("svg")),
              font: getComputedStyle(b).fontSize,
            })),
          },
        },
      };
    });
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    shots[name] = data;
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
  };
  const record = async (name) => {
    await settle();
    await delay(150);
    const metrics = await measure();
    assert(!metrics.overflow, `${name}: page overflows`);
    await shot(name);
    results.push({ name, ...metrics, state: await state() });
    console.log(`Captured ${name}`);
  };
  const check = (name, ok, detail) => {
    checks.push({ name, ok, ...detail });
    assert(ok, `${name}: ${JSON.stringify(detail)}`);
  };
  const openFromTab = async () => {
    await tab("附件");
    await until(
      "!!document.querySelector('[data-card-panel][id$=attachments]:not([hidden]) button[aria-label^=预览]')",
    );
    await run(() =>
      document
        .querySelector(
          "[data-card-panel][id$=attachments]:not([hidden]) button[aria-label^=预览]",
        )
        .click(),
    );
    await waitOpen();
  };
  // Mouse away from the stage so hover tooltips never enter a screenshot.
  const park = () => mouse("mouseMoved", 1, viewport.height - 1);

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const suffix = `${width}-${theme}.png`;
      await open(width, theme, "#/p/p-1/cards?view=list");
      await until("!!document.querySelector('.card-table')");
      await record(`list-${suffix}`);
      await open(width, theme, "#/p/p-1/cards/C-1");
      await until("!!document.querySelector('[role=tab]')");
      await openFromTab();
      await park();
      await record(`preview-fit-${suffix}`);
      if (!(await zoomable())) continue;
      await button("原始大小 100%");
      await park();
      await record(`preview-100-${suffix}`);
      // Drag to the bottom, then wheel in on the bottom-right cell's label.
      let s = await state();
      for (let i = 0; i < 6; i++)
        await drag(
          { x: s.stage.x + s.stage.w / 2, y: s.stage.y + s.stage.h - 20 },
          { x: s.stage.x + s.stage.w / 4, y: s.stage.y + 20 },
        );
      s = await state();
      const target = {
        x: s.image.x + s.image.w * 0.75,
        y: s.image.y + s.image.h - 12,
      };
      for (let i = 0; i < 4; i++) await wheel(target.x, target.y, -120);
      await settle();
      await park();
      await record(`preview-detail-${suffix}`);
      await button("适应窗口");
      await settle();
      await park();
      await record(`preview-fitted-again-${suffix}`);
      await run(() => document.activeElement?.blur());
    }

  // Behaviour, on real input events, at both widths in the light theme.
  for (const width of [1440, 390]) {
    await open(width, "light", "#/p/p-1/cards/C-1");
    await until("!!document.querySelector('[role=tab]')");
    await openFromTab();
    if (!(await zoomable())) break;
    const fit = await state();
    check(
      `${width} opens fitted, whole image inside the stage`,
      fit.image.y >= fit.stage.y - 0.5 &&
        fit.image.y + fit.image.h <= fit.stage.y + fit.stage.h + 0.5 &&
        fit.image.x >= fit.stage.x - 0.5 &&
        fit.image.x + fit.image.w <= fit.stage.x + fit.stage.w + 0.5,
      { fit },
    );
    // Wheel at a point: the image pixel under the pointer stays put.
    const at = {
      x: fit.image.x + fit.image.w * 0.3,
      y: fit.image.y + fit.image.h * 0.4,
    };
    const beforeWheel = imagePoint(fit, at);
    await wheel(at.x, at.y, -240);
    await settle();
    const wheeled = await state();
    const afterWheel = imagePoint(wheeled, at);
    // An axis on which the image is still smaller than the stage stays
    // centred; on the other the pixel under the pointer stays put.
    const centred = (axis) =>
      Math.abs(
        wheeled.image[axis] +
          wheeled.image[axis === "x" ? "w" : "h"] / 2 -
          (wheeled.stage[axis] + wheeled.stage[axis === "x" ? "w" : "h"] / 2),
      ) < 1;
    const kept = (i, axis, length) =>
      wheeled.image[length] <= wheeled.stage[length] + 0.5
        ? centred(axis)
        : Math.abs(afterWheel[i] - beforeWheel[i]) < 2;
    check(
      `${width} wheel zooms around the pointer`,
      wheeled.image.w > fit.image.w && kept(0, "x", "w") && kept(1, "y", "h"),
      { zoom: [fit.zoom, wheeled.zoom], beforeWheel, afterWheel },
    );
    // Drag pans; a drag that ends on blank space does not close.
    await button("原始大小 100%");
    await settle();
    const full = await state();
    check(
      `${width} grab cursor when the image is larger than the stage`,
      full.cursor === "grab",
      { cursor: full.cursor },
    );
    const centre = {
      x: full.stage.x + full.stage.w / 2,
      y: full.stage.y + full.stage.h / 2,
    };
    const blank = { x: full.stage.x + 2, y: full.stage.y + 2 };
    await drag(centre, { x: centre.x - 60, y: centre.y - 300 });
    const panned = await state();
    check(
      `${width} drag pans`,
      panned.open && Math.abs(panned.image.y - (full.image.y - 300)) < 1,
      { from: full.image, to: panned.image },
    );
    await drag(centre, blank);
    const ended = await state();
    check(
      `${width} a drag ending on blank space does not close`,
      ended.open,
      {},
    );
    // Far beyond the edges: the image still covers the stage vertically.
    const top = { x: centre.x, y: full.stage.y + 20 },
      bottom = { x: centre.x, y: full.stage.y + full.stage.h - 20 };
    for (let i = 0; i < 6; i++) await drag(top, bottom);
    let edge = await state();
    check(
      `${width} drag stops at the top edge`,
      Math.abs(edge.image.y - edge.stage.y) < 0.5,
      { edge },
    );
    for (let i = 0; i < 6; i++) await drag(bottom, top);
    edge = await state();
    check(
      `${width} drag stops at the bottom edge`,
      Math.abs(edge.image.y + edge.image.h - (edge.stage.y + edge.stage.h)) <
        0.5,
      { edge },
    );
    // Double click on the image: back to fit, and again to 100%.
    await click(centre.x, centre.y, 1);
    await click(centre.x, centre.y, 2);
    await settle();
    const toggled = await state();
    check(
      `${width} double click returns to fit`,
      toggled.zoom === fit.zoom && toggled.open,
      { zoom: toggled.zoom },
    );
    const onImage = {
      x: toggled.image.x + toggled.image.w / 2,
      y: toggled.image.y + toggled.image.h / 2,
    };
    await click(onImage.x, onImage.y, 1);
    await click(onImage.x, onImage.y, 2);
    await settle();
    check(
      `${width} double click goes to 100%`,
      (await state()).zoom === "100%",
      {},
    );
    // Next image starts fitted.
    await run(() =>
      document
        .querySelector("[role=dialog]")
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        ),
    );
    await waitOpen();
    const next = await state();
    check(
      `${width} the next image starts fitted`,
      next.title.includes("c830-wide-strip") &&
        Math.abs(next.image.w - Math.min(next.stage.w, 4000)) < 1,
      { next },
    );
    // A click on the image keeps it; one on blank space closes it.
    await click(next.image.x + 10, next.image.y + next.image.h / 2);
    check(
      `${width} a click on the image keeps the preview`,
      (await state()).open,
      {},
    );
    await click(next.stage.x + 4, next.stage.y + 4);
    await waitClosed();
    check(`${width} a click on blank space closes`, true, {});
    // Escape still closes.
    await openFromTab();
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await waitClosed();
    check(`${width} Escape closes`, true, {});
    // Touch: pinch with two fingers zooms; lifting them does not close; a
    // tap on blank space does.
    await send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    await openFromTab();
    const t0 = await state();
    const mid = {
      x: t0.stage.x + t0.stage.w / 2,
      y: t0.stage.y + t0.stage.h / 2,
    };
    const touch = (type, points) =>
      send("Input.dispatchTouchEvent", {
        type,
        touchPoints: points.map(([x, y], id) => ({ x, y, id })),
      });
    await touch("touchStart", [
      [mid.x - 20, mid.y],
      [mid.x + 20, mid.y],
    ]);
    for (let i = 1; i <= 6; i++)
      await touch("touchMove", [
        [mid.x - 20 - i * 15, mid.y],
        [mid.x + 20 + i * 15, mid.y],
      ]);
    await touch("touchEnd", []);
    await delay(400);
    const pinched = await state();
    check(
      `${width} pinch zooms by the finger distance`,
      pinched.open && pinched.image.w > t0.image.w * 3,
      { zoom: [t0.zoom, pinched.zoom] },
    );
    await touch("touchStart", [[mid.x, mid.y]]);
    for (let i = 1; i <= 5; i++)
      await touch("touchMove", [[mid.x, mid.y - i * 30]]);
    await touch("touchEnd", []);
    await delay(400);
    const swiped = await state();
    check(
      `${width} one finger pans and does not close`,
      swiped.open && swiped.image.y < pinched.image.y - 100,
      { from: pinched.image.y, to: swiped.image.y },
    );
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await waitClosed();

    // The same preview from a timeline Markdown chip and from a decision.
    for (const [place, selector] of [
      [
        "timeline chip",
        "[data-card-panel][id$=timeline]:not([hidden]) a[data-attachment-ref][data-kind=image]",
      ],
      [
        "decision",
        "[data-card-panel][id$=timeline]:not([hidden]) [aria-label=拍板附件] button[aria-label^=预览]",
      ],
    ]) {
      await tab("时间线");
      await until(`!!document.querySelector(${JSON.stringify(selector)})`);
      await run((selector) => {
        const e = document.querySelector(selector);
        e.scrollIntoView({ block: "center" });
        e.click();
      }, selector);
      await waitOpen();
      const opened = await state();
      const bar = await run(() =>
        [
          ...document.querySelectorAll("[role=dialog] [role=toolbar] button"),
        ].map((b) => b.getAttribute("aria-label")),
      );
      await wheel(
        opened.image.x + opened.image.w / 2,
        opened.image.y + opened.image.h / 2,
        -240,
      );
      await settle();
      const zoomed = await state();
      check(
        `${width} ${place}: same controls, wheel zooms`,
        JSON.stringify(bar) ===
          JSON.stringify(["缩小", "放大", "适应窗口", "原始大小 100%"]) &&
          zoomed.image.w > opened.image.w,
        { bar, zoom: [opened.zoom, zoomed.zoom] },
      );
      if (place === "decision" && width === 1440) {
        await park();
        await record(`preview-decision-${width}-light.png`);
      }
      // The zoomed image may cover the stage: click the preview's margin.
      await click(8, zoomed.stage.y + zoomed.stage.h / 2);
      await waitClosed();
      check(`${width} ${place}: blank click closes`, true, {});
    }
  }
  assert.deepEqual(browser.errors, []);

  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: "about:blank" });
  await until("location.href === 'about:blank'");
  const canvas = (fn, ...args) =>
    run(
      async (fn, ...args) => {
        const load = (src) =>
          new Promise((r) => {
            const img = new Image();
            img.onload = () => r(img);
            img.src = `data:image/png;base64,${src}`;
          });
        const imgs = await Promise.all(args.map(load));
        return new Function("imgs", fn)(imgs);
      },
      fn,
      ...args,
    );
  const pair = (left, right) =>
    canvas(
      `const [l, r] = imgs; const c = document.createElement("canvas");
       c.width = l.width + r.width + 16; c.height = Math.max(l.height, r.height);
       const x = c.getContext("2d"); x.fillStyle = "#888"; x.fillRect(0, 0, c.width, c.height);
       x.drawImage(l, 0, 0); x.drawImage(r, l.width + 16, 0);
       return c.toDataURL("image/png").split(",")[1];`,
      left,
      right,
    );
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const suffix = `${width}-${theme}.png`;
      await writeFile(
        resolve(output, `reference-${suffix}`),
        Buffer.from(
          await pair(shots[`list-${suffix}`], shots[`preview-fit-${suffix}`]),
          "base64",
        ),
      );
    }
  const diffs = {};
  if (before) {
    for (const name of Object.keys(shots)) {
      let old;
      try {
        old = (await readFile(resolve(before, name))).toString("base64");
      } catch {
        continue;
      }
      diffs[name] = await canvas(
        `const [a, b] = imgs; if (a.width !== b.width || a.height !== b.height) return "size";
         const px = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
           const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
         const [p, q] = [px(a), px(b)]; let n = 0;
         for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i+1] !== q[i+1] || p[i+2] !== q[i+2] || p[i+3] !== q[i+3]) n++;
         return n;`,
        old,
        shots[name],
      );
      await writeFile(
        resolve(output, `side-by-side-${name}`),
        Buffer.from(await pair(old, shots[name]), "base64"),
      );
    }
  }
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(
      {
        sha: git("rev-parse", "HEAD"),
        tree: git("rev-parse", "HEAD^{tree}"),
        dirty: git("status", "--porcelain") !== "",
        browser: version,
        viewport: "1440x1000 / 390x1000, DPR 1",
        data: "c830-fixture.tsx: 1 card, 3 PNG attachments (1440×3360 2×3 comparison with 9–10px labels, 4000×500 strip, 1440×900), 2 comments (one names 2 attachments as Markdown chips), 1 open decision with 2 attachments",
        cases: results,
        checks,
        diffs,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
