// C-659: hover dependency lines on the board. Captures 1440 and 390 × light/dark
// of the card page board (synthetic c659-fixture: 16 cards, 7 edges around
// C-23), default and hovered; at 1440 also keyboard focus, the board panned
// sideways, a folded lane, a lane scrolled while hovering, and after leaving.
// Measures every line's endpoints against the cards' edges, the line colour
// against the card hover border token, card typography and page overflow.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c659-capture.mjs <new dir>
//   --before   base code: only default and hover shots, no line assertions
//   --compare <before dir>   pixel-diff the default shots and build the
//                            side-by-side images (before | after hover)
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const before = args.includes("--before");
const compareAt = args.indexOf("--compare");
const compareDir = compareAt >= 0 ? resolve(args[compareAt + 1]) : null;
const outArg = args.find(
  (a, i) => !a.startsWith("--") && args[i - 1] !== "--compare",
);
assert(outArg, "Pass a new output directory");
const output = resolve(outArg);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c659-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const shot = req.url?.match(
            /^\/__c659-shot\/(before|after)\/([\w.-]+\.png)$/,
          );
          if (shot) {
            res.setHeader("Content-Type", "image/png");
            res.end(
              await readFile(
                resolve(shot[1] === "before" ? compareDir : output, shot[2]),
              ),
            );
            return;
          }
          if (req.url === "/__c659-blank") {
            res.setHeader("Content-Type", "text/html");
            res.end("<!doctype html><html><body></body></html>");
            return;
          }
          if (!req.url?.startsWith("/__c659")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c659",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c659-fixture.tsx"></script></body></html>',
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
  const base = server.resolvedUrls.local[0];
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
  const version = (await send("Browser.getVersion")).product;
  const run = (fn, ...a) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(a)})`);
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
    await delay(120);
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    return name;
  };
  const mouse = (x, y) =>
    send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  /** A point inside the card, right of its number, clear of text. */
  const hoverCard = async (id, middle = false) => {
    const point = await run(
      (id, middle) => {
        // The base code has no data-card-id: fall back to the number badge.
        const r = (
          document.querySelector(`[data-card-id="${id}"]`) ??
          [...document.querySelectorAll(".board-card")].find(
            (e) => e.querySelector(".card-id")?.textContent.trim() === id,
          )
        ).getBoundingClientRect();
        return {
          x: r.right - 24,
          y: middle ? (r.top + r.bottom) / 2 : r.bottom - 12,
        };
      },
      id,
      middle,
    );
    await mouse(point.x, point.y);
    await settle();
  };
  const measure = () =>
    run(() => {
      const r2 = (v) => Math.round(v * 10) / 10;
      const rect = (e) => {
        const r = e.getBoundingClientRect();
        return {
          left: r2(r.left),
          right: r2(r.right),
          top: r2(r.top),
          bottom: r2(r.bottom),
        };
      };
      const svg = document.querySelector("[data-board-dependencies]");
      const origin = svg?.getBoundingClientRect();
      const lines = [...(svg?.querySelectorAll("[data-edge]") ?? [])].map(
        (p) => {
          const a = p.getPointAtLength(0),
            b = p.getPointAtLength(p.getTotalLength()),
            s = getComputedStyle(p);
          return {
            key: p.dataset.edge,
            start: { x: r2(a.x + origin.left), y: r2(a.y + origin.top) },
            end: { x: r2(b.x + origin.left), y: r2(b.y + origin.top) },
            stroke: s.stroke,
            strokeWidth: s.strokeWidth,
            marker: !!p.getAttribute("marker-end"),
          };
        },
      );
      const visible = (e) => {
        let r = rect(e);
        for (const clip of [
          e.closest(".board-lane-cards"),
          document.querySelector(".board"),
        ]) {
          if (!clip) continue;
          const c = rect(clip);
          r = {
            left: Math.max(r.left, c.left),
            right: Math.min(r.right, c.right),
            top: Math.max(r.top, c.top),
            bottom: Math.min(r.bottom, c.bottom),
          };
        }
        return r.right - r.left >= 8 && r.bottom - r.top >= 8 ? r : null;
      };
      const cards = Object.fromEntries(
        [...document.querySelectorAll("[data-card-id]")].map((e) => [
          e.dataset.cardId,
          visible(e),
        ]),
      );
      const strips = Object.fromEntries(
        [...document.querySelectorAll(".board-column-collapsed")].map((e) => {
          const t = rect(e.querySelector(".column-toggle")),
            c = rect(e.querySelector(".board-column-count"));
          return [e.dataset.status, { ...t, top: c.top, bottom: c.bottom }];
        }),
      );
      const any = document.querySelector(".board-card");
      const title = any?.querySelector(".card-title");
      const badge = any?.querySelector(".board-card-badge");
      const theme = getComputedStyle(document.documentElement);
      return {
        lines,
        related: [
          ...document.querySelectorAll("[data-dependency-related]"),
        ].map((e) => ({
          id: e.dataset.cardId,
          border: getComputedStyle(e).borderTopColor,
        })),
        restingBorder: getComputedStyle(
          document.querySelector(
            ".board-card:not([data-dependency-related]):not(:hover)",
          ),
        ).borderTopColor,
        token: theme.getPropertyValue("--ui-border-hover").trim(),
        cards,
        strips,
        svgBeforeBoard:
          svg?.nextElementSibling === document.querySelector(".board"),
        svgPointerEvents: svg ? getComputedStyle(svg).pointerEvents : null,
        typography: {
          title: title && {
            size: getComputedStyle(title).fontSize,
            lineHeight: getComputedStyle(title).lineHeight,
          },
          badge: badge && {
            size: getComputedStyle(badge).fontSize,
            lineHeight: getComputedStyle(badge).lineHeight,
          },
        },
        boardScroll: {
          left: document.querySelector(".board").scrollLeft,
        },
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        fonts: [...document.fonts]
          .filter((f) => f.status === "loaded")
          .map((f) => f.family)
          .filter((v, i, a) => a.indexOf(v) === i),
      };
    });
  /** Every line starts on the hovered card and ends one arrow off the other. */
  const checkLines = (m, active, label) => {
    const near = (a, b) => Math.abs(a - b) <= 0.6;
    for (const line of m.lines) {
      const [from, to] = line.key.split(">");
      const box = (id) =>
        m.cards[id] ??
        m.strips[cardStatus[id]] ??
        assert.fail(`${label}: ${id} box`);
      const a = box(from),
        b = box(to);
      assert(
        near(line.start.x, a.left) || near(line.start.x, a.right),
        `${label} ${line.key}: start x ${line.start.x} on ${from} edge`,
      );
      assert(
        near(line.start.y, (a.top + a.bottom) / 2),
        `${label} ${line.key}: start y at ${from} middle`,
      );
      assert(
        near(line.end.x, b.left - 6) || near(line.end.x, b.right + 6),
        `${label} ${line.key}: end x ${line.end.x} one arrow from ${to}`,
      );
      assert(
        near(line.end.y, (b.top + b.bottom) / 2),
        `${label} ${line.key}: end y at ${to} middle`,
      );
      assert(line.marker, `${label} ${line.key}: arrow`);
      assert(from === active || to === active, `${label}: ${line.key}`);
    }
  };
  const cardStatus = {
    "C-51": "done",
    "C-52": "done",
    "C-41": "awaiting_merge",
  };
  const open = async (width, theme) => {
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
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${base}__c659#/p/p-1/cards?view=board`,
    });
    await until(
      "document.querySelectorAll('[data-card-id], .board-card').length >= 16",
    );
    await evaluate("document.fonts.ready.then(() => true)");
    await mouse(1, 999);
    await settle();
  };
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const tag = `${width}-${theme}`;
      const result = { width, theme, steps: {} };
      cases.push(result);
      await open(width, theme);
      result.scheme = await run(
        () => matchMedia("(prefers-color-scheme: dark)").matches,
      );
      result.steps.default = {
        shot: await shot(`default-${tag}.png`),
        ...(await measure()),
      };
      if (width === 390)
        // Narrow: bring C-23's lane into view so the hover is on screen.
        await run(() => {
          const lane = [...document.querySelectorAll(".board-card")]
            .find(
              (e) => e.querySelector(".card-id")?.textContent.trim() === "C-23",
            )
            .closest(".board-column");
          document.querySelector(".board").scrollLeft = lane.offsetLeft - 12;
        });
      await settle();
      await hoverCard("C-23");
      result.steps.hover = {
        shot: await shot(`hover-${tag}.png`),
        ...(await measure()),
      };
      if (before || width === 390) {
        await mouse(1, 999);
        await settle();
        result.steps.leave = await measure();
        continue;
      }
      // Leaving the card removes every line and highlight.
      await mouse(1, 999);
      await settle();
      result.steps.leave = {
        shot: await shot(`leave-${tag}.png`),
        ...(await measure()),
      };
      // Keyboard focus on the card's title link.
      await run(() =>
        document.querySelector('[data-card-id="C-23"] .card-tile-link').focus(),
      );
      await settle();
      result.steps.focus = {
        shot: await shot(`focus-${tag}.png`),
        ...(await measure()),
      };
      await run(() => document.activeElement.blur());
      await settle();
      result.steps.blur = await measure();
      // Scroll the in-progress lane while hovering (the pointer stays on
      // C-23): lines follow the card.
      await hoverCard("C-23", true);
      result.steps.laneScrollStart = await measure();
      await run(() => {
        document
          .querySelector('[data-card-id="C-23"]')
          .closest(".board-lane-cards").scrollTop = 40;
      });
      await settle();
      result.steps.laneScroll = {
        shot: await shot(`lane-scroll-${tag}.png`),
        ...(await measure()),
      };
      await run(() => {
        document
          .querySelector('[data-card-id="C-23"]')
          .closest(".board-lane-cards").scrollTop = 0;
      });
      await mouse(1, 999);
      await settle();
      // Pan the board sideways, then hover the awaiting-merge card C-41.
      await run(() => {
        const board = document.querySelector(".board");
        board.scrollLeft = 300;
      });
      await settle();
      await hoverCard("C-41");
      result.steps.pan = {
        shot: await shot(`pan-${tag}.png`),
        ...(await measure()),
      };
      // Fold the done lane: C-23's prerequisite C-51 points at the strip.
      await mouse(1, 999);
      await run(() =>
        document
          .querySelector('.board-column[data-status="done"] .lane-fold')
          .click(),
      );
      await until(
        "!!document.querySelector('.board-column-collapsed[data-status=\"done\"]')",
      );
      await run(() => {
        const board = document.querySelector(".board");
        board.scrollLeft = board.scrollWidth;
      });
      await settle();
      await hoverCard("C-23");
      result.steps.folded = {
        shot: await shot(`folded-${tag}.png`),
        ...(await measure()),
      };
      await mouse(1, 999);
      await settle();
      result.steps.foldedLeave = await measure();
    }
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify({ browser: version, before, cases }, null, 2)}\n`,
  );
  for (const c of cases) {
    const label = `${c.width}/${c.theme}`;
    assert.equal(c.scheme, c.theme === "dark", `${label}: scheme`);
    for (const [step, m] of Object.entries(c.steps))
      assert(m.scrollWidth <= m.innerWidth, `${label} ${step}: page overflows`);
    assert.equal(c.steps.default.lines.length, 0, `${label}: none by default`);
    assert.equal(c.steps.leave.lines.length, 0, `${label}: none after leave`);
    assert.equal(
      c.steps.leave.related.length,
      0,
      `${label}: no highlight left`,
    );
    if (before) continue;
    const hover = c.steps.hover;
    assert(hover.lines.length > 0, `${label}: hover draws lines`);
    assert(hover.svgBeforeBoard, `${label}: lines paint under the cards`);
    assert.equal(hover.svgPointerEvents, "none", `${label}: no hit area`);
    // Filtered-out C-99 never gets a line.
    assert(!hover.lines.some((l) => l.key.includes("C-99")), `${label}: C-99`);
    for (const line of hover.lines) {
      assert.equal(line.strokeWidth, "1px", `${label}: thin`);
      assert.equal(line.stroke, hover.related[0]?.border ?? line.stroke);
    }
    for (const r of hover.related)
      assert.notEqual(
        r.border,
        hover.restingBorder,
        `${label}: ${r.id} highlight`,
      );
    checkLines(hover, "C-23", `${label} hover`);
    if (c.width === 390) continue;
    // At 1440 the visible ends are C-11, C-27, C-32 and C-41 (C-51 is off to
    // the right, behind the sideways scroll).
    assert.deepEqual(
      hover.lines.map((l) => l.key).sort(),
      ["C-11>C-23", "C-23>C-27", "C-23>C-32", "C-23>C-41"],
      `${label}: visible ends`,
    );
    assert.deepEqual(
      c.steps.focus.lines.map((l) => l.key).sort(),
      hover.lines.map((l) => l.key).sort(),
      `${label}: focus matches hover`,
    );
    assert.equal(c.steps.blur.lines.length, 0, `${label}: none after blur`);
    checkLines(c.steps.laneScroll, "C-23", `${label} lane scroll`);
    // C-23 and its same-lane dependent moved up 40px; the lines moved too.
    const y = (step, key) =>
      c.steps[step].lines.find((l) => l.key === key)?.start.y;
    assert(
      Math.abs(
        y("laneScrollStart", "C-23>C-32") - y("laneScroll", "C-23>C-32") - 40,
      ) < 1,
      `${label}: lane scroll moves the line start by 40px`,
    );
    checkLines(c.steps.pan, "C-41", `${label} pan`);
    assert.deepEqual(
      c.steps.pan.lines.map((l) => l.key),
      ["C-23>C-41"],
      `${label}: pan`,
    );
    checkLines(c.steps.folded, "C-23", `${label} folded`);
    assert(
      c.steps.folded.lines.some((l) => l.key === "C-51>C-23"),
      `${label}: folded lane strip gets the line`,
    );
    assert.equal(c.steps.foldedLeave.lines.length, 0, `${label}: folded leave`);
  }
  if (compareDir) {
    // Pixel diff of the default shots, then side-by-side before | after hover.
    const report = [];
    for (const c of cases) {
      const tag = `${c.width}-${c.theme}`;
      await send("Emulation.setDeviceMetricsOverride", {
        width: c.width * 2 + 16,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", { url: `${base}__c659-blank` });
      await until("document.readyState === 'complete'");
      const diff = await run(async (tag) => {
        const load = (src) =>
          new Promise((ok, fail) => {
            const i = new Image();
            i.onload = () => ok(i);
            i.onerror = fail;
            i.src = src;
          });
        const pixels = (img) => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const x = c.getContext("2d");
          x.drawImage(img, 0, 0);
          return x.getImageData(0, 0, img.width, img.height).data;
        };
        const [a, b] = await Promise.all([
          load(`/__c659-shot/before/default-${tag}.png`),
          load(`/__c659-shot/after/default-${tag}.png`),
        ]);
        const pa = pixels(a),
          pb = pixels(b);
        let changed = 0;
        for (let i = 0; i < pa.length; i += 4)
          if (
            pa[i] !== pb[i] ||
            pa[i + 1] !== pb[i + 1] ||
            pa[i + 2] !== pb[i + 2] ||
            pa[i + 3] !== pb[i + 3]
          )
            changed++;
        document.body.innerHTML = `<div style="display:flex;gap:16px;background:#808080"><img src="/__c659-shot/before/default-${tag}.png"><img src="/__c659-shot/after/hover-${tag}.png"></div>`;
        document.body.style.margin = "0";
        await Promise.all([...document.images].map((i) => i.decode()));
        return { size: [a.width, a.height, b.width, b.height], changed };
      }, tag);
      report.push({ tag, defaultPixelsChanged: diff.changed, size: diff.size });
      await shot(`side-by-side-${tag}.png`);
    }
    await writeFile(
      resolve(output, "compare.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    for (const r of report)
      assert.equal(r.defaultPixelsChanged, 0, `${r.tag}: default unchanged`);
  }
  console.log(`C-659 capture ok: ${version}, ${cases.length} cases`);
} finally {
  await browser?.close();
  await server.close();
}
