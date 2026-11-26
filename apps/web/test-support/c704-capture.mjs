// C-704 evidence: execution view list/cards before and after the Chinese
// field names (C-687 §2.1), and the card page list at the same width/theme.
// Synthetic fixtures only (C-314 execution data, page-skeleton cards).
// Usage: CHROMIUM_PATH=... C704_BASELINE_REF=<sha> \
//   node test-support/c704-capture.mjs <output-dir>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = resolve(process.argv[2] ?? "c704-evidence");
const baselineRef = process.env.C704_BASELINE_REF;
assert(baselineRef, "Set C704_BASELINE_REF to the clean baseline commit");
await mkdir(output, { recursive: true });
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = resolve(webRoot, "../..");
const baselineFiles = new Map(
  [
    "apps/web/src/components/ExecutionContent.tsx",
    "apps/web/src/views/ExecutionPage.tsx",
  ].map((path) => [
    resolve(repoRoot, path),
    execFileSync("git", ["show", `${baselineRef}:${path}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  ]),
);
const entries = {
  "/__c704": "/test-support/c704-fixture.tsx",
  "/__skeleton": "/test-support/page-skeleton-fixture.tsx",
};
const serve = (before) =>
  createServer({
    root: webRoot,
    logLevel: "error",
    cacheDir: resolve(
      webRoot,
      `node_modules/.vite-c704-${before ? "before" : "after"}`,
    ),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "c704-evidence",
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

// Open every folded "运行配置与最近执行" so the config and missing-Run lines
// are on screen in both card layouts.
const expand = `(() => {
  for (const d of document.querySelectorAll('details.execution-card-config')) d.open = true;
  for (const b of document.querySelectorAll('.execution-card-more[aria-expanded=false]')) b.click();
  return true;
})()`;
const ENGLISH =
  /\b(Run|Runs|Harness|effort|Assignment|Session|Worktree|ACK|seq)\b/;
const measureExecution = `(() => {
  const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) }; };
  const font = e => { if (!e) return null; const s = getComputedStyle(e); return { fontSize: s.fontSize, lineHeight: s.lineHeight, color: s.color }; };
  const page = document.querySelector('.execution-page');
  const english = ${ENGLISH};
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  const englishText = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (english.test(n.textContent) && n.parentElement.checkVisibility()) englishText.push(n.textContent.trim());
  const englishLabels = [...page.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(t => english.test(t));
  const configs = [...page.querySelectorAll('td.execution-config, .execution-card-config-line')].filter(e => e.checkVisibility());
  return {
    pageScrollWidth: document.documentElement.scrollWidth,
    innerWidth,
    tableScroll: (() => { const s = document.querySelector('.execution-table-scroll'); return s ? { scrollWidth: s.scrollWidth, clientWidth: s.clientWidth } : null; })(),
    headers: [...page.querySelectorAll('.execution-table thead th')].map(th => ({ text: th.textContent.trim(), ...box(th), ...font(th) })),
    listLabel: page.querySelector('ul.execution-cards')?.getAttribute('aria-label') ?? null,
    configs: configs.map(e => ({ text: e.textContent.trim(), box: box(e), font: font(e) })),
    rowHeights: [...page.querySelectorAll('.execution-table tbody tr, .execution-card')].map(r => box(r).height),
    englishText,
    englishLabels,
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
    rows: [...document.querySelectorAll('.card-table tbody tr, .card-tile')].map(r => box(r).height),
  };
})()`;

const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const report = {
  fixture:
    "C-314 synthetic 8 Assignments / 4 Runs (claude opus-5.5 xhigh, codex gpt-5.5 high, pi deepseek-v4 no effort, claude sonnet-5.5 medium); 4 Assignments without a Run; page-skeleton cards. No production data.",
  baselineRef,
  head: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain") !== "",
  dpr: 1,
  viewportHeight: 900,
  fonts: "Inter / Noto Sans SC / JetBrains Mono variable (fontsource)",
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
            url: `${base}__c704?mode=${mode}#/p/p-1/execution?view=all`,
          });
          await until(
            mode === "cards"
              ? "Boolean(document.querySelector('.execution-lanes .execution-card'))"
              : "Boolean(document.querySelector('.execution-table tbody tr, .execution-cards .execution-card'))",
          );
          await evaluate(expand);
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
            "Boolean(document.querySelector('.card-table tbody tr, .card-tile'))",
          );
          await settle();
          const name = `cards-page-list-${width}-${theme}`;
          report.cases[name] = await evaluate(measureCards);
          await shoot(name, width, height);
        }
      }
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
      for (const mode of ["list", "cards"])
        await pair(
          `compare-${mode}-${width}-${theme}`,
          `execution-${mode}-${width}-${theme}-before`,
          `execution-${mode}-${width}-${theme}-after`,
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
    for (const theme of ["light", "dark"])
      for (const mode of ["list", "cards"]) {
        const after = report.cases[`execution-${mode}-${width}-${theme}-after`];
        assert.equal(after.pageScrollWidth, after.innerWidth, "no overflow");
        assert.deepEqual(after.englishText, [], `${mode} ${width} ${theme}`);
        assert.deepEqual(after.englishLabels, [], `${mode} ${width} ${theme}`);
        assert(after.configs.length > 0, "config lines on screen");
      }
  report.screenshotSha256 = Object.fromEntries(
    await Promise.all(
      Object.keys(shots).map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(resolve(output, `${name}.png`)))
          .digest("hex"),
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
