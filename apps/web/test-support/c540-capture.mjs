import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-540 evidence: the card page attachment grid and timeline attachments with
// synthetic screenshots (stitched 1440, long 390, normal, undecodable, text),
// plus the card list (reference page) at the same width and theme. The same
// script runs on the baseline (originals as thumbnails) and on the delivery
// (server-rendered thumbnails from apps/server/dist, built by `tsc -b`).
// Synthetic data only; no backend, database or production records.
const output = resolve(process.argv[2]);
await mkdir(output); // Never replace existing evidence.
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
const dirty = git("status", "--porcelain");
const here = fileURLToPath(new URL("./", import.meta.url));
const sharp = createRequire(resolve(here, "../../server/package.json"))(
  "sharp",
);
const thumbnails = resolve(here, "../../server/dist/web/thumbnails.js");
const { renderThumbnail } = existsSync(thumbnails)
  ? await import(pathToFileURL(thumbnails).href)
  : {};

// Deterministic text-dense "screenshots" so PNG sizes resemble real captures.
let seed = 540;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const words =
  "卡片 附件 审核 交付 合并 预检 截图 测量 状态 负责人 时间线 拍板 Workbench C-501 W-1796 passed 1440 390".split(
    " ",
  );
function screenshot(width, height, theme) {
  const dark = theme === "dark",
    bg = dark ? "#181818" : "#ffffff",
    fg = dark ? "#dddddd" : "#262626",
    muted = dark ? "#8a8a8a" : "#6b6b6b",
    line = dark ? "#333333" : "#e5e5e5";
  const parts = [`<rect width="${width}" height="${height}" fill="${bg}"/>`];
  const screen = 1000,
    nav = width > 760 ? 220 : 0;
  for (let top = 0; top < height; top += screen) {
    parts.push(
      `<rect y="${top}" width="${width}" height="6" fill="${dark ? "#f6f6f6" : "#262626"}"/>`,
    );
    if (nav)
      parts.push(
        `<rect y="${top + 6}" width="${nav}" height="${screen - 6}" fill="${dark ? "#222222" : "#f5f5f5"}"/>`,
      );
    for (let y = top + 40; y < Math.min(top + screen, height) - 10; y += 23) {
      let x = nav + 16;
      while (x < width - 80) {
        const text = Array.from(
          { length: 1 + Math.floor(random() * 4) },
          () => words[Math.floor(random() * words.length)],
        ).join(" ");
        const color = random() < 0.3 ? muted : fg;
        // Real pages are mostly whitespace between short runs of text.
        if (random() < 0.6) {
          x += text.length * 9 + 24;
          continue;
        }
        parts.push(
          `<text x="${x}" y="${y}" font-size="13" font-family="sans-serif" fill="${color}">${text}</text>`,
        );
        x += text.length * 9 + 24;
      }
      if (random() < 0.15)
        parts.push(
          `<rect x="${nav + 12}" y="${y + 6}" width="${width - nav - 24}" height="1" fill="${line}"/>`,
        );
    }
  }
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`,
    ),
    { limitInputPixels: false },
  )
    .png()
    .toBuffer();
}
const originals = {
  "F-1": await screenshot(1440, 5400, "dark"),
  "F-2": await screenshot(1440, 5400, "light"),
  "F-3": await screenshot(390, 9000, "dark"),
  "F-4": await screenshot(390, 9000, "light"),
  "F-5": await screenshot(1440, 900, "light"),
};
originals["F-6"] = originals["F-5"].subarray(0, 300);
const rendered = {};
const sizes = Object.fromEntries(
  Object.entries(originals).map(([id, bytes]) => [id, bytes.byteLength]),
);

const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "c540-fixture",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          const file =
            /^\/api\/projects\/p-1\/attachments\/(F-\d)(\/thumbnail)?$/.exec(
              req.url ?? "",
            );
          if (file) {
            const [, id, thumbnail] = file;
            let bytes = originals[id],
              type = "image/png";
            if (thumbnail) {
              try {
                rendered[id] ??= await renderThumbnail(bytes);
                bytes = rendered[id];
                type = "image/webp";
              } catch {
                res.statusCode = 422;
                res.setHeader("Content-Type", "application/json");
                res.end('{"error":{"code":"thumbnail_unavailable"}}');
                return;
              }
            }
            res.setHeader("Content-Type", type);
            res.setHeader("Cache-Control", "no-store");
            res.end(bytes);
            return;
          }
          if (!req.url?.startsWith("/__c540")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__c540",
              '<!doctype html><html lang="zh-CN"><head><title>附件缩略图</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c540-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const measure = `(() => {
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: px(r.x), y: px(r.y), width: px(r.width), height: px(r.height) }; };
  const previews = Array.from(document.querySelectorAll('.attachment-preview')).filter((b) => !b.closest('[hidden]')).map((button) => {
    const img = button.querySelector('img'), icon = button.querySelector('svg');
    let painted = null;
    if (img && img.naturalWidth) {
      const r = img.getBoundingClientRect(), scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
      painted = { width: px(img.naturalWidth * scale), height: px(img.naturalHeight * scale) };
    }
    const s = getComputedStyle(button);
    return { label: button.getAttribute('aria-label'), where: button.closest('.attachment-grid') ? 'grid' : button.closest('.system-line') ? 'system-line' : button.closest('.attachments') ? 'timeline' : 'other', button: box(button), background: s.backgroundColor, color: s.color, img: img ? { src: img.getAttribute('src'), natural: [img.naturalWidth, img.naturalHeight], complete: img.complete, box: box(img), painted } : null, placeholder: icon ? { className: icon.getAttribute('class'), ...box(icon), ariaHidden: icon.getAttribute('aria-hidden') } : null };
  });
  const items = Array.from(document.querySelectorAll('.attachment-grid > li')).filter((li) => !li.closest('[hidden]')).slice(0, 2).map((li) => { const s = getComputedStyle(li); return { fontSize: s.fontSize, lineHeight: s.lineHeight, padding: s.padding, gap: s.gap, borderRadius: s.borderRadius, ...box(li) }; });
  const resources = performance.getEntriesByType('resource').filter((e) => e.name.includes('/attachments/')).map((e) => ({ path: new URL(e.name).pathname, encodedBodySize: e.encodedBodySize, transferSize: e.transferSize, status: e.responseStatus }));
  return { viewport: { width: innerWidth, height: innerHeight }, document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }, previews, items, resources };
})()`;
const records = [];
let browser;
try {
  await server.listen();
  // Same software raster path as the page-skeleton baselines.
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
  // Vite serves hundreds of modules; keep every attachment request measurable.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: "performance.setResourceTimingBufferSize(100000)",
  });
  const version = (await send("Browser.getVersion")).product;
  const until = async (expression) => {
    const end = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(40);
    }
  };
  const shoot = async (name, clip) => {
    await delay(150);
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      ...(clip
        ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true }
        : {}),
    });
    const file = resolve(output, `${name}.png`);
    await writeFile(file, Buffer.from(data, "base64"), { flag: "wx" });
    return file;
  };
  // Thumbnails are lazy: bring each visible one into view until it settles.
  const loaded = `(async () => {
    for (const i of document.querySelectorAll('.attachment-preview img')) {
      if (i.closest('[hidden]')) continue;
      i.scrollIntoView({ block: 'center' });
      for (let t = 0; t < 400 && !i.complete; t++) await new Promise((r) => setTimeout(r, 25));
      if (!i.complete) return false;
    }
    return true;
  })()`;
  const base = server.resolvedUrls.local[0],
    query = `sizes=${encodeURIComponent(JSON.stringify(sizes))}`;
  for (const width of [1440, 390]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await send("Page.navigate", {
        url: `${base}__c540?${query}&case=list-${theme}-${width}#/p/p-1/cards?view=list`,
      });
      await until(
        "document.readyState === 'complete' && !!document.querySelector('table')",
      );
      await evaluate("document.fonts.ready");
      const reference = await shoot(`reference-list-${width}-${theme}`);
      const name = `attachments-${width}-${theme}`;
      await send("Page.navigate", {
        url: `${base}__c540?${query}&case=${name}#/p/p-1/cards/C-1`,
      });
      await until("!!document.getElementById('card-C-1-attachments-tab')");
      await evaluate("document.fonts.ready");
      await evaluate(
        "document.getElementById('card-C-1-attachments-tab').click()",
      );
      await until(
        "!!document.querySelector('.attachment-grid') && !document.querySelector('.attachment-grid').closest('[hidden]')",
      );
      await until(loaded);
      await evaluate(
        "document.querySelector('.attachment-grid').scrollIntoView({block:'start'})",
      );
      const grid = await evaluate(measure);
      const shot = await shoot(name);
      // At the top the sticky tab bar sits above the grid instead of over it.
      await evaluate("scrollTo(0, 0)");
      const full = await evaluate(
        "(() => { const r = document.querySelector('.attachment-grid').getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top + scrollY - 12), width: innerWidth, height: Math.ceil(r.height + 24) }; })()",
      );
      await shoot(`${name}-full`, full);
      // Side by side with the reference page at the same width and theme.
      const [left, right] = await Promise.all(
        [reference, shot].map((f) => sharp(f).metadata()),
      );
      await sharp({
        create: {
          width: left.width + right.width + 16,
          height: Math.max(left.height, right.height),
          channels: 3,
          background: "#808080",
        },
      })
        .composite([
          { input: reference, left: 0, top: 0 },
          { input: shot, left: left.width + 16, top: 0 },
        ])
        .png()
        .toFile(resolve(output, `side-by-side-${width}-${theme}.png`));
      await evaluate(
        "document.getElementById('card-C-1-timeline-tab').click()",
      );
      await until(
        "!!document.getElementById('entry-C-1#2') && !document.getElementById('entry-C-1#2').closest('[hidden]')",
      );
      await until(loaded);
      await evaluate(
        "document.getElementById('entry-C-1#2').scrollIntoView({block:'start'})",
      );
      const timeline = await evaluate(measure);
      await shoot(`timeline-${width}-${theme}`);
      let lightbox = null;
      if (width === 1440 && theme === "light") {
        await evaluate(
          "document.querySelector('#entry-C-1\\\\#2 .attachment-preview[aria-label=\"预览 C-501-390-dark.png\"]').click()",
        );
        await until(
          "!!document.querySelector('.lightbox-image') && document.querySelector('.lightbox-image').complete",
        );
        lightbox = await evaluate(
          "(() => { const i = document.querySelector('.lightbox-image'); return { src: i.getAttribute('src'), natural: [i.naturalWidth, i.naturalHeight] }; })()",
        );
        await shoot("lightbox-1440-light");
      }
      records.push({ name, grid, timeline, lightbox });
    }
  }
  assert.equal(browser.errors.length, 0, "browser exceptions");
  const transfer = Object.fromEntries(
    Object.entries(originals).map(([id, bytes]) => [
      id,
      {
        original: bytes.byteLength,
        thumbnail: rendered[id]?.byteLength ?? null,
      },
    ]),
  );
  await writeFile(
    resolve(output, "measurements.json"),
    JSON.stringify(
      {
        sha,
        tree,
        dirty,
        browser: version,
        dpr: 1,
        viewport: "1440×1000 / 390×1000",
        fonts:
          "@fontsource-variable/inter, noto-sans-sc, jetbrains-mono (lockfile); synthetic image text rasterized by librsvg sans-serif",
        fixture:
          "apps/web/test-support/c540-fixture.tsx: one synthetic card, 7 attachments (1440×5400 dark/light, 390×9000 dark/light, 1440×900, truncated PNG, Markdown); no production data or backend",
        transfer,
        records,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(`${records.length} C-540 cases captured: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
