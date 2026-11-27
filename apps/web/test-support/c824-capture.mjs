// C-824: the header capacity popover as a compact table, on synthetic data
// with the owner's counts (c824-fixture.tsx: 3 Agent machines with resource
// slots, 2 CI targets, 7 cards). No server or database.
//
// Runs twice with the page-skeleton browser flags: `before` loads the
// baseline commit's src/ (C824_BASELINE_REF, default below), `after` the
// working tree. 1440×1000 and 390×1000 × light/dark on the cards list:
// - cards-<stage>-*: the cards page with the popover closed (diffed by pixel);
// - popover-<stage>-*: the popover opened by keyboard focus;
// - compare-*: before | after side by side (same width and theme);
// - after only: hover-1440-light (opened by the mouse) and help-*: the
//   page the 口径说明 link opens.
// c824-measurements.json: popover box, scroll sizes, type, row heights,
// colours and contrast; the after stage asserts no scrolling inside the
// popover on desktop, nothing outside the viewport and no page overflow.
//
// CHROMIUM_PATH=<chrome> FONTCONFIG_FILE=apps/web/test-support/page-skeleton-fonts.conf \
//   node apps/web/test-support/c824-capture.mjs <new dir>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outArg = process.argv[2];
assert(outArg, "Pass a new output directory");
const output = resolve(outArg);
const baseline =
  process.env.C824_BASELINE_REF ?? "fc185cce92a6b24a8fc99880c8a4d15f2dc1582b";
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const src = resolve(root, "src");
const fromBaseline = (path) => {
  try {
    return execFileSync("git", ["show", `${baseline}:apps/web/${path}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
};
await mkdir(output);
const report = {
  baseline,
  subject: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
  dirty: git("status", "--porcelain") !== "",
  data: "synthetic: 3 Agent machines (10 resource slots), 2 CI targets, 7 cards",
  stages: [],
};
const shots = {};

const contrast = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1, 1);
  const chain = [];
  for (let n = el; n; n = n.parentElement) chain.unshift(n);
  for (const n of chain) {
    ctx.fillStyle = getComputedStyle(n).backgroundColor; ctx.fillRect(0, 0, 1, 1);
  }
  const bg = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
  ctx.fillStyle = getComputedStyle(el).color; ctx.fillRect(0, 0, 1, 1);
  const fg = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
  const lum = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  return { fg, bg, ratio: Math.round((Math.max(lum(fg), lum(bg)) + .05) / (Math.min(lum(fg), lum(bg)) + .05) * 100) / 100 };
})()`;

for (const stage of ["before", "after"]) {
  const server = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    css: { devSourcemap: false },
    plugins: [
      {
        name: "c824-fixture",
        enforce: "pre",
        load(id) {
          if (stage !== "before") return;
          const file = id.split("?")[0];
          if (!file.startsWith(`${src}/`)) return;
          const source = fromBaseline(file.slice(root.length));
          // CSS @import is read from disk, not through this hook: inline the
          // baseline legacy sheets, in order, after the remaining imports
          // (none of them has @import or url()).
          if (source && file === resolve(src, "components/ui/theme.css")) {
            const sheets = [
              ["../../styles.css", "src/styles.css"],
              ["../TemplateMarker.css", "src/components/TemplateMarker.css"],
              ["../CardLegend.css", "src/components/CardLegend.css"],
            ];
            let css = source;
            const legacy = sheets.map(([from, path]) => {
              const line = `@import "${from}" layer(legacy);\n`;
              const text = fromBaseline(path);
              assert(text && css.includes(line), `baseline ${path}`);
              assert(!/@import|url\(/.test(text), `${path} imports`);
              css = css.replace(line, "");
              return text;
            });
            const last = css.lastIndexOf("@import");
            const end = css.indexOf("\n", last) + 1;
            return `${css.slice(0, end)}@layer legacy {\n${legacy.join("\n")}\n}\n${css.slice(end)}`;
          }
          return source;
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/__c824")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                "/__c824",
                `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c824-fixture.tsx"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
  });
  let browser;
  try {
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
    const base = server.resolvedUrls.local[0];
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
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
      await delay(250);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(resolve(output, name), Buffer.from(data, "base64"));
      shots[name] = data;
      console.log(`Captured ${name}`);
      return data;
    };
    const open = async (path, ready) => {
      await send("Page.navigate", { url: "about:blank" });
      await until("location.href === 'about:blank'");
      await send("Page.navigate", { url: `${base}__c824#/p/p-1/${path}` });
      await until(ready);
      await evaluate("document.fonts.ready.then(() => true)");
    };
    const measure = () =>
      run(() => {
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return {
            x: Math.round(r.x * 100) / 100,
            y: Math.round(r.y * 100) / 100,
            width: Math.round(r.width * 100) / 100,
            height: Math.round(r.height * 100) / 100,
            font: s.fontSize,
            line: s.lineHeight,
            weight: s.fontWeight,
            color: s.color,
            padding: s.padding,
          };
        };
        const panel = document.querySelector(".capacity-tooltip");
        const rows = panel ? [...panel.querySelectorAll("tbody tr")] : [];
        return {
          viewport: { width: innerWidth, height: innerHeight },
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          title: box(document.querySelector(".page-title h1")),
          status: box(document.querySelector(".capacity-status")),
          panel: panel && {
            ...box(panel),
            scrollHeight: panel.scrollHeight,
            clientHeight: panel.clientHeight,
            scrollWidth: panel.scrollWidth,
            clientWidth: panel.clientWidth,
            insideViewport: (() => {
              const r = panel.getBoundingClientRect();
              return (
                r.left >= 0 &&
                r.top >= 0 &&
                r.right <= innerWidth &&
                r.bottom <= innerHeight
              );
            })(),
            paragraphs: [...panel.querySelectorAll("p")].map(
              (p) => p.textContent,
            ),
            text: panel.textContent,
          },
          heading: box(panel?.querySelector("p")),
          headerCells: [...(panel?.querySelectorAll("th") ?? [])].map((th) => ({
            text: th.textContent,
            ...box(th),
          })),
          rows: rows.map((tr) => ({
            attention: tr.getAttribute("data-attention"),
            height: Math.round(tr.getBoundingClientRect().height * 100) / 100,
            cells: [...tr.children].map((td) => ({
              text: td.textContent,
              tone: td.getAttribute("data-tone"),
              ...box(td),
            })),
          })),
          tags: [...(panel?.querySelectorAll("[data-ui=badge]") ?? [])].map(
            (tag) => ({
              text: tag.textContent,
              state: tag.getAttribute("data-state"),
              ...box(tag),
            }),
          ),
          links: [...(panel?.querySelectorAll("a") ?? [])].map((a) => ({
            text: a.textContent,
            href: a.getAttribute("href"),
            ...box(a),
          })),
        };
      });
    const result = { stage, cases: [] };
    report.stages.push(result);
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        const suffix = `${width}-${theme}`;
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
        const ready =
          "!!document.querySelector('.card-table') && /Agent|A /.test(document.querySelector('.capacity-status')?.textContent ?? '')";
        await open("cards?view=list", ready);
        await settle();
        await shot(`cards-${stage}-${suffix}.png`);
        await run(() => document.querySelector(".capacity-status").focus());
        await until("!!document.querySelector('.capacity-tooltip')");
        await settle();
        const metrics = await measure();
        await shot(`popover-${stage}-${suffix}.png`);
        const contrasts = {};
        if (stage === "after")
          for (const [name, selector] of Object.entries({
            mutedCell: ".capacity-tooltip tbody tr:not([data-attention]) td",
            attentionCell:
              ".capacity-tooltip tbody tr[data-attention] td:not([data-tone])",
            waitCell: ".capacity-tooltip td[data-tone=wait]",
            tagFull: ".capacity-tooltip [data-state=full]",
            tagUsed: ".capacity-tooltip [data-state=used]",
            tagIdle: ".capacity-tooltip [data-state=idle]",
            header: ".capacity-tooltip th",
            link: ".capacity-tooltip a",
          }))
            contrasts[name] = await evaluate(contrast(selector));
        else contrasts.text = await evaluate(contrast(".capacity-tooltip"));
        result.cases.push({ width, theme, ...metrics, contrasts });
        assert(!metrics.pageOverflow, `${stage} ${suffix}: page overflow`);
        if (stage === "after") {
          const p = metrics.panel;
          assert(p.insideViewport, `${suffix}: popover leaves the viewport`);
          assert(p.scrollWidth <= p.clientWidth, `${suffix}: sideways scroll`);
          if (width === 1440)
            assert(p.scrollHeight <= p.clientHeight, `${suffix}: scrolls`);
          assert(!/常驻 PM|尚未确认结束/.test(p.text), "long explanations");
          assert.equal(metrics.headerCells.length, 4, "one header row");
          for (const value of Object.values(contrasts))
            assert(value.ratio >= 4.5, `${suffix}: contrast ${value.ratio}`);
        }
        await run(() => document.activeElement?.blur());
      }
    if (stage === "after") {
      // Mouse: hover opens; move into the popover and follow 口径说明.
      await send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: "light" },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      await open(
        "cards?view=list",
        "!!document.querySelector('.card-table') && /Agent/.test(document.querySelector('.capacity-status')?.textContent ?? '')",
      );
      const center = (selector) =>
        run((selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, selector);
      const move = async ({ x, y }) =>
        send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await move(await center(".capacity-status"));
      await until("!!document.querySelector('.capacity-tooltip')");
      await settle();
      await shot("hover-1440-light.png");
      const link = await center(".capacity-tooltip a");
      await move(link);
      await delay(300);
      assert(
        await evaluate("!!document.querySelector('.capacity-tooltip')"),
        "popover stays open while the pointer is inside",
      );
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          ...link,
          button: "left",
          clickCount: 1,
        });
      await until("location.hash.includes('help?doc=07-capacity')");
      await until("!document.querySelector('.capacity-tooltip')");
      await until("!!document.querySelector('.help-article h2')");
      result.hoverFollowsLink = await evaluate("location.hash");
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
            "help?doc=07-capacity",
            "!!document.querySelector('.help-article h2')",
          );
          await settle();
          assert(
            !(await evaluate(
              "document.documentElement.scrollWidth > innerWidth",
            )),
            "help page overflow",
          );
          await shot(`help-${width}-${theme}.png`);
        }
    }
    assert.deepEqual(browser.errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

// Pixel diff (closed popover) and before | after images, drawn in Chromium.
const browser = await chromium();
try {
  const { evaluate } = browser;
  const call = (fn, ...a) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(a)})`);
  report.diffs = {};
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const suffix = `${width}-${theme}`;
      const out = await call(
        async (a, b, c, d) => {
          const load = (src) =>
            new Promise((resolve, reject) => {
              const image = new Image();
              image.onload = () => resolve(image);
              image.onerror = reject;
              image.src = `data:image/png;base64,${src}`;
            });
          const pixels = (image) => {
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, image.width, image.height).data;
          };
          const [ca, cb, pa, pb] = await Promise.all([a, b, c, d].map(load));
          const x = pixels(ca),
            y = pixels(cb);
          let diff = 0;
          for (let i = 0; i < x.length; i += 4)
            if (
              x[i] !== y[i] ||
              x[i + 1] !== y[i + 1] ||
              x[i + 2] !== y[i + 2] ||
              x[i + 3] !== y[i + 3]
            )
              diff++;
          const canvas = document.createElement("canvas");
          canvas.width = pa.width * 2 + 16;
          canvas.height = Math.max(pa.height, pb.height);
          const context = canvas.getContext("2d");
          context.fillStyle = "#808080";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(pa, 0, 0);
          context.drawImage(pb, pa.width + 16, 0);
          return {
            diff,
            sameSize: ca.width === cb.width && ca.height === cb.height,
            image: canvas.toDataURL("image/png").slice(22),
          };
        },
        shots[`cards-before-${suffix}.png`],
        shots[`cards-after-${suffix}.png`],
        shots[`popover-before-${suffix}.png`],
        shots[`popover-after-${suffix}.png`],
      );
      report.diffs[suffix] = { closedPopoverDiffPixels: out.diff };
      await writeFile(
        resolve(output, `compare-${suffix}.png`),
        Buffer.from(out.image, "base64"),
      );
      console.log(`Captured compare-${suffix}.png (closed diff ${out.diff})`);
    }
} finally {
  await browser.close();
}
await writeFile(
  resolve(output, "c824-measurements.json"),
  JSON.stringify(report, null, 2),
);
console.log("Wrote c824-measurements.json");
