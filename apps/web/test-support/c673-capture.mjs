// C-673: dots flowing along the board's hover dependency lines, the way the
// arrows point. Same synthetic board as C-659 / C-668 (c659-fixture: 16
// cards, C-23's lines go to its own lane, the neighbouring lanes and two
// lanes over); `?dense` adds six more links to C-23 for the performance run.
//
// 1440 and 390 × light/dark: default and hovered (dots frozen half a gap
// from every line's start, so shots are reproducible). At 1440 also four
// live frames of one line, a dot placed on a crossed title line (its ink
// must not change), keyboard focus, leaving (the animation must stop), and
// reduced motion (still lines and arrows, no animation). Asserts the dots
// move from each line's start (the prerequisite) towards its arrow (the
// dependent) at one speed, 1–3 per line evenly spaced, in a colour between
// the line and the text. Then, with the dense fixture and the browser's
// default compositing, measures frame times while the lanes scroll and the
// board pans with ten lines shown, with dots and with reduced motion.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c673-capture.mjs <new dir>
//   --before   base code: only default and hover shots, no dot assertions
//   --compare <before dir>   pixel-diff the default shots and build the
//                            side-by-side images (before hover | after hover)
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
      name: "c673-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const shot = req.url?.match(
            /^\/__c673-shot\/(before|after)\/([\w.-]+\.png)$/,
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
          if (req.url === "/__c673-blank") {
            res.setHeader("Content-Type", "text/html");
            res.end("<!doctype html><html><body></body></html>");
            return;
          }
          if (!req.url?.startsWith("/__c673")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c673",
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
        url: `${base}__c673${dense ? "?dense" : ""}#/p/p-1/cards?view=board`,
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
          marker: !!line.getAttribute("marker-end"),
        };
        if (!dots) return result;
        const ds = getComputedStyle(dots);
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
        };
      });
      const theme = getComputedStyle(document.documentElement);
      const title = document.querySelector(".card-title");
      const tile = document.querySelector(".board-card");
      return {
        svg: true,
        lines,
        flowPaths: svg.querySelectorAll("[data-flow]").length,
        token: theme.getPropertyValue("--ui-border-hover").trim(),
        text: getComputedStyle(title).color,
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
   * Put a dot on a title line some line crosses (not one of its own ends),
   * then grab that line with the overlay shown and hidden: text ink (darker
   * than the dot in light, lighter in dark) must be identical.
   */
  const dotOnText = async (theme, tag, dotRgb) => {
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
                const dots = svg.querySelector(
                  `[data-flow="${line.dataset.edge}"]`,
                );
                const gap = Number(
                  dots.getAttribute("stroke-dasharray").split(" ")[1],
                );
                dots.setAttribute("stroke-dashoffset", String(gap - (s % gap)));
                return {
                  edge: line.dataset.edge,
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
    const withDot = await grab();
    await run(() => {
      document.querySelector("[data-board-dependencies]").style.visibility =
        "hidden";
    });
    await settle();
    const without = await grab();
    await run(() => {
      document.querySelector("[data-board-dependencies]").style.visibility = "";
    });
    await settle();
    await writeFile(
      resolve(output, `dot-on-text-${tag}.png`),
      Buffer.from(withDot, "base64"),
    );
    await writeFile(
      resolve(output, `dot-off-text-${tag}.png`),
      Buffer.from(without, "base64"),
    );
    return {
      ...spot,
      ...(await comparePixels(withDot, without, theme === "dark", dotRgb)),
    };
  };

  /** Freeze the dots half a gap from every line's start. */
  const freezeHalfGap = () =>
    run(() => {
      for (const p of document.querySelectorAll("[data-flow]")) {
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
      const dotRgb = channels(result.steps.hover.lines[0].dotStroke);
      if (width === 1440) {
        result.steps.dotOnText = await dotOnText(theme, tag, dotRgb);
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
      await send("Page.navigate", { url: `${base}__c673-blank` });
      await browser.until("document.readyState === 'complete'");
      await run(async (theme) => {
        document.body.innerHTML = `<div style="display:flex;gap:16px;background:#808080">${[
          0, 1, 2, 3,
        ]
          .map(
            (i) =>
              `<img src="/__c673-shot/after/frame-${i}-1440-${theme}.png">`,
          )
          .join("")}</div>`;
        document.body.style.margin = "0";
        await Promise.all([...document.images].map((i) => i.decode()));
      }, theme);
      await shot(`frames-1440-${theme}.png`);
    }
    for (const c of cases) {
      const label = `${c.width}/${c.theme}`;
      const { hover, moving, leave } = c.steps;
      assert(
        hover.lines.length >= (c.width === 1440 ? 4 : 2),
        `${label}: lines shown`,
      );
      assert.equal(hover.flowPaths, hover.lines.length, `${label}: dots`);
      assert.equal(hover.scrollWidth, hover.innerWidth, `${label}: overflow`);
      const line = channels(hover.lines[0].lineStroke);
      const text = channels(hover.text);
      for (const l of hover.lines) {
        assert(l.startsAtPrerequisite, `${label} ${l.key}: starts at from`);
        assert(l.endsAtDependent, `${label} ${l.key}: ends at to`);
        assert(l.marker && !l.dotMarker, `${label} ${l.key}: one arrow`);
        assert(l.sameD, `${label} ${l.key}: dots on the line`);
        assert(l.dots >= 1 && l.dots <= 3, `${label} ${l.key}: 1–3 dots`);
        assert.equal(l.dotCap, "round", `${label} ${l.key}: round dots`);
        assert.equal(l.dotWidth, "4px", `${label} ${l.key}: 4px dots`);
        // Between the line and the text, channel by channel.
        const dot = channels(l.dotStroke);
        for (const [k, v] of dot.entries())
          assert(
            (v - line[k]) * (text[k] - v) > 0,
            `${label} ${l.key}: dot ${l.dotStroke} between line and text`,
          );
        // Evenly spaced along the whole line.
        assert(
          Math.abs(l.gap * l.dots - l.length) < 2,
          `${label} ${l.key}: even gaps`,
        );
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
        const { dotOnText, focus, blur, reduced } = c.steps;
        assert(dotOnText, `${label}: a line crosses a title`);
        assert(dotOnText.changed > 0, `${label}: the dot paints`);
        assert(dotOnText.ink > 0, `${label}: the title has ink`);
        assert.equal(dotOnText.inkChanged, 0, `${label}: no ink changed`);
        assert(
          focus.lines >= 3 && focus.moved.every(Boolean),
          `${label}: focus`,
        );
        assert(!blur.svg && blur.rafPerSecond === 0, `${label}: blur stops`);
        assert(reduced.lines.length >= 3, `${label}: reduced lines`);
        assert.equal(reduced.flowPaths, 0, `${label}: reduced has no dots`);
        assert(
          reduced.lines.every((l) => l.marker),
          `${label}: reduced arrows`,
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
      await send("Page.navigate", { url: `${base}__c673-blank` });
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
          load(`/__c673-shot/before/default-${tag}.png`),
          load(`/__c673-shot/after/default-${tag}.png`),
          load(`/__c673-shot/before/hover-${tag}.png`),
          load(`/__c673-shot/after/hover-${tag}.png`),
        ]);
        document.body.innerHTML = `<div style="display:flex;gap:16px;background:#808080"><img src="/__c673-shot/before/hover-${tag}.png"><img src="/__c673-shot/after/hover-${tag}.png"></div>`;
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
  console.log(`C-673 capture ok: ${report.browser}, ${cases.length} cases`);
} finally {
  await browser?.close();
  await server.close();
}
