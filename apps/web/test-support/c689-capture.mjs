// C-689: the board's hover dependency lines and their flowing dots in the
// reference look (C-673's board-dag-flow.png): cyan lines with a slight
// glow, bright cyan dots with a soft halo. Same synthetic board as C-659 /
// C-668 / C-673 (c659-fixture: 16 cards, C-23's lines go to its own lane,
// the neighbouring lanes and two lanes over); `?dense` adds six more links
// to C-23 for the performance run.
//
// 1440 and 390 × light/dark: default and hovered (dots frozen half a gap
// from every line's start, so shots are reproducible). At 1440 also four
// live frames of one line, a line crossing a title (its ink must not
// change), a dot on that title (recorded), keyboard focus, leaving (the
// animation must stop), and reduced motion (still lines and arrows, no
// animation). Asserts the C-673 behaviour (dots move from each line's start
// towards its arrow at one speed, 1–3 per line evenly spaced, halo rings
// moving with their dot) and the new look: line, arrow, glow and dot take
// the `--ui-dependency-*` tokens, all cyan, the dot stands out more than
// the line. Then, with the dense fixture and the browser's default
// compositing, measures frame times while the lanes scroll and the board
// pans with ten lines shown, with dots and with reduced motion.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c689-capture.mjs <new dir>
//   --before   base code: only default and hover shots, no assertions
//   --compare <before dir>   pixel-diff the default shots and build the
//                            side-by-side images (before hover | after hover)
//   --reference <png>        the reference image (attachment-9282): adds
//                            reference | after hover images and a zoom pair
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
const referenceAt = args.indexOf("--reference");
const reference = referenceAt >= 0 ? resolve(args[referenceAt + 1]) : null;
const outArg = args.find(
  (a, i) =>
    !a.startsWith("--") &&
    args[i - 1] !== "--compare" &&
    args[i - 1] !== "--reference",
);
assert(outArg, "Pass a new output directory");
const output = resolve(outArg);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c689-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const shot = req.url?.match(
            /^\/__c689-shot\/(before|after)\/([\w.-]+\.png)$/,
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
          if (req.url === "/__c689-reference.png" && reference) {
            res.setHeader("Content-Type", "image/png");
            res.end(await readFile(reference));
            return;
          }
          if (req.url === "/__c689-blank") {
            res.setHeader("Content-Type", "text/html");
            res.end("<!doctype html><html><body></body></html>");
            return;
          }
          if (!req.url?.startsWith("/__c689")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c689",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c659-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});

/**
 * Counts animation frame requests and can park them: while parked, the
 * dots' loop stops at its current phase; releasing resumes it.
 */
const RAF_PROBE = `(() => {
  const request = window.requestAnimationFrame.bind(window);
  const parked = [];
  window.__raf = { calls: 0, parked: false };
  window.__rafRaw = request;
  window.requestAnimationFrame = (cb) => {
    window.__raf.calls++;
    if (window.__raf.parked) { parked.push(cb); return -1; }
    return request(cb);
  };
  window.__rafRelease = () => {
    window.__raf.parked = false;
    for (const cb of parked.splice(0)) request(cb);
  };
})();`;

const DETERMINISTIC = [
  "--run-all-compositor-stages-before-draw",
  "--disable-new-content-rendering-timeout",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--disable-partial-raster",
  "--disable-gpu",
  "--disable-skia-runtime-opts",
  "--force-color-profile=srgb",
  "--num-raster-threads=1",
];

/** C-689 sizes (BoardDependencyLayout.module.css), as computed styles. */
const LINE = { width: "1.5px", glow: "4px" };
const DOT = "4px";
/** Halo rings around every dot, outer first (painted under the dot). */
const HALOS = ["18px", "12px", "8px"];

const cases = [];
const report = { cases };
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  const base = server.resolvedUrls.local[0];

  /** One browser session with the page helpers bound to it. */
  const session = async (flags) => {
    const b = await chromium({ args: flags });
    const { send, evaluate } = b;
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
      // The raw frame request: settles even while the dots are parked.
      await run(
        () =>
          new Promise((r) => {
            const frame = window.__rafRaw ?? requestAnimationFrame;
            frame(() => frame(r));
          }),
      );
      await delay(120);
    };
    const mouse = (x, y) =>
      send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    const open = async (width, theme, { reduce = false, dense = false }) => {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          {
            name: "prefers-reduced-motion",
            value: reduce ? "reduce" : "no-preference",
          },
        ],
      });
      await send("Page.navigate", { url: "about:blank" });
      await until("location.href === 'about:blank'");
      await send("Page.navigate", {
        url: `${base}__c689${dense ? "?dense" : ""}#/p/p-1/cards?view=board`,
      });
      await until(
        "document.querySelectorAll('[data-card-id], .board-card').length >= 16",
      );
      await evaluate("document.fonts.ready.then(() => true)");
      await mouse(1, 999);
      await settle();
    };
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: RAF_PROBE });
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const version = (await send("Browser.getVersion")).product;
    return {
      ...b,
      send,
      evaluate,
      run,
      until,
      settle,
      mouse,
      open,
      version,
    };
  };

  browser = await session(DETERMINISTIC);
  const { send, run, settle, mouse, open } = browser;
  report.browser = browser.version;
  const shot = async (name, clip, scale = 1) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      ...(clip ? { clip: { ...clip, scale } } : {}),
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    return name;
  };
  /** A point inside the card, right of its number, clear of text. */
  const hoverCard = async (id) => {
    const point = await run((id) => {
      const r = (
        document.querySelector(`[data-card-id="${id}"]`) ??
        [...document.querySelectorAll(".board-card")].find(
          (e) => e.querySelector(".card-id")?.textContent.trim() === id,
        )
      ).getBoundingClientRect();
      return { x: r.right - 24, y: r.bottom - 12 };
    }, id);
    await mouse(point.x, point.y);
    await settle();
  };
  const rafCalls = async (ms) => {
    const a = await run(() => window.__raf.calls);
    await delay(ms);
    return (await run(() => window.__raf.calls)) - a;
  };
  const park = async () => {
    await run(() => {
      window.__raf.parked = true;
    });
    await delay(80);
  };
  const release = () => run(() => window.__rafRelease());
  /**
   * Every line and its dots: dash attributes, the dots' positions along the
   * line, where the line starts and ends (which card's box), colours.
   */
  const flow = () =>
    run(() => {
      const r2 = (v) => Math.round(v * 100) / 100;
      const svg = document.querySelector("[data-board-dependencies]");
      if (!svg) return { svg: false, lines: [] };
      const origin = svg.getBoundingClientRect();
      const boxOf = (id) => {
        const el =
          document.querySelector(`[data-card-id="${id}"]`) ??
          document.querySelector(".board-column-collapsed .column-toggle");
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const near = (p, b) =>
        p.x >= b.left - 8 &&
        p.x <= b.right + 8 &&
        p.y >= b.top - 1 &&
        p.y <= b.bottom + 1;
      const lines = [...svg.querySelectorAll("[data-edge]")].map((line) => {
        const key = line.dataset.edge;
        const dots = svg.querySelector(`[data-flow="${key}"]`);
        const total = line.getTotalLength();
        const at = (s) => {
          const q = line.getPointAtLength(s);
          return { x: q.x + origin.left, y: q.y + origin.top };
        };
        const [from, to] = key.split(">");
        const start = at(0),
          end = at(total);
        const ls = getComputedStyle(line);
        const arrow = svg.querySelector("marker path");
        // C-689: the glow under the line (base code has none).
        const glow = svg.querySelector(`[data-edge-glow="${key}"]`);
        const gs = glow && getComputedStyle(glow);
        const result = {
          key,
          length: r2(total),
          startsAtPrerequisite: near(start, boxOf(from)),
          endsAtDependent: near(end, boxOf(to)),
          sameD: dots
            ? dots.getAttribute("d") === line.getAttribute("d")
            : null,
          lineStroke: ls.stroke,
          lineWidth: ls.strokeWidth,
          lineOpacity: ls.strokeOpacity,
          arrowFill: arrow ? getComputedStyle(arrow).fill : null,
          marker: !!line.getAttribute("marker-end"),
          lineGlow: glow
            ? {
                before: !!(
                  glow.compareDocumentPosition(line) &
                  Node.DOCUMENT_POSITION_FOLLOWING
                ),
                sameD: glow.getAttribute("d") === line.getAttribute("d"),
                stroke: gs.stroke,
                width: gs.strokeWidth,
                opacity: gs.strokeOpacity,
                marker: glow.hasAttribute("marker-end"),
              }
            : null,
        };
        if (!dots) return result;
        const ds = getComputedStyle(dots);
        // C-689: halo rings around every dot, moved with it.
        const halos = [
          ...svg.querySelectorAll(`[data-flow-glow="${key}"]`),
        ].map((h) => {
          const hs = getComputedStyle(h);
          return {
            before: !!(
              h.compareDocumentPosition(dots) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
            sameD: h.getAttribute("d") === line.getAttribute("d"),
            sameDash:
              h.getAttribute("stroke-dasharray") ===
                dots.getAttribute("stroke-dasharray") &&
              h.getAttribute("stroke-dashoffset") ===
                dots.getAttribute("stroke-dashoffset"),
            stroke: hs.stroke,
            width: hs.strokeWidth,
            opacity: hs.strokeOpacity,
            cap: hs.strokeLinecap,
            marker: h.hasAttribute("marker-end"),
          };
        });
        const gap = Number(dots.getAttribute("stroke-dasharray").split(" ")[1]);
        const offset = Number(dots.getAttribute("stroke-dashoffset"));
        const phase = (((gap - offset) % gap) + gap) % gap;
        const positions = [];
        for (let s = phase; s <= total + 0.01; s += gap) positions.push(s);
        return {
          ...result,
          gap,
          offset,
          phase: r2(phase),
          dots: Math.round(total / gap),
          dotPositions: positions.map(r2),
          dotPoints: positions.map((s) => {
            const p = at(Math.min(s, total));
            return [r2(p.x), r2(p.y)];
          }),
          dotStroke: ds.stroke,
          dotWidth: ds.strokeWidth,
          dotCap: ds.strokeLinecap,
          dotMarker: dots.hasAttribute("marker-end"),
          dotDisplay: ds.display,
          halos,
        };
      });
      const theme = getComputedStyle(document.documentElement);
      const title = document.querySelector(".card-title");
      const tile = document.querySelector(".board-card");
      const token = (name) => {
        // Resolved to a computed colour, so it compares with strokes.
        const probe = document.createElement("i");
        probe.style.color = `var(${name})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return { value: theme.getPropertyValue(name).trim(), color };
      };
      return {
        svg: true,
        lines,
        flowPaths: svg.querySelectorAll("[data-flow]").length,
        glowPaths: svg.querySelectorAll("[data-flow-glow]").length,
        tokens: {
          line: token("--ui-dependency-line"),
          dot: token("--ui-dependency-dot"),
          glow: token("--ui-dependency-glow"),
        },
        text: getComputedStyle(title).color,
        background: getComputedStyle(document.body).backgroundColor,
        cardBackground: getComputedStyle(tile).backgroundColor,
        blend: getComputedStyle(svg).mixBlendMode,
        pointerEvents: getComputedStyle(svg).pointerEvents,
        typography: {
          size: getComputedStyle(title).fontSize,
          lineHeight: getComputedStyle(title).lineHeight,
        },
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
      };
    });

  /** Any rgb()/color(srgb) string as 0–255 channels. */
  const channels = (css) => {
    const srgb = css.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
    if (srgb) return srgb.slice(1, 4).map((v) => Math.round(Number(v) * 255));
    return css
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
  };

  /** Pixels of two base64 PNGs, compared in the page. */
  const comparePixels = (a, b, dark, ink) =>
    run(
      async (a, b, dark, ink) => {
        const load = (src) =>
          new Promise((ok, fail) => {
            const i = new Image();
            i.onload = () => ok(i);
            i.onerror = fail;
            i.src = `data:image/png;base64,${src}`;
          });
        const pixels = (img) => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const x = c.getContext("2d");
          x.drawImage(img, 0, 0);
          return x.getImageData(0, 0, img.width, img.height).data;
        };
        const [pa, pb] = (await Promise.all([load(a), load(b)])).map(pixels);
        let changed = 0,
          inked = 0,
          inkChanged = 0;
        for (let i = 0; i < pb.length; i += 4) {
          const rgb = [pb[i], pb[i + 1], pb[i + 2]];
          const isInk = dark
            ? rgb.every((v, k) => v >= ink[k])
            : rgb.every((v, k) => v <= ink[k]);
          const differs =
            pa[i] !== pb[i] ||
            pa[i + 1] !== pb[i + 1] ||
            pa[i + 2] !== pb[i + 2];
          if (isInk) inked++;
          if (differs) changed++;
          if (isInk && differs) inkChanged++;
        }
        return { changed, ink: inked, inkChanged };
      },
      a,
      b,
      dark,
      ink,
    );

  /**
   * Find a title line some line crosses (not one of its own ends) and put a
   * dot (with its halo) there. Grab that title line three ways: dot and line,
   * line only (dots hidden) and no overlay. With the line only, text ink
   * (darker than the line in light, lighter in dark) must be identical; the
   * dot passing over is recorded.
   */
  const onText = async (theme, tag, lineRgb) => {
    const spot = await run(() => {
      const svg = document.querySelector("[data-board-dependencies]");
      const origin = svg.getBoundingClientRect();
      for (const line of svg.querySelectorAll("[data-edge]")) {
        const ends = line.dataset.edge.split(">");
        const total = line.getTotalLength();
        for (let s = 12; s < total - 12; s += 1) {
          const q = line.getPointAtLength(s);
          const x = q.x + origin.left,
            y = q.y + origin.top;
          for (const tile of document.querySelectorAll("[data-card-id]")) {
            if (ends.includes(tile.dataset.cardId)) continue;
            const title = tile.querySelector(".card-title");
            if (!title) continue;
            const range = document.createRange();
            range.selectNodeContents(title);
            for (const r of range.getClientRects())
              if (
                x > r.left + 4 &&
                x < r.right - 4 &&
                y > r.top + 3 &&
                y < r.bottom - 3
              ) {
                const key = line.dataset.edge;
                for (const dots of svg.querySelectorAll(
                  `[data-flow="${key}"], [data-flow-glow="${key}"]`,
                )) {
                  const gap = Number(
                    dots.getAttribute("stroke-dasharray").split(" ")[1],
                  );
                  dots.setAttribute(
                    "stroke-dashoffset",
                    String(gap - (s % gap)),
                  );
                }
                return {
                  edge: key,
                  card: tile.dataset.cardId,
                  at: [Math.round(x), Math.round(y)],
                  rect: {
                    x: Math.floor(r.left),
                    y: Math.floor(r.top),
                    width: Math.ceil(r.width),
                    height: Math.ceil(r.height),
                  },
                };
              }
          }
        }
      }
      return null;
    });
    if (!spot) return null;
    await settle();
    const grab = async () =>
      (
        await send("Page.captureScreenshot", {
          format: "png",
          clip: { ...spot.rect, scale: 1 },
          captureBeyondViewport: false,
        })
      ).data;
    const hide = (selector, hidden) =>
      run(
        (selector, hidden) => {
          for (const e of document.querySelectorAll(selector))
            e.style.visibility = hidden ? "hidden" : "";
        },
        selector,
        hidden,
      ).then(settle);
    const withDot = await grab();
    await hide("[data-flow], [data-flow-glow]", true);
    const lineOnly = await grab();
    await hide("[data-board-dependencies]", true);
    const without = await grab();
    await hide("[data-board-dependencies]", false);
    await hide("[data-flow], [data-flow-glow]", false);
    for (const [name, data] of [
      [`dot-on-text-${tag}.png`, withDot],
      [`line-on-text-${tag}.png`, lineOnly],
      [`off-text-${tag}.png`, without],
    ])
      await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    const dark = theme === "dark";
    return {
      ...spot,
      line: await comparePixels(lineOnly, without, dark, lineRgb),
      dot: await comparePixels(withDot, without, dark, lineRgb),
    };
  };

  /** Freeze the dots half a gap from every line's start. */
  const freezeHalfGap = () =>
    run(() => {
      for (const p of document.querySelectorAll(
        "[data-flow], [data-flow-glow]",
      )) {
        const gap = Number(p.getAttribute("stroke-dasharray").split(" ")[1]);
        p.setAttribute("stroke-dashoffset", String(gap / 2));
      }
    });

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const tag = `${width}-${theme}`;
      const result = { width, theme, steps: {} };
      cases.push(result);
      await open(width, theme, {});
      result.steps.default = {
        shot: await shot(`default-${tag}.png`),
        ...(await flow()),
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
      if (before) {
        // As long as the after run spends before its shot: the title
        // tooltip has opened in both.
        await delay(1000);
        result.steps.hover = { shot: await shot(`hover-${tag}.png`) };
        continue;
      }
      await delay(400);
      // Two samples 300ms apart while the dots run.
      const t0 = await run(() => performance.now());
      const a = await flow();
      await delay(300);
      const t1 = await run(() => performance.now());
      const b = await flow();
      result.steps.moving = {
        ms: Math.round(t1 - t0),
        rafPerSecond: await rafCalls(1000),
        lines: a.lines.map((l, i) => {
          const m = b.lines[i];
          return {
            key: l.key,
            length: l.length,
            dots: l.dots,
            gap: l.gap,
            phase: [l.phase, m.phase],
            advanced: Math.round(
              (((m.phase - l.phase) % l.gap) + l.gap) % l.gap,
            ),
          };
        }),
      };
      if (width === 1440) {
        // Four live frames left of C-23 (C-11 → C-23), 200ms apart, at 2×.
        const clip = await run(() => {
          const r = document
            .querySelector('[data-card-id="C-23"]')
            .getBoundingClientRect();
          return {
            x: Math.max(0, Math.floor(r.left - 360)),
            y: Math.max(0, Math.floor(r.top - 260)),
            width: 420,
            height: 330,
          };
        });
        result.steps.frames = [];
        for (let i = 0; i < 4; i++) {
          await park();
          result.steps.frames.push({
            shot: await shot(`frame-${i}-${tag}.png`, clip, 2),
            phases: (await flow()).lines.map((l) => [l.key, l.phase]),
          });
          await release();
          await delay(200);
        }
      }
      await park();
      await freezeHalfGap();
      await settle();
      result.steps.hover = {
        shot: await shot(`hover-${tag}.png`),
        ...(await flow()),
      };
      const lineRgb = channels(result.steps.hover.lines[0].lineStroke);
      if (width === 1440) {
        result.steps.onText = await onText(theme, tag, lineRgb);
      }
      await release();
      // Leaving removes the lines and stops the animation.
      await mouse(1, 999);
      await settle();
      result.steps.leave = {
        ...(await flow()),
        rafPerSecond: await rafCalls(1000),
      };
      if (width === 1440) {
        await run(() =>
          document
            .querySelector('[data-card-id="C-23"] .card-tile-link')
            .focus(),
        );
        await settle();
        await delay(300);
        const f0 = await flow();
        await delay(300);
        const f1 = await flow();
        result.steps.focus = {
          lines: f0.lines.length,
          moved: f0.lines.map((l, i) => l.phase !== f1.lines[i].phase),
        };
        await run(() => document.activeElement.blur());
        await settle();
        result.steps.blur = {
          ...(await flow()),
          rafPerSecond: await rafCalls(1000),
        };
        // Reduced motion: still lines and arrows only.
        await open(width, theme, { reduce: true });
        await hoverCard("C-23");
        await delay(1000);
        result.steps.reduced = {
          shot: await shot(`reduced-${tag}.png`),
          ...(await flow()),
          rafPerSecond: await rafCalls(1000),
        };
      }
    }

  if (!before) {
    // The four live frames of each theme side by side: one short recording.
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: 4 * 840 + 3 * 16,
        height: 660,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", { url: `${base}__c689-blank` });
      await browser.until("document.readyState === 'complete'");
      await run(async (theme) => {
        document.body.innerHTML = `<div style="display:flex;gap:16px;background:#808080">${[
          0, 1, 2, 3,
        ]
          .map(
            (i) =>
              `<img src="/__c689-shot/after/frame-${i}-1440-${theme}.png">`,
          )
          .join("")}</div>`;
        document.body.style.margin = "0";
        await Promise.all([...document.images].map((i) => i.decode()));
      }, theme);
      await shot(`frames-1440-${theme}.png`);
    }
    /** Relative luminance of 0–255 channels. */
    const luminance = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
      const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    /** Cyan: green and blue both well above red. */
    const cyan = (rgb) => rgb[1] - rgb[0] >= 40 && rgb[2] - rgb[0] >= 40;
    for (const c of cases) {
      const label = `${c.width}/${c.theme}`;
      const { hover, moving, leave } = c.steps;
      assert(
        hover.lines.length >= (c.width === 1440 ? 4 : 2),
        `${label}: lines shown`,
      );
      assert.equal(hover.flowPaths, hover.lines.length, `${label}: dots`);
      assert.equal(
        hover.glowPaths,
        HALOS.length * hover.lines.length,
        `${label}: halos`,
      );
      assert.equal(hover.scrollWidth, hover.innerWidth, `${label}: overflow`);
      const { tokens } = hover;
      const lineRgb = channels(tokens.line.color);
      const dotRgb = channels(tokens.dot.color);
      const glowRgb = channels(tokens.glow.color);
      const bg = channels(hover.cardBackground);
      for (const [name, rgb] of [
        ["line", lineRgb],
        ["dot", dotRgb],
        ["glow", glowRgb],
      ])
        assert(cyan(rgb), `${label}: ${name} ${tokens[name].value} is cyan`);
      // The dot stands out more than the line on the card surface.
      assert(
        contrast(dotRgb, bg) > contrast(lineRgb, bg),
        `${label}: dot clearer than line`,
      );
      // The line is clear (≥ 3:1 on the card surface, the non-text minimum).
      assert(contrast(lineRgb, bg) >= 3, `${label}: line contrast`);
      for (const l of hover.lines) {
        const k = `${label} ${l.key}`;
        assert(l.startsAtPrerequisite, `${k}: starts at from`);
        assert(l.endsAtDependent, `${k}: ends at to`);
        assert(l.marker && !l.dotMarker, `${k}: one arrow`);
        assert(l.sameD, `${k}: dots on the line`);
        assert(l.dots >= 1 && l.dots <= 3, `${k}: 1–3 dots`);
        assert.equal(l.lineStroke, tokens.line.color, `${k}: line token`);
        assert.equal(l.arrowFill, tokens.line.color, `${k}: arrow as line`);
        assert.equal(l.lineWidth, LINE.width, `${k}: line width`);
        assert.equal(l.lineOpacity, "1", `${k}: opaque line`);
        assert(l.lineGlow, `${k}: line glow`);
        assert(l.lineGlow.before && l.lineGlow.sameD, `${k}: glow under line`);
        assert(!l.lineGlow.marker, `${k}: glow has no arrow`);
        assert.equal(l.lineGlow.stroke, tokens.line.color, `${k}: glow token`);
        assert.equal(l.lineGlow.width, LINE.glow, `${k}: glow width`);
        assert.equal(l.dotStroke, tokens.dot.color, `${k}: dot token`);
        assert.equal(l.dotCap, "round", `${k}: round dots`);
        assert.equal(l.dotWidth, DOT, `${k}: dot size`);
        assert.deepEqual(
          l.halos.map((h) => h.width),
          HALOS,
          `${k}: halo rings`,
        );
        for (const h of l.halos) {
          assert(h.before && h.sameD && h.sameDash, `${k}: halo with dot`);
          assert(h.cap === "round" && !h.marker, `${k}: round halo`);
          assert.equal(h.stroke, tokens.glow.color, `${k}: halo token`);
          assert(Number(h.opacity) < 1, `${k}: soft halo`);
        }
        // Evenly spaced along the whole line.
        assert(Math.abs(l.gap * l.dots - l.length) < 2, `${k}: even gaps`);
      }
      // Forward (start → arrow) at one speed on every line.
      for (const m of moving.lines) {
        const expected = (64 * moving.ms) / 1000;
        assert(
          Math.abs(m.advanced - (expected % m.gap)) <= 12,
          `${label} ${m.key}: advanced ${m.advanced}px, expected ≈${expected}`,
        );
      }
      assert(moving.rafPerSecond >= 30, `${label}: animating`);
      assert(!leave.svg, `${label}: leave removes lines`);
      assert.equal(leave.rafPerSecond, 0, `${label}: leave stops animation`);
      if (c.width === 1440) {
        const { onText, focus, blur, reduced } = c.steps;
        assert(onText, `${label}: a line crosses a title`);
        assert(onText.line.changed > 0, `${label}: the line paints`);
        assert(onText.line.ink > 0, `${label}: the title has ink`);
        assert.equal(onText.line.inkChanged, 0, `${label}: no ink changed`);
        assert(
          onText.dot.changed > onText.line.changed,
          `${label}: dot paints`,
        );
        assert(
          focus.lines >= 3 && focus.moved.every(Boolean),
          `${label}: focus`,
        );
        assert(!blur.svg && blur.rafPerSecond === 0, `${label}: blur stops`);
        assert(reduced.lines.length >= 3, `${label}: reduced lines`);
        assert.equal(reduced.flowPaths, 0, `${label}: reduced has no dots`);
        assert.equal(reduced.glowPaths, 0, `${label}: reduced has no halos`);
        assert(
          reduced.lines.every((l) => l.marker && l.lineGlow),
          `${label}: reduced arrows and glow`,
        );
        assert.equal(reduced.rafPerSecond, 0, `${label}: reduced is still`);
      }
    }
  }

  if (compareDir) {
    const diff = [];
    for (const c of cases) {
      const tag = `${c.width}-${c.theme}`;
      await send("Emulation.setDeviceMetricsOverride", {
        width: c.width * 2 + 16,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", { url: `${base}__c689-blank` });
      await browser.until("document.readyState === 'complete'");
      const d = await run(async (tag) => {
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
        const count = (a, b) => {
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
          return changed;
        };
        const [a, b, ha, hb] = await Promise.all([
          load(`/__c689-shot/before/default-${tag}.png`),
          load(`/__c689-shot/after/default-${tag}.png`),
          load(`/__c689-shot/before/hover-${tag}.png`),
          load(`/__c689-shot/after/hover-${tag}.png`),
        ]);
        document.body.innerHTML = `<div style="display:flex;gap:16px;background:#808080"><img src="/__c689-shot/before/hover-${tag}.png"><img src="/__c689-shot/after/hover-${tag}.png"></div>`;
        document.body.style.margin = "0";
        await Promise.all([...document.images].map((i) => i.decode()));
        return {
          defaultPixelsChanged: count(a, b),
          hoverPixelsChanged: count(ha, hb),
        };
      }, tag);
      diff.push({ tag, ...d });
      await shot(`side-by-side-${tag}.png`);
    }
    report.compare = diff;
    for (const r of diff)
      assert.equal(r.defaultPixelsChanged, 0, `${r.tag}: default unchanged`);
  }

  if (reference && !before) {
    // Reference (natural size) | after hover, for 1440 dark/light and 390
    // dark; then a zoom pair: the reference's dots and lines left of its
    // C-58/C-59 cards at 1.7× (its text renders about 1.16× ours, so that is
    // about our 2×) | four live frames' first one at 2×.
    const pairs = [
      ["1440-dark", "hover-1440-dark.png"],
      ["1440-light", "hover-1440-light.png"],
      ["390-dark", "hover-390-dark.png"],
      ["zoom-dark", "frame-0-1440-dark.png"],
      ["zoom-light", "frame-0-1440-light.png"],
    ];
    report.reference = [];
    await send("Page.navigate", { url: `${base}__c689-blank` });
    await browser.until("document.readyState === 'complete'");
    for (const [tag, after] of pairs) {
      const zoom = tag.startsWith("zoom");
      const size = await run(
        async (after, zoom) => {
          const load = (src) =>
            new Promise((ok, fail) => {
              const i = new Image();
              i.onload = () => ok(i);
              i.onerror = fail;
              i.src = src;
            });
          const [ref, shot] = await Promise.all([
            load("/__c689-reference.png"),
            load(`/__c689-shot/after/${after}`),
          ]);
          const crop = zoom
            ? { x: 560, y: 120, width: 500, height: 390, scale: 1.7 }
            : { x: 0, y: 0, width: ref.width, height: ref.height, scale: 1 };
          const left = {
            width: Math.round(crop.width * crop.scale),
            height: Math.round(crop.height * crop.scale),
          };
          const canvas = document.createElement("canvas");
          canvas.width = left.width + 16 + shot.width;
          canvas.height = Math.max(left.height, shot.height);
          const x = canvas.getContext("2d");
          x.fillStyle = "#808080";
          x.fillRect(0, 0, canvas.width, canvas.height);
          x.drawImage(
            ref,
            crop.x,
            crop.y,
            crop.width,
            crop.height,
            0,
            0,
            left.width,
            left.height,
          );
          x.drawImage(shot, left.width + 16, 0);
          document.body.innerHTML = "";
          document.body.style.margin = "0";
          document.body.append(canvas);
          return {
            width: canvas.width,
            height: canvas.height,
            referenceCrop: crop,
          };
        },
        after,
        zoom,
      );
      await send("Emulation.setDeviceMetricsOverride", {
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await settle();
      report.reference.push({
        tag,
        after,
        ...size,
        shot: await shot(`reference-vs-${tag}.png`),
      });
      await send("Page.navigate", { url: `${base}__c689-blank` });
      await browser.until("document.readyState === 'complete'");
    }
  }

  if (!before) {
    // Performance: the browser's default compositing (no deterministic
    // flags), dense fixture, C-23 focused so its ten lines stay while the
    // lanes scroll and the board pans under a still pointer.
    await browser.close();
    browser = await session(["--force-color-profile=srgb"]);
    const perf = [];
    for (const reduce of [false, true]) {
      await browser.open(1440, "light", { reduce, dense: true });
      await browser.run(() =>
        document.querySelector('[data-card-id="C-23"] .card-tile-link').focus(),
      );
      await browser.settle();
      await delay(500);
      const shown = await browser.run(() => ({
        lines: document.querySelectorAll("[data-edge]").length,
        dots: document.querySelectorAll("[data-flow]").length,
        halos: document.querySelectorAll("[data-flow-glow]").length,
      }));
      await browser.send("Performance.enable");
      const metrics = async () =>
        Object.fromEntries(
          (await browser.send("Performance.getMetrics")).metrics.map((m) => [
            m.name,
            m.value,
          ]),
        );
      const m0 = await metrics();
      const frames = await browser.run(
        () =>
          new Promise((done) => {
            const board = document.querySelector(".board");
            const lanes = [...document.querySelectorAll(".board-lane-cards")];
            const times = [];
            const start = performance.now();
            const step = (now) => {
              times.push(now);
              const t = (now - start) / 1000;
              // Pan sideways and scroll every lane, back and forth.
              board.scrollLeft = 120 * (1 - Math.cos(t * 2));
              for (const lane of lanes)
                lane.scrollTop = 60 * (1 - Math.cos(t * 3));
              if (now - start < 4000) requestAnimationFrame(step);
              else done(times);
            };
            requestAnimationFrame(step);
          }),
      );
      const m1 = await metrics();
      const gaps = frames.slice(1).map((t, i) => t - frames[i]);
      const sorted = [...gaps].sort((a, b) => a - b);
      const seconds = (frames.at(-1) - frames[0]) / 1000;
      perf.push({
        mode: reduce ? "reduced-motion (still lines)" : "dots flowing",
        ...shown,
        frames: frames.length,
        fps: Math.round(((frames.length - 1) / seconds) * 10) / 10,
        frameMs: {
          median: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
          p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
          max: Math.round(sorted.at(-1) * 10) / 10,
        },
        over25ms: gaps.filter((g) => g > 25).length,
        perSecondMs: Object.fromEntries(
          [
            "TaskDuration",
            "ScriptDuration",
            "LayoutDuration",
            "RecalcStyleDuration",
          ].map((k) => [
            k,
            Math.round(((m1[k] - m0[k]) * 1000 * 10) / seconds) / 10,
          ]),
        ),
      });
      if (!reduce)
        await browser
          .send("Page.captureScreenshot", { format: "png" })
          .then(({ data }) =>
            writeFile(
              resolve(output, "perf-dense-1440-light.png"),
              Buffer.from(data, "base64"),
            ),
          );
    }
    report.performance = perf;
    for (const p of perf) assert(p.lines >= 5, `${p.mode}: 5+ lines`);
  }
  await writeFile(
    resolve(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`C-689 capture ok: ${report.browser}, ${cases.length} cases`);
} finally {
  await browser?.close();
  await server.close();
}
