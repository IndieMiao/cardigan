// C-810: the decision card in Needs You, the card's “下一步” and the card
// timeline, for two synthetic decisions shaped like SEN-Q-299 and SEN-Q-303,
// at 1440×1000 and 390×1000 in light and dark, plus the card list page (the
// baseline page) at the same viewport and theme, and side-by-side images of
// the two. `before` renders apps/web/src from C810_BASELINE_REF with the same
// fixture. Synthetic data and images only; same browser flags as the
// page-skeleton check.
//
// Each shot records, for the decision: question, thumbnails, criteria, plain
// summary, options and 详细信息 (box, font, in the first screen or not),
// whether a stored option key is visible, control heights and horizontal
// overflow.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c810-capture.mjs <new dir> <before|after>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outArg = process.argv[2];
assert(outArg, "Pass a new output directory");
const output = resolve(outArg);
const phase = process.argv[3] === "before" ? "before" : "after";
const baseline =
  process.env.C810_BASELINE_REF ?? "8397c14a78994e0467223aae3f0024a53dbb1036";

/** A synthetic drawing standing in for a design image. */
function svg(id) {
  const hue = (Number(id.replace(/\D/g, "")) * 47) % 360;
  const cells = [];
  for (let x = 0; x < 5; x++)
    for (let y = 0; y < 5; y++)
      cells.push(
        `<rect x="${60 + x * 56}" y="${30 + y * 36}" width="52" height="32" fill="hsl(${hue} 45% ${70 - ((x + y) % 2) * 10}%)"/>`,
      );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260"><rect width="400" height="260" fill="hsl(${hue} 30% 92%)"/>${cells.join("")}<text x="200" y="245" font-family="sans-serif" font-size="16" text-anchor="middle" fill="#333">${id}</text></svg>`;
}

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c810-fixture",
      enforce: "pre",
      load(id) {
        const file = id.split("?")[0];
        if (phase !== "before" || !file.startsWith(`${root}src/`)) return;
        const relative = file.slice(root.length);
        if (!/\.(tsx?|css)$/.test(relative)) return;
        try {
          return execFileSync(
            "git",
            ["show", `${baseline}:apps/web/${relative}`],
            { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch {
          return;
        }
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const image = /^\/__c810img\/([\w-]+)\.svg/.exec(req.url ?? "");
          if (image) {
            res.setHeader("Content-Type", "image/svg+xml");
            res.end(svg(image[1]));
            return;
          }
          if (!req.url?.startsWith("/__c810")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c810",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c810-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});

const scenes = [
  { name: "needs-Q-299", hash: "needs-you", q: "Q-299", place: "needs" },
  { name: "needs-Q-303", hash: "needs-you", q: "Q-303", place: "needs" },
  { name: "card-C-187", hash: "cards/C-187", q: "Q-299", place: "card" },
  { name: "card-C-180", hash: "cards/C-180", q: "Q-303", place: "card" },
  {
    name: "timeline-C-187",
    hash: "cards/C-187",
    q: "Q-299",
    place: "timeline",
    entry: "entry-C-187#11",
  },
  {
    name: "timeline-C-180",
    hash: "cards/C-180",
    q: "Q-303",
    place: "timeline",
    entry: "entry-C-180#11",
  },
];
const keys = ["approve", "reject", "confirm_5x5", "revise"];

let browser;
const report = { phase, baseline: phase === "before" ? baseline : null };
report.shots = [];
try {
  await mkdir(output);
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
  report.browser = (await send("Browser.getVersion")).product;
  const run = (fn, ...a) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(a)})`);
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const settle = () =>
    run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  const shot = async (name) => {
    await delay(300);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    console.log(`Captured ${name}`);
  };
  const open = async (hash, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c810#/p/p-1/${hash}`,
    });
    await until(ready);
    await evaluate("document.fonts.ready.then(() => true)");
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  const region = {
    needs: (q) => `document.querySelector('article[aria-label="拍板 ${q}"]')`,
    card: () =>
      `document.querySelector("article.card-page section[aria-label='下一步']")`,
    timeline: (_q, entry) =>
      `document.getElementById(${JSON.stringify(entry)})`,
  };
  // `selector` is an expression built above; the page evaluates it.
  const measure = (selector) =>
    evaluate(
      `(${(
        (el, keys) => {
          const rect = (e) => {
            if (!e) return null;
            const r = e.getBoundingClientRect();
            return {
              x: Math.round(r.x),
              y: Math.round(r.y),
              width: Math.round(r.width),
              height: Math.round(r.height),
              firstScreen: r.top < innerHeight && r.bottom > 0,
              wholeInFirstScreen: r.top >= 0 && r.bottom <= innerHeight,
            };
          };
          const font = (e) => {
            if (!e) return null;
            const s = getComputedStyle(e);
            return `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`;
          };
          const visible = (e) => e.getClientRects().length > 0;
          const thumbs = [
            ...(el?.querySelectorAll(
              ".decision-attachments .attachment-preview",
            ) ?? []),
          ].filter(visible);
          const files = [
            ...(el?.querySelectorAll(".decision-attachment-file") ?? []),
          ].filter(visible);
          const criteriaTitle = [...(el?.querySelectorAll("h3") ?? [])].find(
            (h) => h.textContent === "验收标准",
          );
          const criteria = criteriaTitle?.parentElement;
          const items = [...(criteria?.querySelectorAll("li") ?? [])];
          const summary = el?.querySelector(".plain-summary");
          const options = [
            ...(el?.querySelectorAll(
              "label:has(input[type=radio]), ul[aria-label='选项'] > li",
            ) ?? []),
          ].filter(visible);
          const details = [...(el?.querySelectorAll("details") ?? [])].find(
            (d) =>
              d.querySelector(":scope > summary")?.textContent === "详细信息",
          );
          const summaryToggle = details?.querySelector(":scope > summary");
          const buttons = [
            ...(el?.querySelectorAll("button, a[data-ui=button]") ?? []),
          ]
            .filter(
              (b) => visible(b) && !b.classList.contains("attachment-preview"),
            )
            .map((b) => ({
              text: (b.getAttribute("aria-label") || b.textContent).trim(),
              height: Math.round(b.getBoundingClientRect().height),
            }));
          const text = el?.textContent ?? "";
          const reason = [...(el?.querySelectorAll("*") ?? [])].find(
            (e) =>
              e.children.length <= 1 &&
              e.textContent.startsWith("须由你亲自决定"),
          );
          return {
            viewport: { width: innerWidth, height: innerHeight },
            region: rect(el),
            question: (() => {
              const q =
                el?.querySelector("p[class*='question']") ??
                el?.querySelector("[data-needs-row-title], h3");
              return q && { text: q.textContent, ...rect(q), font: font(q) };
            })(),
            thumbnails: {
              count: thumbs.length,
              first: rect(thumbs[0]),
              inFirstScreen: thumbs.filter(
                (t) => t.getBoundingClientRect().bottom <= innerHeight,
              ).length,
            },
            files: files.map((f) => ({ text: f.textContent, ...rect(f) })),
            criteria: criteria && {
              ...rect(criteria),
              titleFont: font(criteriaTitle),
              itemFont: font(items[0]),
              items: items.length,
            },
            plainSummary: summary && { ...rect(summary), font: font(summary) },
            options: options.map((o) => ({
              text: o.textContent.trim().slice(0, 40),
              ...rect(o),
            })),
            details: summaryToggle && {
              open: details.open,
              ...rect(summaryToggle),
              font: font(summaryToggle),
            },
            humanReasonVisible: !!reason && visible(reason),
            humanReasonInDetails: !!reason?.closest("details"),
            storedKeysVisible: keys.filter((k) =>
              [...(el?.querySelectorAll("strong, span, label") ?? [])].some(
                (e) => visible(e) && e.textContent.trim() === k,
              ),
            ),
            englishKeyInText: keys.filter((k) => text.includes(k)),
            buttons,
            overflow: {
              page: document.documentElement.scrollWidth > innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
            },
          };
        }
      ).toString()})(${selector}, ${JSON.stringify(keys)})`,
    );
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
        "cards?view=list",
        "!!document.querySelector('.card-table, .card-records')",
        theme,
      );
      const list = await run(() => ({
        title: (() => {
          const h = document.querySelector("h1");
          const s = h && getComputedStyle(h);
          return s && `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`;
        })(),
        bodyFont: (() => {
          const s = getComputedStyle(document.body);
          return `${s.fontSize}/${s.lineHeight}`;
        })(),
        controlHeights: [
          ...new Set(
            [...document.querySelectorAll("[data-ui=button]")]
              .filter((b) => b.getClientRects().length)
              .map((b) => Math.round(b.getBoundingClientRect().height)),
          ),
        ],
        scrollWidth: document.documentElement.scrollWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      report.shots.push({ name: `list-${width}-${theme}.png`, list });
      await shot(`list-${width}-${theme}.png`);
      for (const scene of scenes) {
        const ready =
          scene.place === "needs"
            ? `!!${region.needs(scene.q)}`
            : "!!document.querySelector(\"article.card-page section[aria-label='下一步']\")";
        await open(scene.hash, ready, theme);
        if (scene.place === "needs") {
          // As the owner does: “处理” opens the row and focuses its options.
          await run((q) => {
            document
              .querySelector(
                `article[aria-label="拍板 ${q}"] [data-needs-row-action] button`,
              )
              ?.click();
          }, scene.q);
          await until(
            `${region.needs(scene.q)}.querySelector('[aria-expanded=true]') !== null`,
          );
          await settle();
          await run((q) => {
            document.activeElement?.blur();
            const row = document.querySelector(
              `article[aria-label="拍板 ${q}"]`,
            );
            window.scrollTo(0, 0);
            const top = row.getBoundingClientRect().top;
            // Keep the page header above the first row; later rows start at the top.
            if (top > innerHeight / 3) window.scrollTo(0, top - 8);
          }, scene.q);
        }
        if (scene.place === "timeline") {
          await run(() => {
            [...document.querySelectorAll("[role=tab]")]
              .find((tab) => tab.textContent.startsWith("时间线"))
              ?.click();
          });
          await until(`!!${region.timeline(scene.q, scene.entry)}`);
          await settle();
          await run((entry) => {
            document.getElementById(entry)?.scrollIntoView({ block: "start" });
          }, scene.entry);
        }
        await settle();
        const name = `${scene.name}-${width}-${theme}.png`;
        report.shots.push({
          name,
          ...(await measure(region[scene.place](scene.q, scene.entry))),
        });
        await shot(name);
      }
    }
  // Side by side: the card list page and each decision place, same width and
  // theme, composed in the same browser from the saved screenshots.
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const list = await readFile(
        resolve(output, `list-${width}-${theme}.png`),
      );
      for (const scene of scenes) {
        const other = await readFile(
          resolve(output, `${scene.name}-${width}-${theme}.png`),
        );
        await send("Emulation.setDeviceMetricsOverride", {
          width: width * 2 + 16,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Page.navigate", { url: "about:blank" });
        await until("location.href === 'about:blank'");
        await run(
          (a, b) =>
            new Promise((done) => {
              document.body.style.cssText =
                "margin:0;display:flex;gap:16px;background:#888";
              let n = 0;
              for (const src of [a, b]) {
                const img = new Image();
                img.onload = () => ++n === 2 && done();
                img.src = src;
                img.style.display = "block";
                document.body.append(img);
              }
            }),
          `data:image/png;base64,${list.toString("base64")}`,
          `data:image/png;base64,${other.toString("base64")}`,
        );
        await shot(`side-${scene.name}-${width}-${theme}.png`);
      }
    }
} finally {
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  ).catch(() => {});
  await browser?.close();
  await server.close();
}
