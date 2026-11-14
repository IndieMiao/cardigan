import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

// C-259: same local App fixture and DOM, baseline/current product CSS.
// No business server or real data; Playwright is supplied outside the repo.
const { chromium, firefox } = await import(
  pathToFileURL(process.env.C259_PLAYWRIGHT_MODULE)
);
const output = process.env.C259_SCREENSHOTS;
assert(output, "Set C259_SCREENSHOTS to an evidence directory");
await mkdir(output, { recursive: true });
const config = await mkdtemp(join(tmpdir(), "c259-browser-"));
const root = fileURLToPath(new URL("../", import.meta.url));
const css = await readFile(join(root, "src/styles.css"), "utf8");
const baseline = execFileSync(
  "git",
  [
    "show",
    `${process.env.C259_BASELINE_REF ?? "2a1584bff49bae2e0fcb027186038ea3988cbabe"}:apps/web/src/styles.css`,
  ],
  { cwd: root, encoding: "utf8" },
);
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const records = [];
try {
  for (const engine of (process.env.C259_ENGINES ?? "chromium,firefox").split(
    ",",
  )) {
    const browser = await { chromium, firefox }[engine].launch({
      headless: process.env.C259_HEADED !== "1",
      ...(engine === "chromium"
        ? {
            executablePath: process.env.CHROMIUM_PATH,
            ignoreDefaultArgs: ["--hide-scrollbars"],
          }
        : {
            firefoxUserPrefs: {
              "widget.gtk.overlay-scrollbars.enabled": false,
            },
          }),
      env: { ...process.env, XDG_CONFIG_HOME: config },
    });
    try {
      for (const width of [1440, 390])
        for (const colorScheme of ["light", "dark"]) {
          const page = await browser.newPage({
            viewport: { width, height: width === 390 ? 844 : 1000 },
            colorScheme,
          });
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(
            `${server.resolvedUrls.local[0]}test-support/c210-board.html?product=1`,
          );
          await page.locator(".board-card").first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          const stem = `${engine}-${width}-${colorScheme}`;
          for (const [version, sheet] of [
            ["before", baseline],
            ["after", css],
          ]) {
            const dimensions = await page.evaluate(async (sheet) => {
              document.querySelector(
                'style[data-vite-dev-id$="/src/styles.css"]',
              ).textContent = sheet;
              await new Promise((done) =>
                requestAnimationFrame(() => requestAnimationFrame(done)),
              );
              const board = document.querySelector(".board");
              const lane = document.querySelector(
                ".board-column:not(.board-column-collapsed)",
              );
              const cards = lane.querySelector(".board-lane-cards");
              const card = lane.querySelector(".board-card");
              return {
                pageWidth: document.documentElement.clientWidth,
                pageScrollWidth: document.documentElement.scrollWidth,
                boardWidth: board.clientWidth,
                columnWidth: lane.getBoundingClientRect().width,
                cardWidth: card.getBoundingClientRect().width,
                gutter: cards.offsetWidth - cards.clientWidth,
                verticalScrollbar: getComputedStyle(cards).scrollbarWidth,
                horizontalScrollbar: getComputedStyle(board).scrollbarWidth,
                gap: getComputedStyle(board).gap,
              };
            }, sheet);
            if (version === "after") {
              assert.equal(dimensions.pageWidth, dimensions.pageScrollWidth);
              assert.equal(dimensions.gutter, 0);
              assert.equal(dimensions.verticalScrollbar, "none");
              assert.notEqual(
                dimensions.horizontalScrollbar,
                "none",
                JSON.stringify({ engine, width, colorScheme, ...dimensions }),
              );
              assert.equal(dimensions.gap, "16px");
              assert.equal(
                dimensions.columnWidth,
                width === 390 ? dimensions.boardWidth - 64 : 334,
              );
              assert.equal(dimensions.cardWidth, dimensions.columnWidth - 8);
            }
            await page.screenshot({
              path: join(output, `${stem}-${version}.png`),
            });
            records.push({
              engine,
              width,
              colorScheme,
              version,
              ...dimensions,
            });
          }
          // Use the inter-column gap, or the lane's side padding on mobile.
          const point = await page.evaluate((width) => {
            const lane = document
              .querySelector(".board-column:not(.board-column-collapsed)")
              .getBoundingClientRect();
            return width === 390
              ? { x: lane.right - 2, y: lane.top + 100 }
              : { x: lane.right + 8, y: lane.top + 100 };
          }, width);
          const board = page.locator(".board");
          const scroll = () => board.evaluate((el) => el.scrollLeft);
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
          assert.equal(
            await board.evaluate((el) => getComputedStyle(el).cursor),
            "grab",
          );
          await page.mouse.move(point.x - 4, point.y);
          assert.equal(await scroll(), 0);
          await page.mouse.move(point.x - 180, point.y, { steps: 12 });
          assert.equal(await scroll(), 180);
          assert.equal(
            await board.evaluate((el) => getComputedStyle(el).cursor),
            "grabbing",
          );
          await page.mouse.up();
          await page.mouse.move(point.x - 220, point.y);
          assert.equal(await scroll(), 180);
          assert.equal(await page.locator('[role="dialog"]').count(), 0);
          await page.screenshot({
            path: join(output, `${stem}-after-drag.png`),
          });
          const lane = page.locator(".board-lane-cards:not([hidden])").first();
          // Hidden bars still permit keyboard and wheel scrolling.
          await lane.focus();
          await page.keyboard.press("ArrowDown");
          await page.waitForFunction(
            () =>
              document.querySelector(".board-lane-cards:not([hidden])")
                .scrollTop > 0,
          );
          // Let the key's native smooth scroll finish before checking wheel
          // movement, so the key animation cannot satisfy the wheel assertion.
          await page.waitForTimeout(300);
          const keyboardScroll = await lane.evaluate((el) => el.scrollTop);
          const bounds = await lane.boundingBox();
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
          await page.mouse.wheel(0, 200);
          await page.waitForFunction(
            (previous) =>
              document.querySelector(".board-lane-cards:not([hidden])")
                .scrollTop >
              previous + 100,
            keyboardScroll,
          );
          const wheelScroll = await lane.evaluate((el) => el.scrollTop);
          const previous = await scroll();
          // Exercise native horizontal scrolling over board whitespace. Firefox
          // may keep a wheel gesture over a vertical lane latched to that lane.
          const gap = await page.evaluate(() => {
            const board = document
              .querySelector(".board")
              .getBoundingClientRect();
            const lane = document
              .querySelector(".board-column:not(.board-column-collapsed)")
              .getBoundingClientRect();
            return {
              x: Math.min(lane.right + 8, board.right - 2),
              y: lane.top + 100,
            };
          });
          await page.mouse.move(gap.x, gap.y);
          await page.mouse.wheel(120, 0);
          await page.waitForFunction(
            (previous) =>
              document.querySelector(".board").scrollLeft > previous,
            previous,
          );
          records.push({
            engine,
            width,
            colorScheme,
            version: "interactions",
            dragScroll: 180,
            keyboardScroll,
            wheelScroll,
            horizontalWheelScroll: await scroll(),
          });
          assert.deepEqual(errors, []);
          await page.close();
          console.log(`PASS ${engine} ${width} ${colorScheme}`);
        }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
  await rm(config, { recursive: true, force: true });
}
await writeFile(
  join(output, "measurements.json"),
  `${JSON.stringify(records, null, 2)}\n`,
);
