import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-242: full-width pages. Local fixture only; no business server or real data.
// Captures the board, card detail, Needs You and execution view (plus the
// slow card-list hint) before/after, at 1440, 1920, 2560 and 390 in both
// themes. "before" swaps in the baseline stylesheet on the same DOM.
const output = process.argv[2];
assert(output, "Pass a screenshot output directory");
await mkdir(output, { recursive: true });
const root = fileURLToPath(new URL("../", import.meta.url));
const css = await readFile(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);
const baseline = execFileSync(
  "git",
  [
    "show",
    `${process.env.FULL_WIDTH_BASELINE_REF ?? "origin/main"}:apps/web/src/styles.css`,
  ],
  { cwd: root, encoding: "utf8" },
);
const server = await createServer({
  root,
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "full-width-entry",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__wide")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/__wide",
              `<!doctype html>
          <html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
          <body><div id="root"></div><script type="module" src="/test-support/responsive-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const pages = [
  [
    "board",
    "wideBoard",
    "cards?view=board",
    ".cards-page-board .board-column-title",
  ],
  ["card", "", "cards/C-1", ".timeline-load"],
  ["needs-you", "", "needs-you", ".needs-item"],
  ["execution", "", "execution?view=all", ".execution-row, .execution-card"],
  ["loading", "pendingCards", "cards?view=board", ".request-feedback span"],
];
const measurements = [];
let browser;
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium();
  const { send, evaluate } = browser;
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  async function until(expression) {
    const deadline = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < deadline, `Timed out: ${expression}`);
      await delay(40);
    }
  }
  for (const width of [1440, 1920, 2560, 390]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: width === 390 ? 844 : 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      for (const [name, query, route, ready] of pages) {
        await send("Page.navigate", {
          url: `${origin}__wide?${query}#/p/p-1/${route}`,
        });
        await until(
          `Boolean(document.querySelector(${JSON.stringify(ready)}))`,
        );
        await evaluate("document.fonts.ready.then(() => true)");
        for (const [state, sheet] of [
          ["before", baseline],
          ["after", css],
        ]) {
          const measured = await run(async (sheet) => {
            document.querySelector(
              'style[data-vite-dev-id$="/src/styles.css"]',
            ).textContent = sheet;
            window.scrollTo({ top: 0, left: 0, behavior: "instant" });
            await new Promise((done) =>
              requestAnimationFrame(() => requestAnimationFrame(done)),
            );
            const box = (selector) => {
              const el = document.querySelector(selector);
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return {
                x: Math.round(r.x),
                right: Math.round(r.right),
                y: Math.round(r.y),
                width: Math.round(r.width),
              };
            };
            const board = document.querySelector(".board");
            return {
              scrollWidth: document.documentElement.scrollWidth,
              content: box(".content"),
              // Right edge of the widest visible page block inside .content.
              pageRight: Math.round(
                Math.max(
                  ...Array.from(
                    document.querySelectorAll(".content > *"),
                    (el) => el.getBoundingClientRect().right,
                  ),
                ),
              ),
              title: box(".page-title"),
              main: box(".card-main"),
              sidebar: box(".card-sidebar"),
              feedback: box(".request-feedback:not(:empty)"),
              board: board && {
                clientWidth: board.clientWidth,
                scrollWidth: board.scrollWidth,
              },
            };
          }, sheet);
          measurements.push({ name, width, theme, state, ...measured });
          if (state === "after" && width > 760 && name !== "loading")
            assert(
              width - measured.pageRight <= 32,
              `${name} ${width} ${theme}: page stops ${width - measured.pageRight}px short`,
            );
          if (state === "after" && name === "board" && width === 2560)
            assert(
              measured.board.scrollWidth <= measured.board.clientWidth,
              "board 2560: four lanes should fit without scrolling",
            );
          if (state === "after")
            assert.equal(
              measured.scrollWidth,
              width,
              `${name} ${width} ${theme}: horizontal overflow`,
            );
          const { data } = await send("Page.captureScreenshot", {
            format: "png",
          });
          await writeFile(
            resolve(output, `${name}-${width}-${theme}-${state}.png`),
            Buffer.from(data, "base64"),
          );
        }
        console.log(`PASS ${name} ${width} ${theme}`);
      }
    }
  }
  assert.deepEqual(browser.errors, [], "Browser runtime errors");
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
