// C-504 evidence: the execution list's context meter before/after, the card
// mode unchanged, and the card page list at the same width and theme.
// Synthetic fixtures only (C-314 execution data, page-skeleton cards).
// Usage: CHROMIUM_PATH=... C504_BASELINE_REF=<sha> \
//   node test-support/c504-capture.mjs <output-dir>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = resolve(process.argv[2] ?? "c504-evidence");
const baselineRef = process.env.C504_BASELINE_REF;
assert(baselineRef, "Set C504_BASELINE_REF to the clean baseline commit");
await mkdir(output, { recursive: true });
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = resolve(webRoot, "../..");
const baselineFiles = new Map(
  [
    "apps/web/src/components/ExecutionContent.tsx",
    "apps/web/src/components/ui/theme.css",
  ].map((path) => [
    resolve(repoRoot, path),
    execFileSync("git", ["show", `${baselineRef}:${path}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  ]),
);
const entries = {
  "/__c504": "/test-support/c504-fixture.tsx",
  "/__skeleton": "/test-support/page-skeleton-fixture.tsx",
};
const serve = (before) =>
  createServer({
    root: webRoot,
    logLevel: "error",
    cacheDir: resolve(
      webRoot,
      `node_modules/.vite-c504-${before ? "before" : "after"}`,
    ),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "c504-evidence",
        enforce: "pre",
        load(id) {
          return before ? baselineFiles.get(id.split("?")[0]) : undefined;
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = req.url?.split("?")[0] ?? "";
            const entry = entries[path];
            if (!entry) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                path,
                `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
  });

const measureExecution = `(() => {
  const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) }; };
  const font = e => { const s = getComputedStyle(e); return { fontSize: s.fontSize, lineHeight: s.lineHeight }; };
  const items = [...document.querySelectorAll('.execution-table tbody tr, .execution-card')];
  return {
    pageScrollWidth: document.documentElement.scrollWidth,
    innerWidth,
    tableScroll: (() => { const s = document.querySelector('.execution-table-scroll'); return s ? { scrollWidth: s.scrollWidth, clientWidth: s.clientWidth } : null; })(),
    items: items.map(item => {
      const text = item.querySelector('.execution-context');
      const track = item.querySelector('meter');
      const cell = item.querySelector('td[data-column=context]');
      return {
        assignment: item.querySelector('.execution-open')?.textContent,
        height: box(item).height,
        context: text?.textContent,
        level: text?.getAttribute('data-level'),
        textBox: box(text),
        textFont: text && font(text),
        cellBox: box(cell),
        meter: track ? {
          label: track.getAttribute('aria-label'),
          value: track.value,
          value_text: box(track.parentElement),
          track: box(track),
          trackColor: getComputedStyle(track).backgroundColor,
          barColor: getComputedStyle(track.parentElement).getPropertyValue('--ui-meter-color'),
          tone: track.parentElement.getAttribute('data-tone'),
          gapAboveTrack: +(track.getBoundingClientRect().top - track.parentElement.getBoundingClientRect().bottom).toFixed(2),
        } : null,
      };
    }),
  };
})()`;
const measureCards = `(() => {
  const box = e => { const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) }; };
  const cell = document.querySelector('.card-table tbody td');
  const head = document.querySelector('.card-table thead th');
  const s = e => { const c = getComputedStyle(e); return { fontSize: c.fontSize, lineHeight: c.lineHeight }; };
  return {
    pageScrollWidth: document.documentElement.scrollWidth, innerWidth,
    cell: cell && { ...s(cell), padding: getComputedStyle(cell).padding },
    head: head && { ...s(head), height: box(head).height },
    rows: [...document.querySelectorAll('.card-table tbody tr')].map(r => box(r).height),
  };
})()`;

const report = {
  fixture:
    "C-314 synthetic 8 Assignments / 4 Runs (context 68.75% normal, 82% handoff, 90% restart, one Run without reading); page-skeleton 7 cards. No production data.",
  baselineRef,
  head: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim(),
  dirty:
    execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim() !== "",
  dpr: 1,
  cases: {},
};
const shots = {};
let browser;
const servers = [];
try {
  browser = await chromium({
    args: ["--force-color-profile=srgb", "--disable-gpu"],
  });
  const { send, evaluate } = browser;
  report.browser = (await send("Browser.getVersion")).product;
  const until = async (expression) => {
    const deadline = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < deadline, expression);
      await delay(50);
    }
  };
  const settle = async () => {
    await evaluate("document.fonts.ready.then(() => true)");
    await evaluate(
      "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))",
    );
    await delay(150);
  };
  const shoot = async (name, width, height) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    shots[name] = data;
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
  for (const phase of ["before", "after"]) {
    const server = await serve(phase === "before");
    servers.push(server);
    await server.listen();
    const base = server.resolvedUrls.local[0];
    for (const width of [1440, 390]) {
      const height = 900;
      for (const theme of ["light", "dark"]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: width === 390,
        });
        await send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-color-scheme", value: theme },
            { name: "prefers-reduced-motion", value: "reduce" },
          ],
        });
        for (const mode of ["table", "cards"]) {
          await send("Page.navigate", {
            url: `${base}__c504?mode=${mode}#/p/p-1/execution?view=all`,
          });
          await until(
            mode === "cards"
              ? "Boolean(document.querySelector('.execution-lanes .execution-card'))"
              : "Boolean(document.querySelector('.execution-table tbody tr, .execution-cards .execution-card'))",
          );
          await settle();
          const name = `execution-${mode === "table" ? "list" : "cards"}-${width}-${theme}-${phase}`;
          report.cases[name] = await evaluate(measureExecution);
          await shoot(name, width, height);
        }
        if (phase === "after") {
          await send("Page.navigate", {
            url: `${base}__skeleton#/p/p-1/cards?view=list`,
          });
          await until(
            "Boolean(document.querySelector('.card-table tbody tr'))",
          );
          await settle();
          const name = `cards-page-list-${width}-${theme}`;
          report.cases[name] = await evaluate(measureCards);
          await shoot(name, width, height);
        }
      }
    }
  }
  // Screenshot pixels down the middle of each fill, two rows above to two
  // rows below the track, so the filled height is read from the image.
  await send("Page.navigate", { url: "about:blank" });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const name = `execution-list-${width}-${theme}-after`;
      const meters = report.cases[name].items
        .filter((i) => i.meter)
        .map((i) => ({
          assignment: i.assignment,
          x: Math.floor(
            i.meter.track.x + (i.meter.track.width * i.meter.value) / 200,
          ),
          emptyX: Math.floor(i.meter.track.x + i.meter.track.width - 3),
          y: Math.round(i.meter.track.y),
          height: i.meter.track.height,
        }));
      report.cases[name].fillRows = await evaluate(`(async () => {
        const image = new Image();
        image.src = 'data:image/png;base64,${shots[name]}';
        await image.decode();
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const hex = (x, y) => '#' + [...context.getImageData(x, y, 1, 1).data.slice(0, 3)].map(v => v.toString(16).padStart(2, '0')).join('');
        return ${JSON.stringify(meters)}.filter(m => m.y + m.height + 2 < image.height).map(m => ({
          ...m,
          rows: Array.from({ length: m.height + 4 }, (_, i) => ({ y: m.y - 2 + i, color: hex(m.x, m.y - 2 + i), empty: hex(m.emptyX, m.y - 2 + i) })),
        }));
      })()`);
      for (const meter of report.cases[name].fillRows) {
        const fill = meter.rows.slice(2, 2 + meter.height);
        const outside = [...meter.rows.slice(0, 2), ...meter.rows.slice(-2)];
        assert(
          fill.every(
            (r) => r.color === fill[0].color && r.empty === fill[0].empty,
          ) &&
            fill[0].color !== fill[0].empty &&
            outside.every(
              (r) => r.color !== fill[0].color && r.color !== fill[0].empty,
            ),
          `${name} ${meter.assignment}: fill and track cover all ${meter.height} rows`,
        );
      }
    }
  // Side-by-side sheets: before | after, and execution list | card page list.
  const pair = async (name, left, right, width) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width: width * 2 + 16,
      height: 900 + 28,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: "about:blank" });
    await evaluate(`(() => {
      document.body.style.cssText = 'margin:0;display:flex;gap:16px;background:#888;font:12px monospace;color:#fff';
      for (const [label, data] of ${JSON.stringify([
        [left, shots[left]],
        [right, shots[right]],
      ])}) {
        const figure = document.createElement('div');
        figure.innerHTML = '<div style="height:28px;line-height:28px;padding-left:4px">' + label + '</div>';
        const img = new Image(); img.src = 'data:image/png;base64,' + data; img.style.display = 'block';
        figure.append(img); document.body.append(figure);
      }
      return Promise.all([...document.images].map(i => i.decode())).then(() => true);
    })()`);
    await shoot(name, width * 2 + 16, 900 + 28);
  };
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await pair(
        `compare-list-${width}-${theme}`,
        `execution-list-${width}-${theme}-before`,
        `execution-list-${width}-${theme}-after`,
        width,
      );
      await pair(
        `compare-cards-${width}-${theme}`,
        `execution-cards-${width}-${theme}-before`,
        `execution-cards-${width}-${theme}-after`,
        width,
      );
      await pair(
        `baseline-pair-${width}-${theme}`,
        `execution-list-${width}-${theme}-after`,
        `cards-page-list-${width}-${theme}`,
        width,
      );
    }
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const cards = (phase) =>
        report.cases[`execution-cards-${width}-${theme}-${phase}`];
      assert.equal(
        cards("after").items.filter((i) => i.meter).length,
        0,
        "card mode has no meter",
      );
      const after = report.cases[`execution-list-${width}-${theme}-after`];
      assert.equal(after.pageScrollWidth, after.innerWidth, "no page overflow");
    }
  report.screenshotSha256 = Object.fromEntries(
    await Promise.all(
      Object.keys(shots).map(async (name) => [
        name,
        execFileSync("shasum", ["-a", "256", resolve(output, `${name}.png`)], {
          encoding: "utf8",
        }).split(" ")[0],
      ]),
    ),
  );
  await writeFile(
    resolve(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(output);
} finally {
  await browser?.close();
  for (const server of servers) await server.close();
}
