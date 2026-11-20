import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-534 (C-517) evidence: Markdown tables in the card page and the card drawer, plus
// the card list (reference page) at the same width and theme. Synthetic
// fixture only; records measurements without asserting the new styles so the
// same script runs on the baseline commit.
const output = resolve(process.argv[2]);
await mkdir(output); // Never replace existing evidence.
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
const dirty = git("status", "--porcelain");
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "c534-fixture",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c534")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__c534",
              '<!doctype html><html lang="zh-CN"><head><title>Markdown 表格</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c534-fixture.tsx"></script></body></html>',
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
  const cell = (el) => { const s = getComputedStyle(el); return { text: el.textContent.trim().slice(0, 12), fontSize: s.fontSize, lineHeight: s.lineHeight, fontWeight: s.fontWeight, padding: s.padding, textAlign: s.textAlign, verticalAlign: s.verticalAlign, background: s.backgroundColor, color: s.color, borderBottom: s.borderBottomWidth + ' ' + s.borderBottomStyle + ' ' + s.borderBottomColor, ...box(el) }; };
  const tables = Array.from(document.querySelectorAll(':is(.markdown, .help-markdown) table')).filter((t) => !t.closest('[hidden]')).map((table) => {
    const scroller = table.parentElement;
    const where = table.closest('.timeline-entry')?.id || (table.closest('.card-purpose') ? 'goal' : 'other');
    const head = Array.from(table.querySelectorAll('th')).map(cell);
    const firstRow = Array.from(table.querySelectorAll('tbody tr:first-child td')).map(cell);
    let badge = null;
    for (const tag of table.querySelectorAll('td .id-tag')) {
      const description = tag.querySelector('.id-description');
      const td = tag.closest('td');
      const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
      let text = null;
      while (walker.nextNode()) if (!tag.contains(walker.currentNode) && walker.currentNode.textContent.trim()) { text = walker.currentNode; break; }
      if (!description || !text) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      const rects = Array.from(range.getClientRects());
      const d = description.getBoundingClientRect();
      const peer = rects.find((r) => Math.abs(r.top - d.top) < 12) || rects[0];
      badge = { tag: box(tag), badge: box(tag.querySelector('.id-badge')), descriptionBottom: px(d.bottom), textBottom: px(peer.bottom), baselineDelta: px(d.bottom - peer.bottom), tagMinHeight: getComputedStyle(tag).minHeight, verticalAlign: getComputedStyle(tag).verticalAlign };
      break;
    }
    return { where, scroller: { className: scroller.className, overflowX: getComputedStyle(scroller).overflowX, clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth, ...box(scroller) }, table: box(table), head, firstRow, badge };
  });
  const drawer = document.querySelector('[role="dialog"]');
  return { viewport: { width: innerWidth, height: innerHeight }, document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }, drawer: drawer ? { clientWidth: drawer.clientWidth, scrollWidth: drawer.scrollWidth } : null, goalHtmlTable: !!document.querySelector('.card-purpose table'), tables };
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
  const version = (await send("Browser.getVersion")).product;
  const until = async (expression) => {
    const end = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(40);
    }
  };
  const shoot = async (name) => {
    await delay(150);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
      {
        flag: "wx",
      },
    );
  };
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
      const base = server.resolvedUrls.local[0];
      await send("Page.navigate", {
        url: `${base}__c534?case=list-${theme}-${width}#/p/p-1/cards?view=list`,
      });
      await until(
        "document.readyState === 'complete' && !!document.querySelector('table')",
      );
      await evaluate("document.fonts.ready");
      await shoot(`reference-list-${width}-${theme}`);
      for (const mode of ["page", "drawer"]) {
        const hash =
          mode === "drawer"
            ? "#/p/p-1/cards?view=list&card=C-1"
            : "#/p/p-1/cards/C-1";
        const name = `${mode}-${width}-${theme}`;
        await send("Page.navigate", {
          url: `${base}__c534?case=${name}${hash}`,
        });
        await until("Boolean(document.querySelector('.card-purpose'))");
        await evaluate("document.fonts.ready");
        await evaluate(
          "document.querySelector('.card-purpose').scrollIntoView({block:'start'})",
        );
        const overview = await evaluate(measure);
        await shoot(`${name}-goal`);
        await evaluate(
          "document.getElementById('card-C-1-timeline-tab').click()",
        );
        await until(
          "!!document.getElementById('entry-C-1#1') && !document.getElementById('entry-C-1#1').closest('[hidden]')",
        );
        await evaluate(`(() => {
          for (const button of document.querySelectorAll('.timeline-entry button')) if (button.textContent.trim() === '展开全文') button.click();
        })()`);
        await delay(100);
        await evaluate(
          "document.getElementById('entry-C-1#1').scrollIntoView({block:'start'})",
        );
        const timeline = await evaluate(measure);
        await shoot(`${name}-timeline`);
        records.push({ name, overview, timeline });
      }
      const help = `help-${width}-${theme}`;
      await send("Page.navigate", { url: `${base}__c534?help&case=${help}` });
      await until("Boolean(document.querySelector('.help-markdown table'))");
      await evaluate("document.fonts.ready");
      records.push({ name: help, help: await evaluate(measure) });
      await shoot(help);
    }
  }
  assert.equal(browser.errors.length, 0, "browser exceptions");
  await writeFile(
    resolve(output, "measurements.json"),
    JSON.stringify(
      {
        sha,
        tree,
        dirty,
        browser: version,
        dpr: 1,
        fonts:
          "@fontsource-variable/inter, noto-sans-sc, jetbrains-mono (lockfile)",
        fixture:
          "apps/web/test-support/c534-fixture.tsx: one synthetic card, three Markdown tables (user screenshot copy, alignment syntax, 10 columns); no production data or backend",
        records,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(`${records.length} C-534 cases captured: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
