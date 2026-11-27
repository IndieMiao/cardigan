// C-820 evidence: the card attachments tab, the timeline attachments and an
// open decision's attachments, plus the card list (the reference page) at the
// same width and theme. Synthetic fixture only (c820-fixture.tsx); no backend,
// database or production records.
// Usage: CHROMIUM_PATH=... node test-support/c820-capture.mjs <output-dir> [before-dir]
// With a before-dir (the same script run on the baseline) it also writes
// before|after side-by-side images and per-image pixel differences.
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
const output = resolve(process.argv[2] ?? "c820-evidence");
const before = process.argv[3] ? resolve(process.argv[3]) : undefined;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sharp = createRequire(resolve(root, "../server/package.json"))("sharp");

// Deterministic screenshot-like images (wide, tall, square), light and dark.
const shapes = {
  "F-1": [1440, 900, "dark"],
  "F-2": [1440, 900, "light"],
  "F-3": [390, 844, "dark"],
  "F-4": [390, 844, "light"],
  "F-5": [1200, 1200, "dark"],
  "F-6": [1440, 3200, "light"],
};
const images = {};
for (const [id, [width, height, theme]] of Object.entries(shapes)) {
  const dark = theme === "dark";
  const rows = Array.from({ length: Math.floor(height / 60) }, (_, i) => {
    const y = 40 + i * 60,
      w = ((i * 37) % 50) + 30;
    return `<rect x="${width * 0.08}" y="${y}" width="${(width * w) / 100}" height="18" rx="4" fill="${dark ? "#3a3a3a" : "#d6d6d6"}"/>`;
  }).join("");
  images[id] = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${dark ? "#1b1f24" : "#f4f6f8"}"/><rect width="${width}" height="${Math.round(height * 0.06)}" fill="${dark ? "#2d6cdf" : "#4f86f7"}"/>${rows}<circle cx="${width * 0.7}" cy="${height * 0.55}" r="${Math.min(width, height) * 0.18}" fill="${dark ? "#c0843d" : "#e8a85a"}"/></svg>`,
    ),
  )
    .resize({ width: 320, height: 320, fit: "inside" })
    .png()
    .toBuffer();
}

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c820-fixture",
      enforce: "pre",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          const file =
            /^\/api\/projects\/p-1\/attachments\/(F-\d)(?:\/thumbnail)?(?:\?.*)?$/.exec(
              req.url ?? "",
            );
          if (file) {
            const bytes = images[file[1]];
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
          if (!req.url?.startsWith("/__c820")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__c820",
              '<!doctype html><html lang="zh-CN"><head><title>附件展示</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c820-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const results = [];
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
      document.activeElement?.blur();
      // Lazy images below the fold never load; wait for the rest, at most 5 s.
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
  const open = async (width, theme, hash) => {
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
      url: `${server.resolvedUrls.local[0]}__c820${hash}`,
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
  const measure = () =>
    run(() => {
      const px = (v) => Math.round(Number.parseFloat(v) * 100) / 100;
      const box = (e) => {
        const r = e.getBoundingClientRect();
        return {
          x: px(r.x),
          y: px(r.y),
          w: px(r.width),
          h: px(r.height),
        };
      };
      const text = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e);
        return {
          font: s.fontSize,
          line: s.lineHeight,
          weight: s.fontWeight,
          box: box(e),
          scrollWidth: e.scrollWidth,
          clientWidth: e.clientWidth,
        };
      };
      const visible = (e) => !e.closest("[hidden]");
      const tiles = [
        ...document.querySelectorAll(
          "[data-ui=attachment-tile], .attachment-grid > li, .attachments > li, .decision-attachments > li",
        ),
      ].filter(visible);
      const where = (e) =>
        e.closest("[aria-label='拍板附件']")
          ? "decision"
          : e.closest("[data-card-panel]")?.id.endsWith("attachments")
            ? "attachments-tab"
            : "timeline";
      const list = tiles.map((li) => {
        const s = getComputedStyle(li);
        const r = li.getBoundingClientRect();
        const download = li.querySelector(
          "a[download], a[href*='/attachments/']",
        );
        return {
          where: where(li),
          id: li.id || li.dataset.attachmentId || null,
          box: box(li),
          inViewport: r.top >= 0 && r.bottom <= innerHeight,
          padding: s.padding,
          radius: s.borderRadius,
          border: `${s.borderTopWidth} ${s.borderTopStyle}`,
          name: text(
            li.querySelector(
              "[data-attachment-name], .attachment-caption strong",
            ),
          ),
          note: text(
            li.querySelector(
              "[data-attachment-note], .attachment-caption span",
            ),
          ),
          meta: text(li.querySelector("[data-attachment-meta]")),
          media: text(
            li.querySelector(
              "[data-attachment-media], .attachment-preview, .attachment-file",
            ),
          ),
          download: download && {
            label: download.getAttribute("aria-label") ?? download.textContent,
            box: box(download),
          },
        };
      });
      const grid = document.querySelector("[data-card-panel]:not([hidden]) ul");
      return {
        innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        grid: grid && {
          columns: getComputedStyle(grid).gridTemplateColumns,
          gap: getComputedStyle(grid).gap,
          box: box(grid),
        },
        tilesInViewport: list.filter(
          (t) => t.where === "attachments-tab" && t.inViewport,
        ).length,
        tiles: list,
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
    await delay(200);
    const metrics = await measure();
    assert(!metrics.overflow, `${name}: page overflows`);
    await shot(name);
    results.push({ name, ...metrics });
    console.log(`Captured ${name}`);
    return metrics;
  };

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const suffix = `${width}-${theme}.png`;
      await open(width, theme, "#/p/p-1/cards?view=list");
      await until("!!document.querySelector('.card-table')");
      await record(`list-${suffix}`);
      await open(width, theme, "#/p/p-1/cards/C-1");
      await until("!!document.querySelector('[role=tab]')");
      await tab("附件");
      await until(
        "!!document.querySelector('[data-card-panel][id$=attachments]:not([hidden]) li')",
      );
      // The page as it opens: the grid below the header and the tabs.
      await run(() => window.scrollTo(0, 0));
      await record(`attachments-${suffix}`);
      await tab("时间线");
      await until(
        "!!document.querySelector('[data-card-panel][id$=timeline]:not([hidden]) [aria-label=拍板附件]')",
      );
      await run(() =>
        document
          .querySelector(
            "[data-card-panel][id$=timeline]:not([hidden]) [aria-label=拍板附件]",
          )
          .closest("li")
          .scrollIntoView({ block: "start" }),
      );
      await record(`timeline-${suffix}`);
    }
  // V-3568: the facts line (avatar, time, size) must never be cut without
  // an ellipsis. Sweep the widths between phone and desktop on both tabs.
  const sweep = [];
  const clipped = () =>
    run(() =>
      [...document.querySelectorAll("[data-attachment-meta]")]
        .filter((e) => !e.closest("[hidden]"))
        .map((e) => {
          const facts = e.lastElementChild;
          return {
            meta: [e.scrollWidth, e.clientWidth],
            facts: facts && [facts.scrollWidth, facts.clientWidth],
            tile: Math.round(
              e.closest("[data-ui=attachment-tile]").getBoundingClientRect()
                .width,
            ),
          };
        }),
    );
  for (const width of [
    390, 414, 420, 430, 480, 520, 560, 600, 640, 680, 700, 720, 740, 760, 761,
    800, 1024, 1440,
  ]) {
    await open(width, "light", "#/p/p-1/cards/C-1");
    await until("!!document.querySelector('[role=tab]')");
    for (const [label, name] of [
      ["附件", "attachments"],
      ["时间线", "timeline"],
    ]) {
      await tab(label);
      await until(
        `!!document.querySelector('[data-card-panel][id$=${name}]:not([hidden]) [data-attachment-meta]')`,
      );
      await settle();
      const rows = await clipped();
      const cut = rows.filter((r) => r.meta[0] > r.meta[1]);
      const ellipsis = rows.filter((r) => r.facts && r.facts[0] > r.facts[1]);
      sweep.push({
        width,
        tab: name,
        tiles: rows.length,
        narrowestTile: Math.min(...rows.map((r) => r.tile)),
        metaClipped: cut.length,
        factsEllipsized: ellipsis.length,
      });
      assert.equal(cut.length, 0, `${name} ${width}: facts line clipped`);
      if (
        (width === 760 && name === "attachments") ||
        (width === 430 && name === "timeline")
      ) {
        if (name === "timeline")
          await run(() =>
            document
              .querySelector(
                "[data-card-panel][id$=timeline]:not([hidden]) [aria-label=拍板附件]",
              )
              .closest("li")
              .scrollIntoView({ block: "start" }),
          );
        else await run(() => window.scrollTo(0, 0));
        await settle();
        await shot(`sweep-${name}-${width}-light.png`);
      }
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
          await pair(shots[`list-${suffix}`], shots[`attachments-${suffix}`]),
          "base64",
        ),
      );
    }
  const diffs = {};
  if (before) {
    for (const name of Object.keys(shots)) {
      if (name.startsWith("sweep-")) continue;
      const old = (await readFile(resolve(before, name))).toString("base64");
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
        data: "c820-fixture.tsx: 1 card, 8 attachments (6 PNG, 1 patch, 1 text), 2 comments, 1 open decision naming 3 attachments",
        cases: results,
        sweep,
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
